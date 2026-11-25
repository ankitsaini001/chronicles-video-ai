import { existsSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  allowedActionsFor,
  approveAndGenerate,
  checkStuckJob,
  canTakeOverSpeech,
  claimSpeech,
  endGenerateJob,
  GENERATE_CANCEL_GRACE_MS,
  GENERATE_ERRORS,
  generateJobKey,
  isGenerateJobStuck,
  markSpeechReady,
  newGenerateJob,
  newPlanJob,
  planVoiceReservation,
  planVoiceSend,
  ProjectActionError,
  recordingMessage,
  reserveVoiceSend,
  savedAudioOf,
  saveSpeechResponse,
  SPEECH_LOCK_STALE_MS,
  speechSaveTarget,
  startGenerateAttempt,
  voiceCredits,
  voiceLimitError,
  voiceLimitProblem,
  voicePeriodOf,
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
import { FakeElevenLabsSpeech } from "../apps/web/lib/video/fake-elevenlabs";
import type { RenderRun } from "../apps/web/lib/video/render-process";
import {
  renderPhaseProgress,
  runGenerateJob,
  SPEECH_BUSY_MAX_WAITS,
  SPEECH_BUSY_WAIT_MS,
  SPEECH_HEARTBEAT_MS,
  speechFailureCode,
  type FileStore,
  type GenerateJobDeps,
  type GenerateJobStore,
} from "../apps/web/lib/video/run-generate-job";
import { videoSteps, waitingText } from "../apps/web/lib/video/steps";
import { voiceSetupFromEnv, type VoiceSetup } from "../apps/web/lib/video/voice";
import { countCharacters, speechConfigFor } from "../packages/pipeline/src/pipeline/speech";
import type { RenderJobResult, RenderJobSpec, RenderPhase } from "../packages/pipeline/src/pipeline/render-protocol";
import { ElevenLabsSpeech, ProviderError, type SpeechCallOptions, type SpeechRequest } from "../packages/pipeline/src/providers";
import { validPlan, withTempDir } from "./helpers";

/** The stand-in voice is allowed only on a local test server with the test database (never a real call). */
const STAND_IN_ENV = { E2E_FAKE_ELEVENLABS: "1", MONGODB_DB: "bytereel_test", MONGODB_URI: "mongodb+srv://tester:not-a-password@cluster0.example.mongodb.net/", BETTER_AUTH_URL: "http://localhost:3232" };

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

  it("the creator's 3,000 characters a month → 429 with needed vs left and the reset date (F27)", async () => {
    const { db } = base({ user: 2500 });
    const error = await refusal(approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW }));
    expect(error).toMatchObject({ code: "QUOTA_EXCEEDED", message: "This video needs about 600 voice characters, but you have 500 left this month. The limit resets on 1 December." });
    expect(error.details).toMatchObject({ quota: "voice_characters_per_month", limit: 3000, used: 2500, needed: 600 });
  });

  it("the app-wide 9,000 a month → 503 SPEND_CEILING: paused for everyone (F27)", async () => {
    const { db } = base({ app: 8500 });
    const error = await refusal(approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW }));
    expect(error).toMatchObject({ code: "SPEND_CEILING", message: "Video making is paused for everyone until 1 December, 5:30 am your time (the app's monthly voice limit is used up). Your videos and downloads still work." });
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
    const failed = generateJob({ state: "cancelled", attempt: 2, voice: { cacheKeys: [voice(versionDoc().plan)[0]!.cacheKey], characters: 100, sentKeys: [], period: voicePeriodOf("Asia/Kolkata", NOW) } });
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

  it("a reservation from LAST month covers nothing now: everything still needed is checked again", async () => {
    const lastMonth = new Date("2026-10-20T05:00:00.000Z");
    const failed = generateJob({ state: "cancelled", attempt: 2, voice: { cacheKeys: [voice(versionDoc().plan)[0]!.cacheKey], characters: 100, sentKeys: [], period: voicePeriodOf("Asia/Kolkata", lastMonth) } });
    const { db } = fakeDb({
      "projects.findOne": () => projectDoc({ approvedPlanVersionId: V1 }),
      "planVersions.findOne": () => versionDoc(),
      "jobs.findOne": () => failed,
      "speechArtifacts.find": () => [],
      "usageCounters.findOne": (filter: { kind: string }) => ({ count: filter.kind === "voiceChars" ? 2500 : 0 }),
    });
    const error = await refusal(approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "Asia/Kolkata", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW }));
    expect(error.details).toMatchObject({ quota: "voice_characters_per_month", needed: 600 });
  });

  it("like E2: a job that failed with an error that can't be retried is not queued again ('edit your storyboard')", async () => {
    const failed = generateJob({ state: "failed", error: { code: "PROVIDER_UNAVAILABLE", message: "", retryable: false } });
    const { db, names } = fakeDb({ "projects.findOne": () => projectDoc({ approvedPlanVersionId: V1 }), "planVersions.findOne": () => versionDoc(), "jobs.findOne": () => failed });
    const error = await refusal(approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone: "UTC", body, voice, respond: () => ({ status: 202, body: {} }), now: NOW }));
    expect(error).toMatchObject({ code: "INVALID_STATE", message: "This step can't be retried. Please edit your storyboard instead." });
    expect(names().some((n) => n.startsWith("usageCounters") || n === "jobs.findOneAndUpdate")).toBe(false);
    expect(allowedActionsFor(projectDoc({ approvedPlanVersionId: V1 }), null, null, { latestGenerateJob: failed })).not.toContain("generate_video");
    expect(allowedActionsFor(projectDoc({ approvedPlanVersionId: V1 }), null, null, { latestGenerateJob: { ...failed, error: { code: "RENDER_FAILED", message: "", retryable: true } } })).toContain("generate_video");
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

  it("the refusals say why and when they reset (F27); the job's short fallback stays", () => {
    const user = voiceLimitError("user", { used: 2900, needed: 300, timezone: "Asia/Kolkata", now: NOW });
    expect(user).toMatchObject({ code: "QUOTA_EXCEEDED", message: "This video needs about 300 voice characters, but you have 100 left this month. The limit resets on 1 December.", details: { quota: "voice_characters_per_month", resetsAt: "2026-11-30T18:30:00.000Z" } });
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

  it("taken over: a failed one, this same job's claim WITH a saved answer, or an abandoned claim", () => {
    const other = new ObjectId();
    const answer = { audioSha256: "sha256:x", charactersSent: 10 };
    const fresh = { jobId: JOB, attempt: 1, at: NOW };
    const old = { jobId: JOB, attempt: 1, at: new Date(NOW.getTime() - SPEECH_LOCK_STALE_MS) };
    expect(canTakeOverSpeech({ status: "failed", claim: null, response: null }, JOB, NOW)).toBe(true);
    expect(canTakeOverSpeech({ status: "failed", claim: null, response: answer }, other, NOW)).toBe(true);
    expect(canTakeOverSpeech({ status: "pending", claim: fresh, response: answer }, JOB, NOW)).toBe(true);
    expect(canTakeOverSpeech({ status: "pending", claim: { ...fresh, jobId: other }, response: null }, JOB, NOW)).toBe(false);
    expect(canTakeOverSpeech({ status: "pending", claim: { ...fresh, jobId: other }, response: answer }, JOB, NOW)).toBe(false);
    expect(canTakeOverSpeech({ status: "pending", claim: { ...old, jobId: other }, response: null }, JOB, NOW)).toBe(true);
    expect(canTakeOverSpeech({ status: "ready", claim: null, response: null }, JOB, NOW)).toBe(false);
  });

  it("the same job's FRESH claim without a saved answer is not taken over (its first run may still be calling ElevenLabs); stale, it is", () => {
    expect(canTakeOverSpeech({ status: "pending", claim: { jobId: JOB, attempt: 1, at: NOW }, response: null }, JOB, NOW)).toBe(false);
    expect(canTakeOverSpeech({ status: "pending", claim: { jobId: JOB, attempt: 1, at: new Date(NOW.getTime() - SPEECH_LOCK_STALE_MS) }, response: null }, JOB, NOW)).toBe(true);
    // The stale time outlasts the longest request in flight: 3 tries × 120 s + 2 waits × 60 s = 8 min.
    expect(SPEECH_LOCK_STALE_MS).toBeGreaterThan(3 * 120_000 + 2 * 60_000);
  });

  it("the paid answer and its audio bytes are saved in ONE write; ready removes the bytes", async () => {
    const writes: any[] = [];
    const { db } = fakeDb({ "speechArtifacts.updateOne": (filter: unknown, update: unknown) => (writes.push({ filter, update }), { matchedCount: 1 }) });
    const audio = new Uint8Array([1, 2, 3]);
    expect(await saveSpeechResponse(db, { ownerId: OWNER, cacheKey: "sha256:k", jobId: JOB, attempt: 1, response: { audioSha256: "sha256:x", charactersSent: 10 }, audio, durationMs: 900, now: NOW })).toBe("held");
    expect(writes[0].filter).toMatchObject({ status: "pending", "claim.jobId": JOB, "claim.attempt": 1 });
    expect(writes[0].update.$set).toMatchObject({ response: { audioSha256: "sha256:x" }, audioSha256: "sha256:x", paidByJobId: JOB });
    expect(savedAudioOf({ audio: writes[0].update.$set.audio })).toEqual(audio);
    expect(await markSpeechReady(db, { ownerId: OWNER, cacheKey: "sha256:k", jobId: JOB, attempt: 1, now: NOW })).toBe(true);
    expect(writes[1].update.$unset).toEqual({ audio: "" });
    expect(writes[1].update.$set).toMatchObject({ status: "ready", response: null });
  });

  it("where a paid answer may be saved (second review, finding 1): this job's claim, or a claim released before any answer", () => {
    const answer = { audioSha256: "sha256:x", charactersSent: 10 };
    const mine = { jobId: JOB, attempt: 2, at: NOW };
    expect(speechSaveTarget({ status: "pending", claim: mine, response: null }, JOB, 2)).toBe("held");
    // The job ended mid-request (Cancel + the 60-second rule): released, no answer yet → still saved.
    expect(speechSaveTarget({ status: "failed", claim: null, response: null }, JOB, 2)).toBe("released");
    expect(speechSaveTarget({ status: "pending", claim: mine, response: null }, JOB, 1)).toBeNull(); // an older attempt
    expect(speechSaveTarget({ status: "pending", claim: { ...mine, jobId: new ObjectId() }, response: null }, JOB, 2)).toBeNull(); // another run holds it
    expect(speechSaveTarget({ status: "failed", claim: null, response: answer }, JOB, 2)).toBeNull(); // it has an answer already
    expect(speechSaveTarget({ status: "ready", claim: null, response: null }, JOB, 2)).toBeNull();
  });

  it("an answer that arrives after the job released its claim is saved there (status untouched); nothing matches → null", async () => {
    const writes: any[] = [];
    const matches = [0, 1];
    const { db } = fakeDb({ "speechArtifacts.updateOne": (filter: unknown, update: unknown) => (writes.push({ filter, update }), { matchedCount: matches.shift() ?? 0 }) });
    const input = { ownerId: OWNER, cacheKey: "sha256:k", jobId: JOB, attempt: 1, response: { audioSha256: "sha256:x", charactersSent: 10 }, audio: new Uint8Array([7, 8]), durationMs: 900, now: NOW };
    expect(await saveSpeechResponse(db, input)).toBe("released");
    expect(writes[1].filter).toEqual({ ownerId: OWNER, cacheKey: "sha256:k", status: "failed", claim: null, response: null });
    expect(writes[1].update.$set).toMatchObject({ response: { audioSha256: "sha256:x" }, audioSha256: "sha256:x", paidByJobId: JOB });
    expect(savedAudioOf({ audio: writes[1].update.$set.audio })).toEqual(new Uint8Array([7, 8]));
    expect(writes[1].update.$set).not.toHaveProperty("status");
    expect(writes[1].update.$set).not.toHaveProperty("claim.at");
    expect(await saveSpeechResponse(db, input)).toBeNull();
  });

  it("taking over a failed recording keeps its saved answer and bytes (the next job uploads them, no call)", async () => {
    const saved = doc({ status: "failed", claim: null, response: { audioSha256: "sha256:x", charactersSent: 10 }, audio: new Uint8Array([1, 2]) });
    const updates: any[] = [];
    const { db } = fakeDb({
      "speechArtifacts.updateOne": () => ({ upsertedCount: 0 }),
      "speechArtifacts.findOne": () => saved,
      "speechArtifacts.findOneAndUpdate": (_f: unknown, update: { $set: object }) => (updates.push(update), { ...saved, ...update.$set }),
    });
    const claim = await claimSpeech(db, { ownerId: OWNER, cacheKey: "sha256:k", jobId: JOB, attempt: 2, setup, now: NOW });
    expect(claim.kind).toBe("claimed");
    expect(updates[0].$set).not.toHaveProperty("response");
    expect(updates[0].$set).not.toHaveProperty("audio");
    expect(claim.doc.response).toMatchObject({ audioSha256: "sha256:x" });
    expect(savedAudioOf(claim.doc)).toEqual(new Uint8Array([1, 2]));
  });

  it("a job that ends releases its pending claims (answers and bytes kept), so no other job waits for them", async () => {
    const job = generateJob({ state: "running" });
    const released: any[] = [];
    const { db } = fakeDb({
      "jobs.findOne": () => job,
      "jobs.updateOne": () => ({}),
      "projects.updateOne": () => ({}),
      "speechArtifacts.updateMany": (filter: unknown, update: unknown) => void released.push({ filter, update }),
    });
    expect(await endGenerateJob(db, { jobId: job._id, attempt: 1, outcome: "failed", code: "INTERNAL", now: NOW })).toBe(true);
    expect(released[0].filter).toEqual({ ownerId: OWNER, status: "pending", "claim.jobId": job._id });
    expect(released[0].update.$set).toMatchObject({ status: "failed", claim: null });
    expect(released[0].update.$set).not.toHaveProperty("response");
    expect(released[0].update).not.toHaveProperty("$unset");
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

  it("Cancel pressed but the worker is gone: after a minute without progress the job ends as cancelled", async () => {
    const job = generateJob({ state: "running", cancelRequestedAt: minutes(2), updatedAt: minutes(2) });
    const writes: any[] = [];
    const { db } = fakeDb({
      "jobs.findOne": () => job,
      "jobs.updateOne": (_f: unknown, u: unknown) => void writes.push(u),
      "projects.updateOne": (_f: unknown, u: unknown) => void writes.push(u),
      "speechArtifacts.updateMany": () => ({}),
    });
    await checkStuckJob(db, job, NOW);
    expect(writes[0].$set).toMatchObject({ state: "cancelled" });
    expect(writes[1].$set).toMatchObject({ state: "storyboard_ready" });
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
      "speechArtifacts.updateMany": () => ({}),
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
      "speechArtifacts.updateMany": () => ({}),
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

type PutFailure = (key: string) => Error | null;

function fakeFiles(failPut: PutFailure = () => null): FileStore & { objects: Map<string, Uint8Array>; puts: string[] } {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    objects,
    puts,
    checkBucket: async () => undefined,
    put: async (key, data, options) => {
      puts.push(key);
      const failure = failPut(key);
      if (failure) throw failure;
      const bytes = typeof data === "string" ? new Uint8Array(Buffer.from(data)) : data;
      if (options?.createOnly && objects.has(key)) throw new StorageError("put", "already_exists", 412);
      objects.set(key, bytes);
      return { key, sha256: sha(bytes), bytes: bytes.byteLength };
    },
    get: async (key) => objects.get(key) ?? null,
    head: async (key) => (objects.has(key) ? { bytes: objects.get(key)!.byteLength, contentType: null, sha256: sha(objects.get(key)!) } : null),
  };
}

/** The same objects, a new store (a later run). */
function fakeFilesFrom(files: ReturnType<typeof fakeFiles>): ReturnType<typeof fakeFiles> {
  const copy = fakeFiles();
  for (const [k, v] of files.objects) copy.objects.set(k, v);
  return copy;
}

type Events = string[];

/**
 * An in-memory store with the REAL rules where it matters: the speech lock (canTakeOverSpeech), the
 * voice counting (planVoiceReservation / planVoiceSend, in the creator's month), and a job's end
 * releasing its pending claims. One job; run it again with a higher attempt for "Try again".
 */
function fakeStore(events: Events, options: { cancelAt?: "render" | "progress"; reserve?: "ok" | "quota" | "ceiling" | "cancelled"; send?: "quota" | "ceiling"; ready?: Map<string, SpeechArtifactDocument>; busyClaims?: number } = {}) {
  const job = generateJob({ state: "running" });
  const project = projectDoc({ state: "generating", activeJobId: job._id, approvedPlanVersionId: V1 });
  const speech = options.ready ?? new Map<string, SpeechArtifactDocument>();
  const state = {
    voice: job.voice ?? null,
    counted: 0,
    /** One entry per request the worker counted before sending (its cache key). */
    sends: [] as string[],
    usage: [] as { status: string; outcome: string | null; characters: number }[],
    ends: [] as Parameters<GenerateJobStore["end"]>[0][],
    speechFailures: [] as string[],
    progress: [] as Parameters<GenerateJobStore["progress"]>[0][],
    busyLeft: options.busyClaims ?? 0,
  };
  let cancelRequested = false;
  const ctx = (): GenerateJobContext => ({ job: { ...job, voice: state.voice, cancelRequestedAt: cancelRequested ? NOW : null }, project, version: versionDoc() });
  const period = () => voicePeriodOf("Asia/Kolkata", new Date());
  const store: GenerateJobStore = {
    start: async () => (events.push("start"), ctx()),
    load: async () => ctx(),
    timezone: async () => "Asia/Kolkata",
    readySpeech: async (_o, keys) => keys.flatMap((k) => (speech.get(k)?.status === "ready" ? [speech.get(k)!] : [])),
    paidSpeechKeys: async (_o, keys) => keys.filter((k) => speech.get(k)?.status === "ready" || (speech.get(k)?.response && savedAudioOf(speech.get(k)!))),
    reserveVoice: async (input) => {
      events.push(`reserve:${input.items.length}`);
      if (options.reserve && options.reserve !== "ok") return options.reserve;
      const planned = planVoiceReservation(state.voice, input.items, period());
      state.counted += planned.total;
      state.voice = planned.next;
      return "ok";
    },
    reserveVoiceSend: async (input) => {
      if (cancelRequested) return "cancelled"; // the real check: nothing is sent after Cancel
      if (options.send) return options.send; // F27: a request refused by a monthly limit (not sent)
      const planned = planVoiceSend(state.voice, input.item, period());
      state.sends.push(input.item.cacheKey);
      state.counted += planned.count;
      state.voice = planned.next;
      return "ok";
    },
    reserveUsage: async (input) => {
      const row = { status: "reserved", outcome: null as string | null, characters: input.characters };
      state.usage.push(row);
      return row;
    },
    finishUsage: async (handle, input) => void Object.assign(handle as object, { status: input.status, outcome: input.outcome, characters: input.characters }),
    claimSpeech: async (input) => {
      const existing = speech.get(input.cacheKey);
      const claim = { jobId: input.jobId, attempt: input.attempt, at: new Date() };
      if (state.busyLeft > 0) {
        state.busyLeft--;
        events.push("busy");
        return { kind: "busy", doc: existing ?? ({} as SpeechArtifactDocument) };
      }
      if (!existing) {
        const doc = { _id: new ObjectId(), ownerId: input.ownerId, cacheKey: input.cacheKey, ...input.setup, status: "pending", claim, response: null, audio: null, audioSha256: null } as unknown as SpeechArtifactDocument;
        speech.set(input.cacheKey, doc);
        events.push("claim");
        return { kind: "claimed", doc };
      }
      if (existing.status === "ready") return { kind: "ready", doc: existing };
      if (!canTakeOverSpeech(existing, input.jobId, new Date())) {
        events.push("busy");
        return { kind: "busy", doc: existing };
      }
      Object.assign(existing, { status: "pending", claim, error: null });
      events.push("claim");
      return { kind: "claimed", doc: existing };
    },
    saveSpeechResponse: async (input) => {
      // The real matching rule: this job's claim ("held"), or released without an answer ("released").
      const doc = speech.get(input.cacheKey);
      const target = doc ? speechSaveTarget(doc, input.jobId, input.attempt) : null;
      if (!doc || !target) return null;
      Object.assign(doc, { response: input.response, audio: input.audio, audioSha256: input.response.audioSha256 });
      events.push(target === "held" ? "save-answer" : "save-answer-released");
      return target;
    },
    markSpeechReady: async (input) => {
      Object.assign(speech.get(input.cacheKey)!, { status: "ready", claim: null, response: null, audio: null });
      events.push("ready");
      return true;
    },
    markSpeechFailed: async (input) => {
      const doc = speech.get(input.cacheKey);
      if (doc?.status === "pending" && doc.claim?.jobId.equals(input.jobId)) Object.assign(doc, { status: "failed", claim: null });
      state.speechFailures.push(input.message);
      events.push("speech-failed");
    },
    progress: async (input) => {
      state.progress.push(input);
      if (options.cancelAt === "progress") cancelRequested = true;
      return { cancelRequested };
    },
    beginRender: async () => (events.push("begin-render"), { cancelRequested: options.cancelAt === "render" }),
    complete: async (input) => (events.push(`complete:${input.render.keys.mp4.split("/").pop()}`), true),
    end: async (input) => {
      events.push(`end:${input.outcome}:${input.code ?? ""}`);
      state.ends.push(input);
      // endGenerateJob releases the job's pending claims (answers and bytes kept).
      for (const doc of speech.values()) if (doc.status === "pending" && doc.claim?.jobId.equals(input.jobId)) Object.assign(doc, { status: "failed", claim: null });
      return true;
    },
  };
  /** The creator presses Cancel (cancelRequestedAt set; the job keeps running until the worker stops). */
  const cancel = () => void (cancelRequested = true);
  return { store, speech, state, cancel, jobId: job._id.toHexString() };
}

/**
 * A counting stand-in voice: one request per synthesize call, counted (beforeAttempt) before it
 * "sends". `during` runs while the request is in flight (after it was sent, before the answer).
 */
function voiceWith(provider: { calls: number; texts?: string[]; fail?: Error; during?: (call: number) => Promise<void> }) {
  const setup = voiceSetupFromEnv(STAND_IN_ENV);
  if (!setup.ok) throw new Error(setup.problem);
  return () => ({
    ...setup,
    provider: () => ({
      name: "test",
      synthesize: async (request: SpeechRequest, options?: SpeechCallOptions) => {
        await options?.beforeAttempt?.(1);
        provider.calls++;
        provider.texts?.push(request.text);
        await provider.during?.(provider.calls);
        if (provider.fail) throw provider.fail;
        return new FakeElevenLabsSpeech("en").synthesize(request);
      },
    }),
  });
}

/**
 * The REAL ElevenLabs adapter (ElevenLabsSpeech, its retries and response checks) over a scripted
 * fetch: no network at all. Each script entry answers one HTTP request; then every answer is good.
 */
function scriptedElevenLabs(script: ("ok" | "timeout" | "busy" | "bad-json" | "quota")[], model: { id: string } = { id: "eleven_test_v1" }) {
  const requests: { model: string; text: string }[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { text: string; model_id: string };
    requests.push({ model: body.model_id, text: body.text });
    const next = script.shift() ?? "ok";
    if (next === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (next === "busy") return new Response(JSON.stringify({ detail: { status: "system_busy", message: "busy" } }), { status: 503 });
    if (next === "quota") return new Response(JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota of 10000." } }), { status: 401 });
    if (next === "bad-json") return new Response("{not json", { status: 200 });
    const fake = await new FakeElevenLabsSpeech("en").synthesize({ text: body.text } as SpeechRequest);
    return new Response(JSON.stringify({ audio_base64: Buffer.from(fake.audio).toString("base64"), alignment: fake.alignment, normalized_alignment: fake.normalizedAlignment }), { status: 200 });
  }) as typeof fetch;
  const voice = (): VoiceSetup => ({ ok: true, fake: false, configFor: (plan) => speechConfigFor(plan, "TestVoice0001", model.id), provider: () => new ElevenLabsSpeech("not-a-real-key", fetchFn) });
  return { requests, voice, model };
}

function fakeRenderer(events: Events, result: (spec: RenderJobSpec) => Promise<RenderJobResult>, seen: { spec?: RenderJobSpec; tmp?: string; cancelled?: boolean } = {}, progress: [RenderPhase, number][] = [["rendering", 10]]) {
  return (spec: RenderJobSpec, options: { tmp: string; onProgress: (phase: RenderPhase, percent: number) => void }): RenderRun => {
    seen.spec = spec;
    seen.tmp = options.tmp;
    events.push("render");
    for (const [phase, percent] of progress) options.onProgress(phase, percent);
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

/** Steps run once (no Inngest retries); waits are recorded, not waited. */
function plainSteps() {
  const sleeps: string[] = [];
  return { sleeps, run: <T>(_id: string, fn: () => Promise<T>) => fn(), sleep: async (id: string) => void sleeps.push(id) };
}
/** Like Inngest: a step that throws is run again, up to `retries` more times; then the error reaches the job. */
function retryingSteps(retries = 3) {
  const runs = new Map<string, number>();
  const sleeps: string[] = [];
  return {
    runs,
    sleeps,
    run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      for (let i = 0; ; i++) {
        runs.set(id, (runs.get(id) ?? 0) + 1);
        try {
          return await fn();
        } catch (error) {
          if (i >= retries) throw error;
        }
      }
    },
    sleep: async (id: string) => void sleeps.push(id),
  };
}

/** One file store for the whole run (every step sees the same files). */
const sameFiles = (files: FileStore) => () => files;
const quiet = { log: process.env.DEBUG_F23 ? (level: string, message: string) => console.log(level, message) : () => undefined, sleep: async () => undefined };
const scenesOf = () => validPlan().scenes.length;
const run = (bundle: { store: GenerateJobStore; jobId: string }, deps: Omit<GenerateJobDeps, "store" | "root"> & { root: string }, options: { attempt?: number; step?: ReturnType<typeof plainSteps> | ReturnType<typeof retryingSteps> } = {}) =>
  runGenerateJob({ event: { jobId: bundle.jobId, attempt: options.attempt ?? 1 }, runId: null, step: options.step ?? plainSteps() }, { ...quiet, ...deps, store: bundle.store });

describe("the worker (start → reserve-voice → speech per scene → render)", () => {
  it("records each scene once (lock claimed, answer + bytes saved BEFORE the upload), renders, uploads create-only, saves the video", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const bundle = fakeStore(events);
      const files = fakeFiles();
      const provider = { calls: 0 };
      const seen: { spec?: RenderJobSpec; tmp?: string } = {};
      // A work folder left by a render that never finished (7 h old) and a recent one (another render).
      const generateDir = path.join(root, "runs", ".tmp", "generate");
      const stale = path.join(generateDir, "a".repeat(24));
      const recent = path.join(generateDir, "b".repeat(24));
      await mkdir(stale, { recursive: true });
      await mkdir(recent, { recursive: true });
      const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000);
      await utimes(stale, sevenHoursAgo, sevenHoursAgo);
      const outcome = await run(bundle, { files: () => files, voice: voiceWith(provider), render: fakeRenderer(events, readyResult, seen) as never, root, heartbeatMs: 10 });
      expect(outcome).toBe("done");
      const scenes = scenesOf();
      expect(provider.calls).toBe(scenes);
      expect(events.slice(0, 2)).toEqual(["start", `reserve:${scenes}`]);
      expect(events.slice(2, 6)).toEqual(["claim", "save-answer", "ready", "claim"]);
      expect(events.at(-1)).toBe("complete:output.mp4");
      // Every request was counted before it was sent, and used the up-front reservation (nothing extra).
      expect(bundle.state.sends).toHaveLength(scenes);
      expect(bundle.state.voice?.cacheKeys).toEqual([]);
      expect(bundle.state.voice?.sentKeys).toHaveLength(scenes);
      // Narration: audio + both timing files per recording; the video: mp4, thumbnail, timeline, captions, qa.
      const keys = [...files.objects.keys()];
      expect(keys.filter((k) => k.includes("/speech/"))).toHaveLength(scenes * 3);
      expect(keys.filter((k) => k.includes("/renders/")).map((k) => k.split("/").pop()).sort()).toEqual(["captions.json", "output.mp4", "qa.json", "thumbnail.jpg", "timeline.json"]);
      expect(new Set(keys.filter((k) => k.includes("/renders/")).map((k) => k.split("/")[5])).size).toBe(1);
      // Ready recordings don't keep their bytes.
      expect([...bundle.speech.values()].every((d) => d.status === "ready" && !savedAudioOf(d))).toBe(true);
      // The render ran in its own folder inside the project, with its own temp folder there; both are gone now.
      expect(seen.spec!.workDir.startsWith(path.join(root, "runs", ".tmp", "generate"))).toBe(true);
      expect(seen.tmp).toBe(path.join(seen.spec!.workDir, "tmp"));
      expect(seen.spec!.music).toBe(true);
      expect(existsSync(seen.spec!.workDir)).toBe(false);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(recent)).toBe(true);
    });
  });

  it("Try again reuses every recording made before: no voice call, nothing reserved", async () => {
    await withTempDir(async (root) => {
      const first: Events = [];
      const files = fakeFiles();
      const bundle = fakeStore(first);
      await run(bundle, { files: () => files, voice: voiceWith({ calls: 0 }), render: fakeRenderer(first, readyResult) as never, root });
      const again: Events = [];
      const provider = { calls: 0 };
      const second = fakeStore(again, { ready: bundle.speech });
      const outcome = await run(second, { files: () => fakeFilesFrom(files), voice: voiceWith(provider), render: fakeRenderer(again, readyResult) as never, root }, { attempt: 2 });
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
        const bundle = fakeStore(events, { reserve });
        const outcome = await run(bundle, { files: sameFiles(fakeFiles()), voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root });
        expect(outcome).toBe("failed");
        expect(provider.calls).toBe(0);
        expect(events.at(-1)).toBe(`end:failed:${code}`);
        // F27: the characters the refused reservation asked for go with the failure (its message names them).
        expect(bundle.state.ends.at(-1)?.needed).toBeGreaterThan(0);
      }
    });
  });

  it("F27: a request refused by a monthly limit while recording is not sent; the failure gives no number (null)", async () => {
    await withTempDir(async (root) => {
      for (const [send, code] of [["quota", "QUOTA_EXCEEDED"], ["ceiling", "SPEND_CEILING"]] as const) {
        const events: Events = [];
        const provider = { calls: 0 };
        const bundle = fakeStore(events, { send });
        const outcome = await run(bundle, { files: sameFiles(fakeFiles()), voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root });
        expect(outcome).toBe("failed");
        expect(provider.calls).toBe(0);
        expect(bundle.state.ends.at(-1)).toMatchObject({ outcome: "failed", code, stage: "speech", needed: null });
      }
    });
  });

  it("a busy voice service → PROVIDER_BUSY (retryable); a refused voice → PROVIDER_UNAVAILABLE; only a fixed line is stored", async () => {
    await withTempDir(async (root) => {
      const cases = [
        [new ProviderError({ provider: "elevenlabs", kind: "transient", message: "raw provider text 503" }), "PROVIDER_BUSY"],
        [new ProviderError({ provider: "elevenlabs", kind: "account-restricted", message: "raw provider text 402" }), "PROVIDER_UNAVAILABLE"],
      ] as const;
      for (const [fail, code] of cases) {
        const events: Events = [];
        const bundle = fakeStore(events);
        const outcome = await run(bundle, { files: sameFiles(fakeFiles()), voice: voiceWith({ calls: 0, fail }), render: fakeRenderer(events, readyResult) as never, root });
        expect(outcome).toBe("failed");
        expect(events).toContain("speech-failed");
        expect(events.at(-1)).toBe(`end:failed:${code}`);
        expect(speechFailureCode(fail)).toBe(code);
        // The provider's own text goes to the server log only, never to the job or the lock.
        expect(JSON.stringify(bundle.state.ends)).not.toContain("raw provider text");
        expect(bundle.state.speechFailures.join()).not.toContain("raw provider text");
      }
      expect(GENERATE_ERRORS.PROVIDER_BUSY.retryable).toBe(true);
      expect(GENERATE_ERRORS.PROVIDER_UNAVAILABLE.retryable).toBe(false);
    });
  });

  it("ElevenLabs' own monthly limit → 'Voice limit reached this month.' (retryable); a long rate-limit wait is just busy", () => {
    expect(speechFailureCode(new ProviderError({ provider: "elevenlabs", kind: "quota", status: 401, message: "quota_exceeded" }))).toBe("SPEND_CEILING");
    expect(GENERATE_ERRORS.SPEND_CEILING).toEqual({ message: "Voice limit reached this month.", retryable: true });
    expect(speechFailureCode(new ProviderError({ provider: "elevenlabs", kind: "quota", status: 429, message: "asked to wait 300 s" }))).toBe("PROVIDER_BUSY");
  });

  it("a paid answer saved by an earlier run whose audio reached R2 is reused: no second call", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const files = fakeFiles();
      const bundle = fakeStore(events);
      const provider = { calls: 0 };
      // Run once to get real answers, then make every recording "pending with a saved answer" again.
      await run(bundle, { files: () => files, voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root });
      const paid = provider.calls;
      for (const doc of bundle.speech.values()) {
        doc.status = "pending";
        doc.response = JSON.parse(Buffer.from(files.objects.get(doc.alignmentKey)!).toString()) as never;
      }
      for (const key of [...files.objects.keys()]) if (!key.endsWith("audio.mp3")) files.objects.delete(key);
      await run(fakeStore([], { ready: bundle.speech }), { files: () => files, voice: voiceWith(provider), render: fakeRenderer([], readyResult) as never, root }, { attempt: 2 });
      expect(provider.calls).toBe(paid);
    });
  });

  it("Cancel: before the render it never starts; during the render the renderer is stopped", async () => {
    await withTempDir(async (root) => {
      const before: Events = [];
      expect(await run(fakeStore(before, { cancelAt: "render" }), { files: sameFiles(fakeFiles()), voice: voiceWith({ calls: 0 }), render: fakeRenderer(before, readyResult) as never, root })).toBe("cancelled");
      expect(before).not.toContain("render");

      const during: Events = [];
      const seen: { cancelled?: boolean } = {};
      const files = fakeFiles();
      const bundle = fakeStore(during, {});
      let release: (r: RenderJobResult) => void = () => undefined;
      const renderer = fakeRenderer(during, () => new Promise<RenderJobResult>((resolve) => (release = resolve)), seen);
      const running = run(
        { ...bundle, store: { ...bundle.store, progress: async () => ({ cancelRequested: during.includes("render") }) } },
        {
          files: () => files,
          voice: voiceWith({ calls: 0 }),
          render: ((spec: RenderJobSpec, o: never) => {
            const r = renderer(spec, o);
            return { ...r, cancel: () => (r.cancel(), release({ status: "cancelled" })) };
          }) as never,
          root,
          heartbeatMs: 5,
        },
      );
      expect(await running).toBe("cancelled");
      expect(seen.cancelled).toBe(true);
      expect(during.at(-1)).toBe("end:cancelled:");
    });
  });

  it("the storyboard must change (too long / unclear words) → needs_input; a render error → RENDER_FAILED; only fixed lines are stored", async () => {
    await withTempDir(async (root) => {
      const attemptWith = async (result: RenderJobResult) => {
        const events: Events = [];
        const bundle = fakeStore(events);
        await run(bundle, { files: sameFiles(fakeFiles()), voice: voiceWith({ calls: 0 }), render: fakeRenderer(events, async () => result) as never, root });
        return { last: events.at(-1), ends: JSON.stringify(bundle.state.ends) };
      };
      const needs = await attemptWith({ status: "needs_input", reason: "duration_out_of_range", message: "Your narration runs about 97 seconds…", sceneId: null, detail: "raw compiler detail" });
      expect(needs.last).toBe("end:needs_input:");
      expect(needs.ends).not.toContain("raw compiler detail");
      const failed = await attemptWith({ status: "failed", stage: "render", detail: "Error: chrome crashed\n    at /home/someone/secret/path.js:1:1" });
      expect(failed.last).toBe("end:failed:RENDER_FAILED");
      expect(failed.ends).not.toContain("chrome crashed");
      expect(failed.ends).toContain("The render stopped with an error (see the server log)");
    });
  });

  it("render progress: stage statuses are written only when the stage changes, not on every percent", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const bundle = fakeStore(events);
      const ticks: [RenderPhase, number][] = [["timing", 0], ["captions", 0], ["rendering", 1], ["rendering", 2], ["rendering", 3], ["checking", 0]];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const renderer = (spec: RenderJobSpec, options: { onProgress: (phase: RenderPhase, percent: number) => void }): RenderRun => ({
        result: (async () => {
          for (const [phase, percent] of ticks) {
            options.onProgress(phase, percent);
            await new Promise((r) => setTimeout(r, 15)); // a heartbeat (5 ms) in between
          }
          release();
          return readyResult(spec);
        })(),
        cancel: () => undefined,
      });
      await run(bundle, { files: sameFiles(fakeFiles()), voice: voiceWith({ calls: 0 }), render: renderer as never, root, heartbeatMs: 5 });
      await gate;
      const renderWrites = bundle.state.progress.filter((p) => p.stage === "render");
      expect(renderWrites.length).toBeGreaterThan(2);
      // Only the first write of the render stage moves stage statuses; the percent writes carry none.
      expect(renderWrites.filter((p) => p.stages && Object.keys(p.stages).length > 0)).toHaveLength(1);
    });
  });
});

describe("paid narration is never paid for again (code review, finding 1)", () => {
  const network = () => new StorageError("put", "network", null);

  it("saved answer, audio not in R2 (uploads keep failing) → zero further provider calls: not in the step's retries, not after Try again", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const bundle = fakeStore(events);
      const provider = { calls: 0, texts: [] as string[] };
      const steps = retryingSteps(3);
      const broken = fakeFiles((key) => (key.endsWith("audio.mp3") ? network() : null));
      const outcome = await run(bundle, { files: () => broken, voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root }, { step: steps });
      // Scene 1 was paid ONCE; its step ran 4 times (Inngest's 3 retries), each upload tried 3 times.
      expect(provider.calls).toBe(1);
      expect(steps.runs.get("speech-1")).toBe(4);
      expect(broken.puts.filter((k) => k.endsWith("audio.mp3"))).toHaveLength(12);
      expect(outcome).toBe("failed");
      expect(events.at(-1)).toBe("end:failed:INTERNAL");
      // The job's end released the lock and KEPT the answer and its bytes.
      const scene1 = [...bundle.speech.values()][0]!;
      expect(scene1).toMatchObject({ status: "failed", claim: null });
      expect(savedAudioOf(scene1)).not.toBeNull();

      // Try again (attempt 2), storage works now: scene 1 is uploaded from the saved bytes, never re-recorded.
      const working = fakeFiles();
      const again = await run(bundle, { files: () => working, voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root }, { attempt: 2, step: retryingSteps(3) });
      expect(again).toBe("done");
      expect(provider.calls).toBe(scenesOf());
      expect(new Set(provider.texts).size).toBe(provider.texts.length); // no scene was recorded twice
      expect(working.objects.get(scene1.audioKey)).toEqual(new Uint8Array(working.objects.get(scene1.audioKey)!));
      expect(sha(working.objects.get(scene1.audioKey)!)).toBe(scene1.audioSha256);
      // Try again counted nothing for scene 1: it already had its paid answer.
      expect(bundle.state.sends.filter((k) => k === scene1.cacheKey)).toHaveLength(1);
      // Several upload retries with backoff: 5 s is too tight when the machine is busy (2026-11-25).
    }, 20_000);
  });

  it("R2 refuses the upload (access denied) → the job ends at once (no step retries); Try again later uploads the saved bytes", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const bundle = fakeStore(events);
      const provider = { calls: 0 };
      const steps = retryingSteps(3);
      const refusing = fakeFiles((key) => (key.endsWith("audio.mp3") ? new StorageError("put", "access_denied", 403) : null));
      expect(await run(bundle, { files: () => refusing, voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root }, { step: steps })).toBe("failed");
      expect(steps.runs.get("speech-1")).toBe(1);
      expect(refusing.puts.filter((k) => k.endsWith("audio.mp3"))).toHaveLength(1);
      expect(bundle.state.ends.at(-1)).toMatchObject({ outcome: "failed", code: "INTERNAL", detail: "File storage refused the request (see the server log)" });
      expect(provider.calls).toBe(1);
      expect(await run(bundle, { files: sameFiles(fakeFiles()), voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root }, { attempt: 2 })).toBe("done");
      expect(provider.calls).toBe(scenesOf());
    });
  });

  it("another job of the same owner takes over a failed recording with a saved answer: it uploads the bytes, no call", async () => {
    await withTempDir(async (root) => {
      const first = fakeStore([]);
      const provider = { calls: 0 };
      await run(first, { files: sameFiles(fakeFiles((key) => (key.endsWith("audio.mp3") ? new StorageError("put", "access_denied", 403) : null))), voice: voiceWith(provider), render: fakeRenderer([], readyResult) as never, root });
      expect(provider.calls).toBe(1);
      const other = fakeStore([], { ready: first.speech }); // a different job, same owner, same recordings
      expect(await run(other, { files: sameFiles(fakeFiles()), voice: voiceWith(provider), render: fakeRenderer([], readyResult) as never, root })).toBe("done");
      expect(provider.calls).toBe(scenesOf());
      // The saved recording is free for the other job: its up-front reservation skipped it.
      expect(other.state.voice?.characters).toBeLessThan(first.state.voice!.characters);
    });
  });

  it("the job ends while a request is in flight (Cancel + the 60-second rule): the paid answer is still saved; the next job makes ZERO provider calls", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const bundle = fakeStore(events);
      const files = fakeFiles();
      const scenes = scenesOf();
      // The last scene's request is slow: the job is ended (its claims released) before ElevenLabs answers.
      const provider = {
        calls: 0,
        during: async (call: number) => {
          if (call === scenes) await bundle.store.end({ jobId: new ObjectId(bundle.jobId), attempt: 1, outcome: "cancelled" });
        },
      };
      expect(await run(bundle, { files: () => files, voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root })).toBe("skipped");
      expect(provider.calls).toBe(scenes);
      expect(events).toContain("save-answer-released");
      const last = [...bundle.speech.values()].at(-1)!;
      // Saved on the released recording (still `failed`, no claim): the answer and the paid bytes.
      expect(last).toMatchObject({ status: "failed", claim: null });
      expect(last.response).not.toBeNull();
      expect(savedAudioOf(last)).not.toBeNull();
      expect(bundle.state.usage.at(-1)).toMatchObject({ status: "final", outcome: "ok" });

      // "Generate video" again (attempt 2): the saved bytes are uploaded; nothing is sent or counted.
      const again: Events = [];
      const next = fakeStore(again, { ready: bundle.speech });
      provider.during = async () => undefined;
      expect(await run(next, { files: () => files, voice: voiceWith(provider), render: fakeRenderer(again, readyResult) as never, root }, { attempt: 2 })).toBe("done");
      expect(provider.calls).toBe(scenes);
      expect(next.state.sends).toHaveLength(0);
      expect(again).toContain("reserve:0");
      expect(sha(files.objects.get(last.audioKey)!)).toBe(last.audioSha256);
      expect(last.status).toBe("ready");
    });
  });

  it("while a request is in flight the scene's progress line is rewritten (heartbeat, same text) well inside the 60-second Cancel grace", async () => {
    expect(SPEECH_HEARTBEAT_MS * 2).toBeLessThan(GENERATE_CANCEL_GRACE_MS);
    await withTempDir(async (root) => {
      const bundle = fakeStore([]);
      const provider = { calls: 0, during: (call: number) => (call === 1 ? new Promise<void>((r) => setTimeout(r, 60)) : Promise.resolve()) };
      expect(await run(bundle, { files: sameFiles(fakeFiles()), voice: voiceWith(provider), render: fakeRenderer([], readyResult) as never, root, speechHeartbeatMs: 10 })).toBe("done");
      const scene1 = bundle.state.progress.filter((p) => p.message === recordingMessage(1, scenesOf()));
      expect(scene1.length).toBeGreaterThan(2); // the scene's own write + heartbeats while it was in flight
      expect(new Set(scene1.map((p) => JSON.stringify({ stage: p.stage, percent: p.percent, stages: p.stages ?? null }))).size).toBe(1);
      // Nothing else was written while recording: only the scenes' own lines.
      expect(bundle.state.progress.filter((p) => p.stage === "speech").every((p) => p.message.startsWith("Recording narration · scene "))).toBe(true);
    });
  });
});

describe("every ElevenLabs request is counted before it is sent (code review, finding 2) and logged in providerUsage (finding 5)", () => {
  const charactersOf = (requests: { text: string }[]) => requests.reduce((sum, r) => sum + countCharacters(r.text), 0);

  it("a 200 answer with bad JSON (may be billed) → PROVIDER_BUSY; Try again pays again and COUNTS again", async () => {
    await withTempDir(async (root) => {
      const bundle = fakeStore([]);
      const eleven = scriptedElevenLabs(["bad-json"]);
      expect(await run(bundle, { files: sameFiles(fakeFiles()), voice: eleven.voice, render: fakeRenderer([], readyResult) as never, root })).toBe("failed");
      expect(bundle.state.ends.at(-1)).toMatchObject({ code: "PROVIDER_BUSY" });
      expect(eleven.requests).toHaveLength(1);
      expect(await run(bundle, { files: sameFiles(fakeFiles()), voice: eleven.voice, render: fakeRenderer([], readyResult) as never, root }, { attempt: 2 })).toBe("done");
      expect(eleven.requests).toHaveLength(scenesOf() + 1);
      expect(bundle.state.sends).toHaveLength(eleven.requests.length);
      // Everything counted: the bad answer AND its new recording.
      expect(bundle.state.counted).toBe(charactersOf(eleven.requests));
      expect(bundle.state.usage).toHaveLength(eleven.requests.length);
      expect(bundle.state.usage[0]).toMatchObject({ status: "failed", outcome: "invalid_output" });
      expect(bundle.state.usage[0]!.characters).toBeGreaterThan(0);
      expect(bundle.state.usage.slice(1).every((u) => u.status === "final" && u.outcome === "ok")).toBe(true);
    });
  });

  it("timeouts (ElevenLabs may have done the work) → PROVIDER_BUSY after 3 requests; Try again's request is counted too", async () => {
    await withTempDir(async (root) => {
      const bundle = fakeStore([]);
      const eleven = scriptedElevenLabs(["timeout", "timeout", "timeout"]);
      expect(await run(bundle, { files: sameFiles(fakeFiles()), voice: eleven.voice, render: fakeRenderer([], readyResult) as never, root })).toBe("failed");
      expect(eleven.requests).toHaveLength(3);
      // All three requests were counted before they were sent (the first on the up-front reservation).
      expect(bundle.state.sends).toHaveLength(3);
      expect(await run(bundle, { files: sameFiles(fakeFiles()), voice: eleven.voice, render: fakeRenderer([], readyResult) as never, root }, { attempt: 2 })).toBe("done");
      expect(eleven.requests).toHaveLength(scenesOf() + 3);
      expect(bundle.state.sends).toHaveLength(eleven.requests.length);
      expect(bundle.state.counted).toBe(charactersOf(eleven.requests));
      // Each timed-out request is logged as a timeout WITH its characters (ElevenLabs may have billed it), retried ones too.
      expect(bundle.state.usage.slice(0, 3).map((u) => `${u.status}:${u.outcome}`)).toEqual(["failed:timeout", "failed:timeout", "failed:timeout"]);
      expect(bundle.state.usage.slice(0, 3).every((u) => u.characters > 0)).toBe(true);
      expect(bundle.state.usage.filter((u) => u.status === "reserved")).toHaveLength(0);
    });
  });

  it("a retried request is logged with its real outcome: busy (0 characters), timeout (its characters), then ok (second review, finding 4)", async () => {
    await withTempDir(async (root) => {
      const bundle = fakeStore([]);
      const eleven = scriptedElevenLabs(["busy", "timeout"]);
      expect(await run(bundle, { files: sameFiles(fakeFiles()), voice: eleven.voice, render: fakeRenderer([], readyResult) as never, root })).toBe("done");
      const scene1 = countCharacters(eleven.requests[0]!.text);
      expect(bundle.state.usage.slice(0, 3)).toEqual([
        { status: "failed", outcome: "busy", characters: 0 },
        { status: "failed", outcome: "timeout", characters: scene1 },
        { status: "final", outcome: "ok", characters: scene1 },
      ]);
    });
  });

  it("the model (or voice) changed between the reservation and the recording → a new recording, counted before it is sent", async () => {
    await withTempDir(async (root) => {
      const bundle = fakeStore([]);
      const model = { id: "eleven_model_a" };
      const eleven = scriptedElevenLabs([], model);
      const store: GenerateJobStore = {
        ...bundle.store,
        reserveVoice: async (input) => {
          const out = await bundle.store.reserveVoice(input);
          model.id = "eleven_model_b"; // the server's ELEVENLABS_MODEL changed right after reserving
          return out;
        },
      };
      expect(await run({ ...bundle, store }, { files: sameFiles(fakeFiles()), voice: eleven.voice, render: fakeRenderer([], readyResult) as never, root })).toBe("done");
      expect(eleven.requests.every((r) => r.model === "eleven_model_b")).toBe(true);
      expect(bundle.state.sends).toHaveLength(eleven.requests.length);
      // The model-A reservation covers nothing sent; every model-B request was counted on its own.
      expect(bundle.state.counted).toBe(2 * charactersOf(eleven.requests));
    });
  });

  it("the paid answer is saved BEFORE its usage row is finished; a failing usage write never loses it (second review, finding 3)", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const bundle = fakeStore(events);
      const store: GenerateJobStore = {
        ...bundle.store,
        finishUsage: async () => {
          events.push("usage-final");
          throw new Error("usage write failed");
        },
      };
      expect(await run({ ...bundle, store }, { files: sameFiles(fakeFiles()), voice: voiceWith({ calls: 0 }), render: fakeRenderer(events, readyResult) as never, root })).toBe("done");
      expect(events.indexOf("save-answer")).toBeGreaterThan(-1);
      expect(events.indexOf("save-answer")).toBeLessThan(events.indexOf("usage-final"));
    });
  });

  it("Cancel while a request is in flight: the provider's retry is NOT sent; the job ends as cancelled (second review, finding 5)", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const bundle = fakeStore(events);
      const eleven = scriptedElevenLabs(["busy"]);
      // The creator presses Cancel right after the first request went out; ElevenLabs answers "busy".
      const store: GenerateJobStore = {
        ...bundle.store,
        reserveVoiceSend: async (input) => {
          const out = await bundle.store.reserveVoiceSend(input);
          bundle.cancel();
          return out;
        },
      };
      expect(await run({ ...bundle, store }, { files: sameFiles(fakeFiles()), voice: eleven.voice, render: fakeRenderer(events, readyResult) as never, root })).toBe("cancelled");
      expect(eleven.requests).toHaveLength(1);
      expect(bundle.state.sends).toHaveLength(1);
      expect(events.at(-1)).toBe("end:cancelled:");
      expect(bundle.state.usage).toEqual([{ status: "failed", outcome: "busy", characters: 0 }]);
      expect([...bundle.speech.values()][0]).toMatchObject({ status: "failed", claim: null });

      // Cancel pressed just as the up-front reservation runs: refused too, the job ends as cancelled, nothing sent.
      const early: Events = [];
      const provider = { calls: 0 };
      expect(await run(fakeStore(early, { reserve: "cancelled" }), { files: sameFiles(fakeFiles()), voice: voiceWith(provider), render: fakeRenderer(early, readyResult) as never, root })).toBe("cancelled");
      expect(provider.calls).toBe(0);
      expect(early.at(-1)).toBe("end:cancelled:");
    });
  });

  it("ElevenLabs' own quota answer → 'Voice limit reached this month.' (retryable); the request was counted", async () => {
    await withTempDir(async (root) => {
      const bundle = fakeStore([]);
      const eleven = scriptedElevenLabs(["quota"]);
      expect(await run(bundle, { files: sameFiles(fakeFiles()), voice: eleven.voice, render: fakeRenderer([], readyResult) as never, root })).toBe("failed");
      expect(bundle.state.ends.at(-1)).toMatchObject({ code: "SPEND_CEILING" });
      expect(bundle.state.sends).toHaveLength(1);
      expect(bundle.state.usage[0]).toMatchObject({ status: "failed", outcome: "quota" });
    });
  });
});

describe("voice counting: credits, sends and months (pure, and in the database)", () => {
  const november = voicePeriodOf("Asia/Kolkata", NOW);
  const october = voicePeriodOf("Asia/Kolkata", new Date("2026-10-20T05:00:00.000Z"));
  const a = { cacheKey: "sha256:a", characters: 100 };
  const b = { cacheKey: "sha256:b", characters: 50 };

  it("the up-front reservation gives one credit per recording; a credit already held this month isn't counted again", () => {
    const first = planVoiceReservation(null, [a, b], november);
    expect(first).toMatchObject({ total: 150, next: { cacheKeys: ["sha256:a", "sha256:b"], characters: 150, period: november } });
    expect(planVoiceReservation(first.next, [a, b], november).total).toBe(0);
  });

  it("a send uses its credit once; the next send of the same recording is counted", () => {
    const reserved = planVoiceReservation(null, [a], november).next;
    const sent = planVoiceSend(reserved, a, november);
    expect(sent).toMatchObject({ count: 0, next: { cacheKeys: [], sentKeys: ["sha256:a"], characters: 100 } });
    expect(planVoiceSend(sent.next, a, november)).toMatchObject({ count: 100, next: { characters: 200, sentKeys: ["sha256:a"] } });
    expect(planVoiceSend(reserved, b, november).count).toBe(50); // not reserved (e.g. another model)
  });

  it("a reservation made last month covers nothing this month (finding 7): reserved and sent again are counted", () => {
    const old = planVoiceReservation(null, [a, b], october).next;
    expect(voiceCredits(old, november)).toEqual([]);
    expect(planVoiceReservation(old, [a, b], november)).toMatchObject({ total: 150, next: { cacheKeys: ["sha256:a", "sha256:b"], period: november } });
    expect(planVoiceSend(old, a, november).count).toBe(100);
  });

  it("reserveVoiceSend in the database: a credit → nothing counted; no credit → both counters, refused at the limit", async () => {
    const job = generateJob({ state: "running", voice: { cacheKeys: ["sha256:a"], characters: 100, sentKeys: [], period: november } });
    const withCredit = fakeDb({ "jobs.findOne": () => job, "jobs.updateOne": () => ({}) });
    expect(await reserveVoiceSend(withCredit.db, { jobId: job._id, attempt: 1, item: a, timezone: "Asia/Kolkata", now: NOW })).toBe("ok");
    expect(withCredit.names()).toEqual(["jobs.findOne", "jobs.updateOne"]);
    expect(withCredit.calls[1]!.args[1].$set.voice).toMatchObject({ cacheKeys: [], sentKeys: ["sha256:a"] });

    const counted = fakeDb({ "jobs.findOne": () => job, "jobs.updateOne": () => ({}), "usageCounters.findOneAndUpdate": (_f: unknown, u: { $inc: { count: number } }) => ({ count: 10 + u.$inc.count }) });
    expect(await reserveVoiceSend(counted.db, { jobId: job._id, attempt: 1, item: b, timezone: "Asia/Kolkata", now: NOW })).toBe("ok");
    expect(counted.names().filter((n) => n === "usageCounters.findOneAndUpdate")).toHaveLength(2);

    const full = fakeDb({ "jobs.findOne": () => job, "usageCounters.findOneAndUpdate": () => ({ count: 3001 }) });
    expect(await reserveVoiceSend(full.db, { jobId: job._id, attempt: 1, item: b, timezone: "Asia/Kolkata", now: NOW })).toBe("quota");
  });

  it("after Cancel nothing is sent or counted, not even with a credit (second review, finding 5)", async () => {
    const job = generateJob({ state: "running", cancelRequestedAt: NOW, voice: { cacheKeys: ["sha256:a"], characters: 100, sentKeys: [], period: november } });
    for (const item of [a, b]) {
      const cancelled = fakeDb({ "jobs.findOne": () => job });
      expect(await reserveVoiceSend(cancelled.db, { jobId: job._id, attempt: 1, item, timezone: "Asia/Kolkata", now: NOW })).toBe("cancelled");
      expect(cancelled.names()).toEqual(["jobs.findOne"]);
    }
  });
});

describe("waiting for a recording held by another run (code review, findings 9 and 10)", () => {
  it("waits with step.sleep (no retry used up), then records once the lock is free", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const bundle = fakeStore(events, { busyClaims: 3 });
      const steps = retryingSteps(3);
      const provider = { calls: 0 };
      expect(await run(bundle, { files: sameFiles(fakeFiles()), voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root }, { step: steps })).toBe("done");
      expect(steps.sleeps).toEqual(["speech-1-wait-1", "speech-1-wait-2", "speech-1-wait-3"]);
      expect([...steps.runs.values()].every((n) => n === 1)).toBe(true);
      expect(provider.calls).toBe(scenesOf());
    });
  });

  it("the waits outlast the lock's stale time; still locked after that → PROVIDER_BUSY (retryable), nothing paid", async () => {
    expect(SPEECH_BUSY_MAX_WAITS * SPEECH_BUSY_WAIT_MS).toBeGreaterThan(SPEECH_LOCK_STALE_MS);
    await withTempDir(async (root) => {
      const events: Events = [];
      const bundle = fakeStore(events, { busyClaims: 1000 });
      const provider = { calls: 0 };
      expect(await run(bundle, { files: sameFiles(fakeFiles()), voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root })).toBe("failed");
      expect(events.at(-1)).toBe("end:failed:PROVIDER_BUSY");
      expect(provider.calls).toBe(0);
    });
  });
});

describe("step ids (second review, finding 9)", () => {
  /** Records every step id in order: step.run and step.sleep share Inngest's id space. */
  function recordingSteps() {
    const inner = plainSteps();
    const ids: string[] = [];
    return { ids, sleeps: inner.sleeps, run: <T>(id: string, fn: () => Promise<T>) => (ids.push(id), inner.run(id, fn)), sleep: async (id: string) => void ids.push(id) };
  }
  /** Every scene's recording is held by another run for its first `busy` looks. */
  const busyFor = (bundle: ReturnType<typeof fakeStore>, busy: number): GenerateJobStore => {
    const looks = new Map<string, number>();
    return {
      ...bundle.store,
      claimSpeech: async (input) => {
        looks.set(input.cacheKey, (looks.get(input.cacheKey) ?? 0) + 1);
        return looks.get(input.cacheKey)! <= busy ? { kind: "busy", doc: {} as SpeechArtifactDocument } : bundle.store.claimSpeech(input);
      },
    };
  };
  const idsOf = async (root: string, scenario: "waits" | "gave-up" | "render-throws") => {
    const bundle = fakeStore([]);
    const steps = recordingSteps();
    const store = busyFor(bundle, scenario === "waits" ? 2 : scenario === "gave-up" ? 1000 : 0);
    const render = scenario === "render-throws" ? ((() => { throw new Error("renderer missing"); }) as never) : (fakeRenderer([], readyResult) as never);
    await run({ ...bundle, store }, { files: sameFiles(fakeFiles()), voice: voiceWith({ calls: 0 }), render, root }, { step: steps });
    return steps.ids;
  };

  it("are unique and the same on every run, including the lock-wait loop, giving up and the failure step", async () => {
    await withTempDir(async (root) => {
      const scenes = scenesOf();
      const waits = await idsOf(root, "waits");
      const perScene = (n: number) => [`speech-${n}`, `speech-${n}-wait-1`, `speech-${n}-again-1`, `speech-${n}-wait-2`, `speech-${n}-again-2`];
      expect(waits).toEqual(["start", "reserve-voice", ...Array.from({ length: scenes }, (_x, i) => perScene(i + 1)).flat(), "render"]);

      const gaveUp = await idsOf(root, "gave-up");
      const loop = Array.from({ length: SPEECH_BUSY_MAX_WAITS }, (_x, i) => [`speech-1-wait-${i + 1}`, `speech-1-again-${i + 1}`]).flat();
      expect(gaveUp).toEqual(["start", "reserve-voice", "speech-1", ...loop, "speech-1-gave-up"]);

      const failed = await idsOf(root, "render-throws");
      expect(failed).toEqual(["start", "reserve-voice", ...Array.from({ length: scenes }, (_x, i) => `speech-${i + 1}`), "render", "fail-internal"]);

      for (const [scenario, ids] of [["waits", waits], ["gave-up", gaveUp], ["render-throws", failed]] as const) {
        expect(new Set(ids).size).toBe(ids.length); // unique
        expect(await idsOf(root, scenario)).toEqual(ids); // deterministic: a replay asks for the same ids
      }
    });
  });
});

describe("the start step (code review, finding 4)", () => {
  it("R2 refusing the bucket check ends the job at once, before any cost (never left 'running')", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const files = { ...fakeFiles(), checkBucket: async () => Promise.reject(new StorageError("head", "access_denied", 403)) };
      const steps = retryingSteps(3);
      const provider = { calls: 0 };
      expect(await run(fakeStore(events), { files: () => files, voice: voiceWith(provider), render: fakeRenderer(events, readyResult) as never, root }, { step: steps })).toBe("failed");
      expect(steps.runs.get("start")).toBe(1);
      expect(events).toEqual(["start", "end:failed:INTERNAL"]);
      expect(provider.calls).toBe(0);
    });
  });

  it("a network problem in the bucket check is tried again, then the job FAILS (retryable) instead of staying 'running'", async () => {
    await withTempDir(async (root) => {
      const events: Events = [];
      const files = { ...fakeFiles(), checkBucket: async () => Promise.reject(new StorageError("head", "network", null)) };
      const steps = retryingSteps(3);
      expect(await run(fakeStore(events), { files: () => files, voice: voiceWith({ calls: 0 }), render: fakeRenderer(events, readyResult) as never, root }, { step: steps })).toBe("failed");
      expect(steps.runs.get("start")).toBe(4);
      expect(events.at(-1)).toBe("end:failed:INTERNAL");
      expect(GENERATE_ERRORS.INTERNAL.retryable).toBe(true);
    });
  });
});

// Keys are typed: make sure the fake store accepts what the worker passes.
void ((key: StorageKey) => key);
