import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  allowedActionsFor,
  approveAndGenerate,
  canTakeOverSpeech,
  claimSpeech,
  endGenerateJob,
  GENERATE_ERRORS,
  generateJobKey,
  isGenerateJobStuck,
  newGenerateJob,
  newPlanJob,
  ProjectActionError,
  SPEECH_LOCK_STALE_MS,
  startGenerateAttempt,
  voiceLimitError,
  voiceLimitProblem,
  voiceStillNeeded,
  type GenerateJobContext,
  type JobDocument,
  type PlanVersionDocument,
  type ProjectDocument,
  type SpeechArtifactDocument,
  type StoredPlan,
} from "@bytereel/db";
import { StorageError, type StorageKey } from "@bytereel/storage";
import { createHash } from "node:crypto";
import { type Db, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { VIDEO_CONCURRENCY } from "../apps/web/inngest/client";
import { cardStatus, projectHref } from "../apps/web/lib/dashboard/cards";
import type { RenderRun } from "../apps/web/lib/video/render-process";
import { renderPhaseProgress, runGenerateJob, speechFailureCode, type FileStore, type GenerateJobStore } from "../apps/web/lib/video/run-generate-job";
import { videoSteps, waitingText } from "../apps/web/lib/video/steps";
import { voiceSetupFromEnv } from "../apps/web/lib/video/voice";
import type { RenderJobResult, RenderJobSpec } from "../packages/pipeline/src/pipeline/render-protocol";
import { ProviderError } from "../packages/pipeline/src/providers";
import { validPlan, withTempDir } from "./helpers";

// F23 "Generate the video": the limits and their order, the app-wide voice guard, the speech lock,
// the one-at-a-time queue and its stuck-job rule, the language switch, allowedActions, the state
// changes (an older video is kept), and the worker's steps (with fakes: no database, no network,
// no Remotion; the transactions and a real render + R2 upload are checked by tools/e2e/f23-generate.ts).

const OWNER = new ObjectId("67330c1a9f1e4b2a7c0d1e01");
const PROJECT = new ObjectId("67330d5e9f1e4b2a7c0d2a10");
const V1 = new ObjectId("67330e019f1e4b2a7c0d2b02");
const RENDER = new ObjectId("67330f109f1e4b2a7c0d6f01");
const NOW = new Date("2026-11-15T05:00:00.000Z");
const HASH = `sha256:${"a".repeat(64)}`;

function projectDoc(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    _id: PROJECT,
    ownerId: OWNER,
    schemaVersion: 1,
    title: "How the water cycle works",
    language: "en",
    voiceGender: "female",
    input: { type: "topic", text: "How the water cycle works", brainstormChoice: null },
    state: "storyboard_ready",
    currentPlanVersionId: V1,
    approvedPlanVersionId: null,
    currentRenderId: null,
    activeJobId: null,
    stateVersion: 4,
    planRequestCount: 1,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function versionDoc(): PlanVersionDocument {
  return { _id: V1, ownerId: OWNER, projectId: PROJECT, schemaVersion: 1, versionNumber: 1, parentVersionId: null, source: "ai_plan", plan: validPlan() as unknown as StoredPlan, planHash: HASH, validation: { valid: true, issues: [], warnings: [] }, stats: { sceneCount: 6, wordCount: 170, estimatedSeconds: 70 }, plannerUsage: null, createdAt: NOW } as PlanVersionDocument;
}

const generateJob = (overrides: Partial<JobDocument> = {}): JobDocument => ({ ...newGenerateJob({ ownerId: OWNER, projectId: PROJECT, version: { _id: V1, planHash: HASH }, now: NOW }), ...overrides });

/**
 * A database that answers each "collection.method" with the given handler and records every call.
 * A call without a handler throws: a test fails if the code reads or writes what it shouldn't.
 */
function fakeDb(handlers: Record<string, (...args: any[]) => unknown>) {
  const calls: { name: string; args: any[] }[] = [];
  const collection = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => (...args: any[]) => {
          const key = `${name}.${method}`;
          calls.push({ name: key, args });
          const handler = handlers[key];
          if (!handler) throw new Error(`unexpected ${key}`);
          const value = handler(...args);
          return method === "find" ? { toArray: async () => value, sort: () => ({ toArray: async () => value }) } : Promise.resolve(value);
        },
      },
    );
  const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: async () => undefined };
  const db = { client: { startSession: () => session }, collection } as unknown as Db;
  return { db, calls, names: () => calls.map((c) => c.name) };
}

const body = { planVersionId: V1.toHexString(), planHash: HASH, expectedStateVersion: 4 };
/** Every scene costs 100 characters. */
const voice = (plan: StoredPlan) => (plan.scenes as unknown[]).map((_s, i) => ({ cacheKey: `sha256:${String(i).repeat(64).slice(0, 64)}`, characters: 100 }));

async function refusal(promise: Promise<unknown>): Promise<ProjectActionError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProjectActionError);
  return error as ProjectActionError;
}

describe("D8 limits, in order: language → videos/day → voice characters (creator, then app)", () => {
  const base = (counts: { videos?: number; user?: number; app?: number; ready?: number } = {}, project = projectDoc()) =>
    fakeDb({
      "projects.findOne": () => project,
      "planVersions.findOne": () => versionDoc(),
      "jobs.findOne": () => null,
      "usageCounters.findOneAndUpdate": (_f: unknown, update: { $inc: { count: number } }) => ({ count: (counts.videos ?? 0) + update.$inc.count }),
      "speechArtifacts.find": () => Array.from({ length: counts.ready ?? 0 }, (_x, i) => ({ cacheKey: voice(versionDoc().plan)[i]!.cacheKey })),
      "usageCounters.findOne": (filter: { kind: string }) => ({ count: filter.kind === "voiceChars" ? (counts.user ?? 0) : (counts.app ?? 0) }),
    });

  it("a switched-off language is refused first: nothing read beyond the project, nothing counted", async () => {
    const { db, names } = base({}, projectDoc({ language: "hi" }));
    const error = await refusal(approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW }));
    expect(error.code).toBe("LANGUAGE_UNAVAILABLE");
    expect(names()).toEqual(["projects.findOne"]);
  });

  it("videos/day: the 4th new video of the day → 429 videos_per_day; the voice is not even looked at", async () => {
    const { db, names } = base({ videos: 3 });
    const error = await refusal(approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW }));
    expect(error.code).toBe("QUOTA_EXCEEDED");
    expect(error.details).toMatchObject({ quota: "videos_per_day", limit: 3, used: 3 });
    expect(names()).not.toContain("speechArtifacts.find");
  });

  it("the creator's 3,000 characters a month → 429 'Voice limit reached this month.'", async () => {
    const { db } = base({ user: 2500 });
    const error = await refusal(approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW }));
    expect(error).toMatchObject({ code: "QUOTA_EXCEEDED", message: "Voice limit reached this month." });
    expect(error.details).toMatchObject({ quota: "voice_characters_per_month", limit: 3000, used: 2500, needed: 600 });
  });

  it("the app-wide 9,000 a month → 503 SPEND_CEILING with the same plain message", async () => {
    const { db } = base({ app: 8500 });
    const error = await refusal(approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW }));
    expect(error).toMatchObject({ code: "SPEND_CEILING", message: "Voice limit reached this month." });
  });

  it("recordings the owner already has are free: the same counts pass when most scenes are recorded", async () => {
    const { db, calls } = fakeDb({
      "projects.findOne": () => projectDoc(),
      "planVersions.findOne": () => versionDoc(),
      "jobs.findOne": () => null,
      "usageCounters.findOneAndUpdate": () => ({ count: 1 }),
      "speechArtifacts.find": () => voice(versionDoc().plan).slice(0, 5).map((s) => ({ cacheKey: s.cacheKey })),
      "usageCounters.findOne": (filter: { kind: string }) => ({ count: filter.kind === "voiceChars" ? 2850 : 0 }),
      "storyboardApprovals.findOne": () => null,
      "storyboardApprovals.insertOne": () => ({}),
      "auditLogs.insertOne": () => ({}),
      "jobs.insertOne": () => ({}),
      "projects.findOneAndUpdate": (_f: unknown, update: { $set: Partial<ProjectDocument> }) => projectDoc({ ...update.$set, stateVersion: 5 }),
    });
    const out = await approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW });
    expect(out.kind).toBe("queued");
    expect(out.job).toMatchObject({ type: "generate", state: "queued", idempotencyKey: generateJobKey(V1), event: { id: generateJobKey(V1) } });
    expect(out.project).toMatchObject({ state: "generating", approvedPlanVersionId: V1, activeJobId: out.job._id });
    // An older video stays the project's video until the new one is ready.
    const move = calls.find((c) => c.name === "projects.findOneAndUpdate")!.args[1];
    expect(move.$set).not.toHaveProperty("currentRenderId");
  });

  it("an approval made in F20 (no job yet) is reused: no second approval row", async () => {
    const approval = { _id: new ObjectId(), ownerId: OWNER, projectId: PROJECT, planVersionId: V1, planHash: HASH, approvedBy: OWNER, approvedAt: NOW };
    const { db, names } = fakeDb({
      "projects.findOne": () => projectDoc({ approvedPlanVersionId: V1 }),
      "planVersions.findOne": () => versionDoc(),
      "jobs.findOne": () => null,
      "usageCounters.findOneAndUpdate": () => ({ count: 1 }),
      "speechArtifacts.find": () => [],
      "usageCounters.findOne": () => null,
      "storyboardApprovals.findOne": () => approval,
      "jobs.insertOne": () => ({}),
      "projects.findOneAndUpdate": (_f: unknown, update: { $set: Partial<ProjectDocument> }) => projectDoc({ ...update.$set }),
    });
    const out = await approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW });
    expect(out.approval._id).toEqual(approval._id);
    expect(names()).not.toContain("storyboardApprovals.insertOne");
  });

  it("a failed or cancelled job of this version is queued again (attempt + 1): no videos/day count", async () => {
    const failed = generateJob({ state: "cancelled", attempt: 2, voice: { cacheKeys: [voice(versionDoc().plan)[0]!.cacheKey], characters: 100 } });
    const { db, calls, names } = fakeDb({
      "projects.findOne": () => projectDoc({ approvedPlanVersionId: V1 }),
      "planVersions.findOne": () => versionDoc(),
      "jobs.findOne": () => failed,
      "speechArtifacts.find": () => [],
      "usageCounters.findOne": (filter: { kind: string }) => ({ count: filter.kind === "voiceChars" ? 2500 : 0 }),
      "storyboardApprovals.findOne": () => ({ _id: new ObjectId() }),
      "jobs.findOneAndUpdate": (_f: unknown, update: { $set: Partial<JobDocument> }) => ({ ...failed, ...update.$set }),
      "projects.findOneAndUpdate": (_f: unknown, update: { $set: Partial<ProjectDocument> }) => projectDoc({ ...update.$set }),
    });
    // 6 scenes × 100, one already reserved by this job: 500 more fits 2,500 + 500 = 3,000.
    const out = await approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW });
    expect(out.job).toMatchObject({ state: "queued", attempt: 3, event: { id: `${failed._id.toHexString()}:retry:3` } });
    expect(names()).not.toContain("usageCounters.findOneAndUpdate");
    expect(calls.filter((c) => c.name === "jobs.insertOne")).toHaveLength(0);
  });

  it("a version that already has a video: no job, no limits; the project points back to it (video_ready)", async () => {
    const done = generateJob({ state: "succeeded" });
    const { db, names } = fakeDb({
      "projects.findOne": () => projectDoc(),
      "planVersions.findOne": () => versionDoc(),
      "jobs.findOne": () => done,
      "renders.findOne": () => ({ _id: RENDER, planVersionId: V1 }),
      "storyboardApprovals.findOne": () => ({ _id: new ObjectId() }),
      "projects.findOneAndUpdate": (_f: unknown, update: { $set: Partial<ProjectDocument> }) => projectDoc({ ...update.$set }),
    });
    const out = await approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 200, body: {} }), now: NOW });
    expect(out.kind).toBe("reused");
    expect(out.project).toMatchObject({ state: "video_ready", currentRenderId: RENDER });
    expect(names().filter((n) => n.startsWith("usageCounters") || n.startsWith("speechArtifacts"))).toEqual([]);
  });

  it("a job that said the storyboard must change: 'Please change the storyboard first.'", async () => {
    const { db } = fakeDb({ "projects.findOne": () => projectDoc({ approvedPlanVersionId: V1 }), "planVersions.findOne": () => versionDoc(), "jobs.findOne": () => generateJob({ state: "needs_input" }) });
    expect((await refusal(approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "UTC", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW }))).code).toBe("INVALID_STATE");
  });
});

describe("the voice limits (pure)", () => {
  it("the creator's limit is checked before the app's; nothing to record never breaks a limit", () => {
    expect(voiceLimitProblem({ needed: 0, userUsed: 9999, appUsed: 9999 })).toBeNull();
    expect(voiceLimitProblem({ needed: 1000, userUsed: 2000, appUsed: 8000 })).toBeNull();
    expect(voiceLimitProblem({ needed: 1001, userUsed: 2000, appUsed: 0 })).toBe("user");
    expect(voiceLimitProblem({ needed: 1001, userUsed: 2000, appUsed: 9000 })).toBe("user");
    expect(voiceLimitProblem({ needed: 1001, userUsed: 0, appUsed: 8000 })).toBe("app");
  });

  it("the refusals say 'Voice limit reached this month.' with when it resets", () => {
    const user = voiceLimitError("user", { used: 2900, needed: 300, timezone: "Asia/Kolkata", now: NOW });
    expect(user).toMatchObject({ code: "QUOTA_EXCEEDED", message: "Voice limit reached this month.", details: { quota: "voice_characters_per_month", resetsAt: "2026-11-30T18:30:00.000Z" } });
    expect(voiceLimitError("app", { used: 9000, needed: 1, timezone: "Asia/Kolkata", now: NOW })).toMatchObject({ code: "SPEND_CEILING", details: { resetsAt: "2026-12-01T00:00:00.000Z" } });
    expect(GENERATE_ERRORS.QUOTA_EXCEEDED.message).toBe("Voice limit reached this month.");
    expect(GENERATE_ERRORS.SPEND_CEILING.message).toBe("Voice limit reached this month.");
  });

  it("still needed: one per distinct recording, minus those ready and those this job already reserved", async () => {
    const scenes = [
      { cacheKey: "sha256:a", characters: 100 },
      { cacheKey: "sha256:b", characters: 120 },
      { cacheKey: "sha256:a", characters: 100 },
      { cacheKey: "sha256:c", characters: 80 },
    ];
    const { db } = fakeDb({ "speechArtifacts.find": () => [{ cacheKey: "sha256:b" }] });
    expect(await voiceStillNeeded(db, { ownerId: OWNER, scenes, reserved: ["sha256:c"] })).toEqual({ items: [{ cacheKey: "sha256:a", characters: 100 }], characters: 100 });
  });
});

describe("the speech lock (speechArtifacts)", () => {
  const setup = { sceneId: "s1", firstProjectId: PROJECT, voiceId: "v", model: "m", settings: {}, audioKey: "a", alignmentKey: "b", normalizedAlignmentKey: "c", characters: 10 };
  const JOB = new ObjectId();
  const doc = (overrides: Partial<SpeechArtifactDocument>): SpeechArtifactDocument =>
    ({ _id: new ObjectId(), ownerId: OWNER, cacheKey: "sha256:k", status: "pending", claim: { jobId: new ObjectId(), attempt: 1, at: NOW }, updatedAt: NOW, response: null, ...overrides }) as SpeechArtifactDocument;

  it("is claimed with a conditional insert BEFORE any call", async () => {
    const mine = doc({ claim: { jobId: JOB, attempt: 1, at: NOW } });
    const { db, calls } = fakeDb({ "speechArtifacts.updateOne": () => ({ upsertedCount: 1 }), "speechArtifacts.findOne": () => mine });
    const claim = await claimSpeech(db, { ownerId: OWNER, cacheKey: "sha256:k", jobId: JOB, attempt: 1, setup, now: NOW });
    expect(claim.kind).toBe("claimed");
    const [filter, update, options] = calls[0]!.args;
    expect(filter).toEqual({ ownerId: OWNER, cacheKey: "sha256:k" });
    expect(update.$setOnInsert).toMatchObject({ status: "pending", claim: { jobId: JOB, attempt: 1 } });
    expect(options).toEqual({ upsert: true });
  });

  it("ready → reused; another job's fresh claim → busy (wait, no second payment)", async () => {
    const ready = fakeDb({ "speechArtifacts.updateOne": () => ({ upsertedCount: 0 }), "speechArtifacts.findOne": () => doc({ status: "ready", claim: null }) });
    expect((await claimSpeech(ready.db, { ownerId: OWNER, cacheKey: "sha256:k", jobId: JOB, attempt: 1, setup, now: NOW })).kind).toBe("ready");
    const busy = fakeDb({ "speechArtifacts.updateOne": () => ({ upsertedCount: 0 }), "speechArtifacts.findOne": () => doc({}) });
    expect((await claimSpeech(busy.db, { ownerId: OWNER, cacheKey: "sha256:k", jobId: JOB, attempt: 1, setup, now: NOW })).kind).toBe("busy");
  });

  it("taken over: a failed one, this same job's own claim (re-run or retry), or an abandoned claim", () => {
    const other = new ObjectId();
    expect(canTakeOverSpeech({ status: "failed", claim: null }, JOB, NOW)).toBe(true);
    expect(canTakeOverSpeech({ status: "pending", claim: { jobId: JOB, attempt: 1, at: NOW } }, JOB, NOW)).toBe(true);
    expect(canTakeOverSpeech({ status: "pending", claim: { jobId: other, attempt: 1, at: NOW } }, JOB, NOW)).toBe(false);
    expect(canTakeOverSpeech({ status: "pending", claim: { jobId: other, attempt: 1, at: new Date(NOW.getTime() - SPEECH_LOCK_STALE_MS) } }, JOB, NOW)).toBe(true);
    expect(canTakeOverSpeech({ status: "ready", claim: null }, JOB, NOW)).toBe(false);
  });
});

describe("one video at a time: the queue and its stuck-job rule", () => {
  const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000);
  it("Inngest runs ONE video step at a time across the app", () => {
    expect(VIDEO_CONCURRENCY).toEqual([{ scope: "env", key: '"video-render"', limit: 1 }]);
  });

  it("a video waiting behind others is never failed for waiting", () => {
    expect(isGenerateJobStuck({ state: "queued", queuedAt: minutes(40), updatedAt: minutes(40) }, minutes(1), NOW)).toBe(false);
    expect(isGenerateJobStuck({ state: "running", queuedAt: minutes(60), updatedAt: minutes(30) }, minutes(2), NOW)).toBe(false);
  });

  it("…but fails (retryable) when nothing in the whole queue moved for 15 minutes", () => {
    expect(isGenerateJobStuck({ state: "queued", queuedAt: minutes(16), updatedAt: minutes(16) }, null, NOW)).toBe(true);
    expect(isGenerateJobStuck({ state: "queued", queuedAt: minutes(40), updatedAt: minutes(40) }, minutes(15), NOW)).toBe(true);
    expect(isGenerateJobStuck({ state: "running", queuedAt: minutes(30), updatedAt: minutes(16) }, minutes(20), NOW)).toBe(true);
    expect(GENERATE_ERRORS.INTERNAL.retryable).toBe(true);
  });

  it("a ~4-minute render with progress updates is never stuck", () => {
    expect(isGenerateJobStuck({ state: "running", queuedAt: minutes(5), updatedAt: new Date(NOW.getTime() - 2000) }, null, NOW)).toBe(false);
    expect(isGenerateJobStuck({ state: "succeeded", queuedAt: minutes(99), updatedAt: minutes(99) }, null, NOW)).toBe(false);
  });

  it("'Waiting to start…' says how many videos are before this one", () => {
    expect(waitingText(0)).toBe("Waiting to start…");
    expect(waitingText(null)).toBe("Waiting to start…");
    expect(waitingText(1)).toBe("Waiting to start… 1 video is being made before yours.");
    expect(waitingText(3)).toBe("Waiting to start… 3 videos are being made before yours.");
  });
});

describe("allowedActions on the video step", () => {
  const failedVideo = generateJob({ state: "failed", error: { code: "RENDER_FAILED", message: "", retryable: true } });
  it("while the video job waits or runs: only Cancel (until Cancel was pressed); storyboard jobs: nothing", () => {
    const job = generateJob();
    expect(allowedActionsFor(projectDoc({ state: "generating", activeJobId: job._id }), null, null, { activeJob: job })).toEqual(["cancel_job"]);
    expect(allowedActionsFor(projectDoc({ state: "generating", activeJobId: job._id }), null, null, { activeJob: { ...job, cancelRequestedAt: NOW } })).toEqual([]);
    const plan = newPlanJob({ ownerId: OWNER, projectId: PROJECT, project: projectDoc(), now: NOW });
    expect(allowedActionsFor(projectDoc({ state: "planning", activeJobId: plan._id }), plan, null, { activeJob: plan })).toEqual([]);
  });

  it("approved without a job → Generate video; after 'change the storyboard' → not offered", () => {
    expect(allowedActionsFor(projectDoc({ approvedPlanVersionId: V1 }), null, null, { latestGenerateJob: generateJob({ state: "cancelled" }) })).toContain("generate_video");
    expect(allowedActionsFor(projectDoc({ approvedPlanVersionId: V1 }), null, null, { latestGenerateJob: generateJob({ state: "needs_input" }) })).not.toContain("generate_video");
    expect(allowedActionsFor(projectDoc(), null)).toContain("approve_storyboard");
  });

  it("a failed video → Try again while the version is still the approved one", () => {
    expect(allowedActionsFor(projectDoc({ state: "generate_failed", approvedPlanVersionId: V1 }), null, null, { latestGenerateJob: failedVideo })).toContain("retry_job");
    expect(allowedActionsFor(projectDoc({ state: "generate_failed", approvedPlanVersionId: V1 }), null, null, { latestGenerateJob: { ...failedVideo, error: { code: "PROVIDER_UNAVAILABLE", message: "", retryable: false } } })).not.toContain("retry_job");
  });

  it("language switch: no approve or generate for Hindi/Hinglish (approving starts the paid voice job)", () => {
    for (const language of ["hi", "hinglish"] as const) {
      const actions = allowedActionsFor(projectDoc({ language, approvedPlanVersionId: V1 }), null);
      expect(actions).not.toContain("generate_video");
      expect(allowedActionsFor(projectDoc({ language }), null)).not.toContain("approve_storyboard");
      expect(actions).toContain("edit_storyboard");
    }
  });
});

describe("the worker refuses a switched-off language before any voice call", () => {
  it("a queued job of a Hindi project ends LANGUAGE_UNAVAILABLE (not retryable) and nothing runs", async () => {
    const job = generateJob();
    const writes: any[] = [];
    const { db } = fakeDb({
      "jobs.findOne": () => job,
      "projects.findOne": () => projectDoc({ language: "hi", state: "generating", activeJobId: job._id, approvedPlanVersionId: V1 }),
      "jobs.updateOne": (_f: unknown, u: unknown) => void writes.push(u),
      "projects.updateOne": (_f: unknown, u: unknown) => void writes.push(u),
    });
    expect(await startGenerateAttempt(db, { jobId: job._id.toHexString(), attempt: 1, now: NOW })).toBeNull();
    expect(writes[0].$set).toMatchObject({ state: "failed", error: { code: "LANGUAGE_UNAVAILABLE", retryable: false } });
    expect(writes[1].$set).toMatchObject({ state: "generate_failed", activeJobId: null });
  });
});

describe("how a video job ends (the older video is always kept)", () => {
  const ending = async (outcome: "failed" | "needs_input" | "cancelled", extra: object = {}) => {
    const job = generateJob({ state: "running", stages: generateJob().stages.map((s, i) => ({ ...s, status: i < 3 ? (i === 2 ? "running" : "succeeded") : "pending" })) });
    const writes: { job?: any; project?: any } = {};
    const { db } = fakeDb({
      "jobs.findOne": () => job,
      "jobs.updateOne": (_f: unknown, u: unknown) => void (writes.job = u),
      "projects.updateOne": (_f: unknown, u: unknown) => void (writes.project = u),
    });
    expect(await endGenerateJob(db, { jobId: job._id, attempt: 1, outcome, ...extra, now: NOW })).toBe(true);
    expect(writes.project.$set).not.toHaveProperty("currentRenderId");
    expect(writes.project.$set.activeJobId).toBeNull();
    return writes;
  };

  it("failed → generate_failed with the plain error (Try again when retryable)", async () => {
    const w = await ending("failed", { code: "RENDER_FAILED" });
    expect(w.job.$set).toMatchObject({ state: "failed", error: { code: "RENDER_FAILED", message: "Rendering failed. Your narration is saved, so retrying is quick.", retryable: true } });
    expect(w.project.$set).toMatchObject({ state: "generate_failed", lastError: { code: "RENDER_FAILED" } });
  });

  it("needs_input → back to the storyboard with the reason (approval kept)", async () => {
    const w = await ending("needs_input", { needsInput: { reason: "duration_out_of_range", message: "Your narration runs about 97 seconds…", sceneId: null } });
    expect(w.job.$set).toMatchObject({ state: "needs_input", needsInput: { reason: "duration_out_of_range" } });
    expect(w.project.$set).toMatchObject({ state: "storyboard_ready", lastError: { code: "NEEDS_INPUT" } });
    expect(w.project.$set).not.toHaveProperty("approvedPlanVersionId");
  });

  it("cancelled → back to the storyboard, approval kept", async () => {
    const w = await ending("cancelled");
    expect(w.job.$set).toMatchObject({ state: "cancelled", error: { code: "CANCELLED", retryable: false } });
    expect(w.project.$set).toMatchObject({ state: "storyboard_ready", lastError: null });
  });
});

describe("Step 3 screen and My videos cards", () => {
  const job = (state: string, stages: Record<string, string>, message = "") => ({
    state,
    stages: ["approve", "speech", "compile", "render", "validate"].map((name) => ({ name, status: stages[name] ?? "pending" })),
    progress: { stage: "", percent: 0, message },
  });
  const statuses = (j: ReturnType<typeof job> | null) => videoSteps(j).map((s) => s.status).join(",");

  it("the four steps follow the job's stages (API.md §8.2 mapping)", () => {
    expect(statuses(null)).toBe("todo,todo,todo,todo");
    expect(statuses(job("queued", {}))).toBe("todo,todo,todo,todo");
    expect(statuses(job("running", { approve: "succeeded", speech: "running" }))).toBe("active,todo,todo,todo");
    expect(statuses(job("running", { approve: "succeeded", speech: "succeeded", compile: "running" }, "Timing animations…"))).toBe("done,active,todo,todo");
    expect(statuses(job("running", { approve: "succeeded", speech: "succeeded", compile: "running" }, "Adding captions…"))).toBe("done,done,active,todo");
    const rendering = videoSteps({ ...job("running", { approve: "succeeded", speech: "succeeded", compile: "succeeded", render: "running" }, "Rendering · 45%"), progress: { stage: "render", percent: 70, message: "Rendering · 45%" } });
    expect(rendering.map((s) => s.status).join()).toBe("done,done,done,active");
    expect(rendering[3]!.detail).toBe("Rendering · 45%");
    expect(statuses(job("failed", { approve: "succeeded", speech: "failed" }))).toBe("failed,todo,todo,todo");
    expect(statuses(job("failed", { approve: "succeeded", speech: "succeeded", compile: "succeeded", render: "failed" }))).toBe("done,done,done,failed");
    expect(statuses(job("succeeded", {}))).toBe("done,done,done,done");
  });

  it("render progress maps to the steps and stages", () => {
    expect(renderPhaseProgress("timing", 0)).toMatchObject({ stage: "compile", message: "Timing animations…" });
    expect(renderPhaseProgress("captions", 100)).toMatchObject({ stage: "compile", message: "Adding captions…" });
    expect(renderPhaseProgress("rendering", 40)).toMatchObject({ stage: "render", percent: 68, message: "Rendering · 40%", stages: { compile: "succeeded", render: "running" } });
    expect(renderPhaseProgress("checking", 0)).toMatchObject({ stage: "validate", message: "Checking the video…" });
  });

  it("cards: Waiting to start… / Making video… / Video ready; they open the video step", () => {
    expect(cardStatus({ state: "generating", activeJobType: "generate", storyboardApproved: true, activeJobState: "queued" }).label).toBe("Waiting to start…");
    expect(cardStatus({ state: "generating", activeJobType: "generate", storyboardApproved: true, activeJobState: "running" }).label).toBe("Making video…");
    expect(cardStatus({ state: "video_ready", activeJobType: null, storyboardApproved: true }).label).toBe("Video ready");
    expect(projectHref({ id: "p", state: "generating" })).toBe("/projects/p/video");
    expect(projectHref({ id: "p", state: "video_ready" })).toBe("/projects/p/video");
    expect(projectHref({ id: "p", state: "storyboard_ready" })).toBe("/projects/p/storyboard");
  });
});

// ---------- the worker, with fakes ----------

const sha = (data: Uint8Array | string) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

function fakeFiles(): FileStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    checkBucket: async () => undefined,
    put: async (key, data, options) => {
      const bytes = typeof data === "string" ? new Uint8Array(Buffer.from(data)) : data;
      if (options?.createOnly && objects.has(key)) throw new StorageError("put", "already_exists", 412);
      objects.set(key, bytes);
      return { key, sha256: sha(bytes), bytes: bytes.byteLength };
    },
    get: async (key) => objects.get(key) ?? null,
    head: async (key) => (objects.has(key) ? { bytes: objects.get(key)!.byteLength, contentType: null, sha256: sha(objects.get(key)!) } : null),
  };
}

type Events = string[];

function fakeStore(events: Events, options: { cancelAt?: "render" | "progress"; reserve?: "ok" | "quota" | "ceiling"; ready?: Map<string, SpeechArtifactDocument> } = {}) {
  const job = generateJob({ state: "running" });
  const project = projectDoc({ state: "generating", activeJobId: job._id, approvedPlanVersionId: V1 });
  const ctx: GenerateJobContext = { job, project, version: versionDoc() };
  const speech = options.ready ?? new Map<string, SpeechArtifactDocument>();
  let cancelRequested = false;
  const store: GenerateJobStore = {
    start: async () => (events.push("start"), ctx),
    load: async () => ({ ...ctx, job: { ...job, cancelRequestedAt: cancelRequested ? NOW : null } }),
    timezone: async () => "Asia/Kolkata",
    readySpeech: async (_o, keys) => keys.flatMap((k) => (speech.get(k)?.status === "ready" ? [speech.get(k)!] : [])),
    reserveVoice: async (input) => (events.push(`reserve:${input.extra ? "extra" : input.items.length}`), options.reserve ?? "ok"),
    claimSpeech: async (input) => {
      const existing = speech.get(input.cacheKey);
      if (existing?.status === "ready") return { kind: "ready", doc: existing };
      const doc = (existing ?? { _id: new ObjectId(), cacheKey: input.cacheKey, ...input.setup, status: "pending", response: null, audioSha256: null }) as SpeechArtifactDocument;
      speech.set(input.cacheKey, doc);
      events.push("claim");
      return { kind: "claimed", doc };
    },
    saveSpeechResponse: async (input) => {
      const doc = speech.get(input.cacheKey)!;
      doc.response = input.response;
      doc.audioSha256 = input.response.audioSha256;
      events.push("save-answer");
      return true;
    },
    markSpeechReady: async (input) => {
      speech.get(input.cacheKey)!.status = "ready";
      events.push("ready");
      return true;
    },
    markSpeechFailed: async (input) => void (speech.get(input.cacheKey)!.status = "failed", events.push("speech-failed")),
    progress: async () => {
      if (options.cancelAt === "progress") cancelRequested = true;
      return { cancelRequested };
    },
    beginRender: async () => (events.push("begin-render"), { cancelRequested: options.cancelAt === "render" }),
    complete: async (input) => (events.push(`complete:${input.render.keys.mp4.split("/").pop()}`), true),
    end: async (input) => (events.push(`end:${input.outcome}:${input.code ?? ""}`), true),
  };
  return { store, speech, ctx };
}

function voiceWith(provider: { calls: number; fail?: Error }) {
  const setup = voiceSetupFromEnv({ E2E_FAKE_ELEVENLABS: "1", MONGODB_DB: "bytereel_test", BETTER_AUTH_URL: "http://localhost:3232" });
  if (!setup.ok) throw new Error(setup.problem);
  return () => ({
    ...setup,
    provider: () => ({
      name: "test",
      synthesize: async (request: Parameters<ReturnType<typeof setup.provider>["synthesize"]>[0], options?: Parameters<ReturnType<typeof setup.provider>["synthesize"]>[1]) => {
        provider.calls++;
        await options?.beforeAttempt?.(1);
        if (provider.fail) throw provider.fail;
        return setup.provider("en").synthesize(request);
      },
    }),
  });
}

function fakeRenderer(events: Events, result: (spec: RenderJobSpec) => Promise<RenderJobResult>, seen: { spec?: RenderJobSpec; tmp?: string; cancelled?: boolean } = {}) {
  return (spec: RenderJobSpec, options: { tmp: string; onProgress: (phase: "rendering", percent: number) => void }): RenderRun => {
    seen.spec = spec;
    seen.tmp = options.tmp;
    events.push("render");
    options.onProgress("rendering", 10);
    return { result: result(spec), cancel: () => void ((seen.cancelled = true), events.push("render-cancel")) };
  };
}

async function readyResult(spec: RenderJobSpec): Promise<RenderJobResult> {
  const out = path.join(spec.workDir, "out");
  await mkdir(out, { recursive: true });
  const files = { video: path.join(out, "output.mp4"), thumbnail: path.join(out, "thumbnail.jpg"), timeline: path.join(out, "timeline.json"), captions: path.join(out, "captions.json"), qa: path.join(out, "qa.json") };
  for (const [name, file] of Object.entries(files)) await writeFile(file, `${name} bytes`);
  return { status: "ready", files, qa: { sha256: sha("video bytes"), ok: true } as never, durationMs: 70000, frames: 2100, renderMs: 1, bundleMs: 1 };
}

const steps = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };
const retryLater = (message: string) => new Error(`retry later: ${message}`);

describe("the worker (start → reserve-voice → speech per scene → render)", () => {
  it("records each scene once (lock claimed, answer saved BEFORE the upload), renders, uploads create-only, saves the video", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const { store } = fakeStore(events);
      const files = fakeFiles();
      const provider = { calls: 0 };
      const seen: { spec?: RenderJobSpec; tmp?: string } = {};
      const outcome = await runGenerateJob(
        { event: { jobId: generateJob()._id.toHexString(), attempt: 1 }, runId: null, step: steps },
        { store, files: () => files, voice: voiceWith(provider), render: fakeRenderer(events, readyResult, seen) as never, root, retryLater, log: () => undefined, heartbeatMs: 10 },
      );
      expect(outcome).toBe("done");
      const scenes = validPlan().scenes.length;
      expect(provider.calls).toBe(scenes);
      expect(events.slice(0, 2)).toEqual(["start", `reserve:${scenes}`]);
      expect(events.slice(2, 6)).toEqual(["claim", "save-answer", "ready", "claim"]);
      expect(events.at(-1)).toBe("complete:output.mp4");
      // Narration: audio + both timing files per recording; the video: mp4, thumbnail, timeline, captions, qa.
      const keys = [...files.objects.keys()];
      expect(keys.filter((k) => k.includes("/speech/"))).toHaveLength(scenes * 3);
      expect(keys.filter((k) => k.includes("/renders/")).map((k) => k.split("/").pop()).sort()).toEqual(["captions.json", "output.mp4", "qa.json", "thumbnail.jpg", "timeline.json"]);
      expect(new Set(keys.filter((k) => k.includes("/renders/")).map((k) => k.split("/")[5])).size).toBe(1);
      // The render ran in its own folder inside the project, with its own temp folder there; both are gone now.
      expect(seen.spec!.workDir.startsWith(path.join(root, "runs", ".tmp", "generate"))).toBe(true);
      expect(seen.tmp).toBe(path.join(seen.spec!.workDir, "tmp"));
      expect(seen.spec!.music).toBe(true);
      expect(existsSync(seen.spec!.workDir)).toBe(false);
    });
  });

  it("Try again reuses every recording made before: no voice call, nothing reserved", async () => {
    await withTempDir(async (root) => {
      const first: Events = [];
      const files = fakeFiles();
      const { store, speech } = fakeStore(first);
      await runGenerateJob({ event: { jobId: generateJob()._id.toHexString(), attempt: 1 }, runId: null, step: steps }, { store, files: () => files, voice: voiceWith({ calls: 0 }), render: fakeRenderer(first, readyResult) as never, root, retryLater, log: () => undefined });
      const again: Events = [];
      const provider = { calls: 0 };
      const { store: store2 } = fakeStore(again, { ready: speech });
      const outcome = await runGenerateJob({ event: { jobId: generateJob()._id.toHexString(), attempt: 2 }, runId: null, step: steps }, { store: store2, files: () => fakeFilesFrom(files), voice: voiceWith(provider), render: fakeRenderer(again, readyResult) as never, root, retryLater, log: () => undefined });
      expect(outcome).toBe("done");
      expect(provider.calls).toBe(0);
      expect(again).toContain("reserve:0");
      expect(again).not.toContain("claim");
    });
  });

  it("the voice limit is checked BEFORE any ElevenLabs call: nothing paid, plain message", async () => {
    await withTempDir(async (root) => {
      for (const [reserve, code] of [["quota", "QUOTA_EXCEEDED"], ["ceiling", "SPEND_CEILING"]] as const) {
        const events: Events = [];
        const provider = { calls: 0 };
        const { store } = fakeStore(events, { reserve });
        const outcome = await runGenerateJob({ event: { jobId: generateJob()._id.toHexString(), attempt: 1 }, runId: null, step: steps }, { store, files: () => fakeFiles(), voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root, retryLater, log: () => undefined });
        expect(outcome).toBe("failed");
        expect(provider.calls).toBe(0);
        expect(events.at(-1)).toBe(`end:failed:${code}`);
      }
    });
  });

  it("a busy voice service → PROVIDER_BUSY (retryable); a refused voice → PROVIDER_UNAVAILABLE", async () => {
    await withTempDir(async (root) => {
      const cases = [
        [new ProviderError({ provider: "elevenlabs", kind: "transient", message: "busy" }), "PROVIDER_BUSY"],
        [new ProviderError({ provider: "elevenlabs", kind: "account-restricted", message: "402" }), "PROVIDER_UNAVAILABLE"],
      ] as const;
      for (const [fail, code] of cases) {
        const events: Events = [];
        const { store } = fakeStore(events);
        const outcome = await runGenerateJob({ event: { jobId: generateJob()._id.toHexString(), attempt: 1 }, runId: null, step: steps }, { store, files: () => fakeFiles(), voice: voiceWith({ calls: 0, fail }), render: fakeRenderer(events, readyResult) as never, root, retryLater, log: () => undefined });
        expect(outcome).toBe("failed");
        expect(events).toContain("speech-failed");
        expect(events.at(-1)).toBe(`end:failed:${code}`);
        expect(speechFailureCode(fail)).toBe(code);
      }
      expect(GENERATE_ERRORS.PROVIDER_BUSY.retryable).toBe(true);
      expect(GENERATE_ERRORS.PROVIDER_UNAVAILABLE.retryable).toBe(false);
    });
  });

  it("a paid answer saved by an earlier run whose audio reached R2 is reused: no second call", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const files = fakeFiles();
      const { store, speech } = fakeStore(events);
      const provider = { calls: 0 };
      // Run once to get real answers, then make every recording "pending with a saved answer" again.
      await runGenerateJob({ event: { jobId: generateJob()._id.toHexString(), attempt: 1 }, runId: null, step: steps }, { store, files: () => files, voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root, retryLater, log: () => undefined });
      const paid = provider.calls;
      for (const doc of speech.values()) {
        doc.status = "pending";
        doc.response = (doc.response ?? JSON.parse(Buffer.from(files.objects.get(doc.alignmentKey)!).toString())) as never;
      }
      for (const key of [...files.objects.keys()]) if (!key.endsWith("audio.mp3")) files.objects.delete(key);
      const { store: again } = fakeStore([], { ready: speech });
      await runGenerateJob({ event: { jobId: generateJob()._id.toHexString(), attempt: 2 }, runId: null, step: steps }, { store: again, files: () => files, voice: voiceWith(provider), render: fakeRenderer([], readyResult) as never, root, retryLater, log: () => undefined });
      expect(provider.calls).toBe(paid);
    });
  });

  it("Cancel: before the render it never starts; during the render the renderer is stopped", async () => {
    await withTempDir(async (root) => {
      const before: Events = [];
      const { store } = fakeStore(before, { cancelAt: "render" });
      expect(await runGenerateJob({ event: { jobId: generateJob()._id.toHexString(), attempt: 1 }, runId: null, step: steps }, { store, files: () => fakeFiles(), voice: voiceWith({ calls: 0 }), render: fakeRenderer(before, readyResult) as never, root, retryLater, log: () => undefined })).toBe("cancelled");
      expect(before).not.toContain("render");

      const during: Events = [];
      const seen: { cancelled?: boolean } = {};
      const files = fakeFiles();
      const { store: store2 } = fakeStore(during, {});
      let release: (r: RenderJobResult) => void = () => undefined;
      const renderer = fakeRenderer(during, () => new Promise<RenderJobResult>((resolve) => (release = resolve)), seen);
      const running = runGenerateJob(
        { event: { jobId: generateJob()._id.toHexString(), attempt: 1 }, runId: null, step: steps },
        {
          store: { ...store2, progress: async () => ({ cancelRequested: during.includes("render") }) },
          files: () => files,
          voice: voiceWith({ calls: 0 }),
          render: ((spec: RenderJobSpec, o: never) => {
            const run = renderer(spec, o);
            return { ...run, cancel: () => (run.cancel(), release({ status: "cancelled" })) };
          }) as never,
          root,
          retryLater,
          log: () => undefined,
          heartbeatMs: 5,
        },
      );
      expect(await running).toBe("cancelled");
      expect(seen.cancelled).toBe(true);
      expect(during.at(-1)).toBe("end:cancelled:");
    });
  });

  it("the storyboard must change (too long / unclear words) → needs_input; a render error → RENDER_FAILED", async () => {
    await withTempDir(async (root) => {
      const run = async (result: RenderJobResult) => {
        const events: Events = [];
        const { store } = fakeStore(events);
        const files = fakeFiles();
        await runGenerateJob({ event: { jobId: generateJob()._id.toHexString(), attempt: 1 }, runId: null, step: steps }, { store, files: () => files, voice: voiceWith({ calls: 0 }), render: fakeRenderer(events, async () => result) as never, root, retryLater, log: () => undefined });
        return events.at(-1);
      };
      expect(await run({ status: "needs_input", reason: "duration_out_of_range", message: "Your narration runs about 97 seconds…", sceneId: null, detail: "" })).toBe("end:needs_input:");
      expect(await run({ status: "failed", stage: "render", detail: "chrome crashed" })).toBe("end:failed:RENDER_FAILED");
    });
  });
});

/** The same objects, a new store (a later run). */
function fakeFilesFrom(files: ReturnType<typeof fakeFiles>): FileStore {
  const copy = fakeFiles();
  for (const [k, v] of files.objects) copy.objects.set(k, v);
  return copy as FileStore & { objects: Map<string, Uint8Array> };
}

// Keys are typed: make sure the fake store accepts what the worker passes.
void ((key: StorageKey) => key);
