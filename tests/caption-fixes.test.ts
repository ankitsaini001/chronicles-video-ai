import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  allowedActionsFor,
  canRetryCaptionJob,
  CAPTION_ERRORS,
  CAPTION_MESSAGES,
  CaptionOverridesBodySchema,
  captionJobKey,
  checkStuckJob,
  endCaptionJob,
  generateJobsAhead,
  isGenerateJobStuck,
  lastGenerateActivity,
  mergeCaptionOverrides,
  newCaptionJob,
  newGenerateJob,
  ProjectActionError,
  renderInputHash,
  retryCaptionJob,
  saveCaptionFixes,
  VIDEO_JOB_TYPES,
  type CaptionJobContext,
  type CaptionOverrideItem,
  type CaptionOverrideSetDocument,
  type JobDocument,
  type PlanVersionDocument,
  type ProjectDocument,
  type RenderDocument,
  type SpeechArtifactDocument,
  type StoredPlan,
} from "@bytereel/db";
import { StorageError, StorageKeys } from "@bytereel/storage";
import { type Db, ObjectId } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardStatus } from "../apps/web/lib/dashboard/cards";
import { ApiProblem } from "../apps/web/lib/api/v1";
import { captionPhrasesOf, checkCaptionFixes, renderDetail, type CaptionDeps } from "../apps/web/lib/video/captions";
import { FakeElevenLabsSpeech } from "../apps/web/lib/video/fake-elevenlabs";
import type { FileStore } from "../apps/web/lib/video/render-files";
import { captionPhaseProgress, runCaptionJob, type CaptionJobDeps, type CaptionJobStore } from "../apps/web/lib/video/run-caption-job";
import { captionSteps } from "../apps/web/lib/video/steps";
import { CaptionTrackSchema, type CaptionTrack, type Plan } from "../packages/pipeline/src/contracts";
import { hashPlan } from "../packages/pipeline/src/planning";
import { durationMessage, runRenderJob } from "../packages/pipeline/src/pipeline/render-job";
import type { RenderJob, RenderReport } from "../packages/pipeline/src/pipeline/render";
import { THUMBNAIL_SECONDS, type RenderJobResult, type RenderJobSpec } from "../packages/pipeline/src/pipeline/render-protocol";
import { cacheRecordFor, speechCacheKey, speechConfigFor, speechConfigFromRecord, speechRequestFor } from "../packages/pipeline/src/pipeline/speech";
import { ElevenLabsSpeech } from "../packages/pipeline/src/providers";
import {
  applyCaptionOverrides,
  captionFixProblem,
  CaptionOverrideError,
  compileTimeline,
  fixCaption,
  fixedCaptionLines,
  indexCaptions,
  renderedLineWidth,
  spreadWordTimes,
  synthesizeSceneAlignment,
} from "../packages/pipeline/src/timing";
import { CAPTION_STYLE } from "../packages/pipeline/src/theme";
import type { Mp4Probe } from "../packages/pipeline/src/validation";
import { validPlan, withTempDir } from "./helpers";

// F25 "Caption fixes": the F4 checks and transaction (ownership, phrases, "too long to fit", states,
// overrides adding up, NO usage counter), the word timing and line breaking of a fixed phrase, the
// caption worker (same narration, ZERO voice calls), the shared render queue and its stuck-job rule,
// allowedActions. Fakes only (no database, no network, no Remotion); tools/e2e/f25-captions.ts does
// a real render and upload with the stand-in voice.

const OWNER = new ObjectId("67330c1a9f1e4b2a7c0d1e01");
const OTHER = new ObjectId("67330c1a9f1e4b2a7c0d1e99");
const PROJECT = new ObjectId("67330d5e9f1e4b2a7c0d2a10");
const V1 = new ObjectId("67330e019f1e4b2a7c0d2b02");
const V2 = new ObjectId("67330e019f1e4b2a7c0d2b03");
const RENDER = new ObjectId("67330f109f1e4b2a7c0d6f01");
const OLD_RENDER = new ObjectId("67330f109f1e4b2a7c0d6f00");
const NOW = new Date("2026-11-16T05:00:00.000Z");
const ROOT = path.resolve(import.meta.dirname, "..");

const sha = (data: Uint8Array | string) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

function compiled(): { plan: Plan; track: CaptionTrack } {
  const plan = validPlan();
  const alignments = Object.fromEntries(plan.scenes.map((s) => [s.id, synthesizeSceneAlignment(s, plan.language)]));
  return { plan, track: compileTimeline({ plan, planHash: hashPlan(plan), alignments }).captions };
}

function projectDoc(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    _id: PROJECT,
    ownerId: OWNER,
    schemaVersion: 1,
    title: "How the water cycle works",
    language: "en",
    voiceGender: "female",
    input: { type: "topic", text: "How the water cycle works", brainstormChoice: null },
    state: "video_ready",
    currentPlanVersionId: V1,
    approvedPlanVersionId: V1,
    currentRenderId: RENDER,
    activeJobId: null,
    stateVersion: 7,
    planRequestCount: 1,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function renderDoc(overrides: Partial<RenderDocument> = {}): RenderDocument {
  return {
    _id: RENDER,
    ownerId: OWNER,
    projectId: PROJECT,
    schemaVersion: 1,
    planVersionId: V1,
    planHash: `sha256:${"a".repeat(64)}`,
    renderNumber: 1,
    speech: [],
    captionOverrideSetId: null,
    timelineKey: `users/${OWNER.toHexString()}/projects/${PROJECT.toHexString()}/renders/${RENDER.toHexString()}/timeline.json`,
    captionsKey: `users/${OWNER.toHexString()}/projects/${PROJECT.toHexString()}/renders/${RENDER.toHexString()}/captions.json`,
    mp4Key: `users/${OWNER.toHexString()}/projects/${PROJECT.toHexString()}/renders/${RENDER.toHexString()}/output.mp4`,
    thumbnailKey: `users/${OWNER.toHexString()}/projects/${PROJECT.toHexString()}/renders/${RENDER.toHexString()}/thumbnail.jpg`,
    qaKey: `users/${OWNER.toHexString()}/projects/${PROJECT.toHexString()}/renders/${RENDER.toHexString()}/qa.json`,
    previewFrameKeys: [],
    renderInputHash: `sha256:${"b".repeat(64)}`,
    mp4Sha256: `sha256:${"c".repeat(64)}`,
    qa: {},
    status: "ready",
    metrics: { renderMs: 1, bundleMs: 1, bytes: 10, durationMs: 70000, frames: 2100 },
    error: null,
    createdAt: NOW,
    readyAt: NOW,
    ...overrides,
  };
}

/**
 * A database that answers each "collection.method" with the given handler and records every call.
 * A call without a handler throws: a test fails if the code reads or writes what it shouldn't
 * (e.g. any `usageCounters` call).
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

async function refusal(promise: Promise<unknown>): Promise<ProjectActionError | ApiProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProjectActionError || error instanceof ApiProblem) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}
const statusOf = (e: ProjectActionError | ApiProblem) => (e instanceof ApiProblem ? e.status : ({ NOT_FOUND: 404, INVALID_INPUT: 400, LANGUAGE_UNAVAILABLE: 422, QUOTA_EXCEEDED: 429, SPEND_CEILING: 503 } as Record<string, number>)[e.code] ?? 409);

function captionDepsWith(track: CaptionTrack, options: { project?: ProjectDocument | null; render?: RenderDocument | null } = {}): CaptionDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    findProject: async (userId) => (userId === OWNER.toHexString() ? (options.project === undefined ? projectDoc() : options.project) : null),
    findRender: async (project) => (project.ownerId.equals(OWNER) ? (options.render === undefined ? renderDoc() : options.render) : null),
    readCaptions: async (key) => (reads.push(key), track),
    thumbnailUrl: async () => null,
  };
}

const body = (edits: { sceneId: string; phraseIndex: number; text: string }[], expectedStateVersion = 7) => CaptionOverridesBodySchema.parse({ edits, expectedStateVersion });

describe("F2 / F4: only the owner, and every fix is checked against THIS video's captions", () => {
  const { track } = compiled();
  const first = indexCaptions(track)[0]!;

  it("another user's project or video, a missing one → 404 (before the captions are read)", async () => {
    const deps = captionDepsWith(track);
    const asOther = await refusal(checkCaptionFixes(deps, OTHER.toHexString(), PROJECT.toHexString(), "current", body([{ sceneId: first.sceneId, phraseIndex: 0, text: "Hello there" }])));
    expect(asOther).toBeInstanceOf(ApiProblem);
    expect(statusOf(asOther)).toBe(404);
    const noVideo = await refusal(checkCaptionFixes(captionDepsWith(track, { render: null }), OWNER.toHexString(), PROJECT.toHexString(), RENDER.toHexString(), body([{ sceneId: first.sceneId, phraseIndex: 0, text: "Hello there" }])));
    expect(statusOf(noVideo)).toBe(404);
    expect((noVideo as ApiProblem).message).toBe("We couldn't find this video.");
    expect(statusOf(await refusal(renderDetail(deps, OTHER.toHexString(), PROJECT.toHexString(), "current")))).toBe(404);
    expect(deps.reads).toEqual([]);
  });

  it("F2 lists every phrase with its place in its scene (from 0), times in ms, and its fix", async () => {
    const detail = await renderDetail(captionDepsWith(track), OWNER.toHexString(), PROJECT.toHexString(), "current");
    expect(detail.id).toBe(RENDER.toHexString());
    expect(detail.captions).toHaveLength(track.captions.length);
    expect(detail.captions[0]).toMatchObject({ sceneId: first.sceneId, phraseIndex: 0, text: first.caption.text, originalText: first.caption.text, overridden: false, startMs: Math.round((first.caption.startFrame * 1000) / 30) });
    const perScene = new Map<string, number[]>();
    for (const c of detail.captions) perScene.set(c.sceneId, [...(perScene.get(c.sceneId) ?? []), c.phraseIndex]);
    for (const indexes of perScene.values()) expect(indexes).toEqual(indexes.map((_x, i) => i));
    const fixed = { ...track, captions: track.captions.map((c, i) => (i === 0 ? fixCaption(c, "Ever wondered about rain?") : c)) };
    expect(captionPhrasesOf(fixed)[0]).toMatchObject({ text: "Ever wondered about rain?", originalText: first.caption.text, overridden: true });
  });

  it("an unknown phrase or scene → 400 with the path", async () => {
    const problem = await refusal(checkCaptionFixes(captionDepsWith(track), OWNER.toHexString(), PROJECT.toHexString(), "current", body([{ sceneId: first.sceneId, phraseIndex: 99, text: "Hi" }, { sceneId: "no-such-scene", phraseIndex: 0, text: "Hi" }])));
    expect(statusOf(problem)).toBe(400);
    const issues = (problem as ApiProblem).details?.issues as { path: string; message: string }[];
    expect(issues.map((i) => i.path)).toEqual(["edits[0].phraseIndex", "edits[1].phraseIndex"]);
    expect(issues[0]!.message).toMatch(/has phrases 0-\d+; 99 does not exist/);
  });

  it("duplicate pairs, empty text and text over 200 characters → 400 (the strict body)", () => {
    const pair = { sceneId: first.sceneId, phraseIndex: 0 };
    const dup = CaptionOverridesBodySchema.safeParse({ edits: [{ ...pair, text: "a" }, { ...pair, text: "b" }], expectedStateVersion: 7 });
    expect(dup.success).toBe(false);
    expect(dup.error?.issues[0]).toMatchObject({ path: ["edits", 1, "phraseIndex"], message: "this caption is listed twice" });
    expect(CaptionOverridesBodySchema.safeParse({ edits: [{ ...pair, text: "  \u200B \n " }], expectedStateVersion: 7 }).success).toBe(false);
    expect(CaptionOverridesBodySchema.safeParse({ edits: [{ ...pair, text: "x".repeat(201) }], expectedStateVersion: 7 }).success).toBe(false);
    expect(CaptionOverridesBodySchema.safeParse({ edits: [], expectedStateVersion: 7 }).success).toBe(false);
    expect(CaptionOverridesBodySchema.safeParse({ edits: [{ ...pair, text: "ok", extra: 1 }], expectedStateVersion: 7 }).success).toBe(false);
    // Cleaned like narration: control and invisible characters out, single spaces, trimmed.
    expect(body([{ ...pair, text: "  NPCI\u200B  —\tthe   switch " }]).edits[0]!.text).toBe("NPCI — the switch");
  });

  it("'too long to fit' → 400 'This caption is too long to fit on screen. Please shorten it.' with the path", async () => {
    const long = "This is a much longer caption that will never fit on two lines of the video";
    const problem = await refusal(checkCaptionFixes(captionDepsWith(track), OWNER.toHexString(), PROJECT.toHexString(), "current", body([{ sceneId: first.sceneId, phraseIndex: 0, text: long }])));
    expect(statusOf(problem)).toBe(400);
    expect(problem.message).toBe("This caption is too long to fit on screen. Please shorten it.");
    expect((problem as ApiProblem).details?.issues).toEqual([{ path: "edits[0].text", message: CAPTION_MESSAGES.TOO_LONG }]);
  });

  it("not the project's video, not video_ready, a job running, another tab, archived → refused (409); Hindi → 422", async () => {
    const fix = body([{ sceneId: first.sceneId, phraseIndex: 0, text: "Hello there" }]);
    const run = (project: ProjectDocument, render = renderDoc()) => refusal(checkCaptionFixes(captionDepsWith(track, { project, render }), OWNER.toHexString(), PROJECT.toHexString(), RENDER.toHexString(), fix));
    const notCurrent = await run(projectDoc({ currentRenderId: OLD_RENDER }));
    expect([statusOf(notCurrent), (notCurrent as ProjectActionError).code]).toEqual([409, "INVALID_STATE"]);
    expect((notCurrent as ProjectActionError).details).toMatchObject({ reason: "not_current" });
    expect((await run(projectDoc({ state: "storyboard_ready" })) as ProjectActionError).code).toBe("INVALID_STATE");
    expect((await run(projectDoc({ state: "generating", activeJobId: new ObjectId() })) as ProjectActionError).code).toBe("JOB_ALREADY_RUNNING");
    expect((await run(projectDoc({ stateVersion: 8 })) as ProjectActionError).code).toBe("STALE_VERSION");
    expect((await run(projectDoc({ state: "archived" })) as ProjectActionError).code).toBe("INVALID_STATE");
    expect((await run(projectDoc({ language: "hi" })) as ProjectActionError).code).toBe("LANGUAGE_UNAVAILABLE");
  });

  it("a good fix comes back with the phrase's compiled text (the render checks it)", async () => {
    const out = await checkCaptionFixes(captionDepsWith(track), OWNER.toHexString(), PROJECT.toHexString(), "current", body([{ sceneId: first.sceneId, phraseIndex: 0, text: "Ever wondered about rain?" }]));
    expect(out.edits).toEqual([{ sceneId: first.sceneId, phraseIndex: 0, text: "Ever wondered about rain?", originalText: first.caption.text }]);
  });
});

describe("F4 transaction: the override set, the caption job, NO usage counter", () => {
  const edit = (phraseIndex: number, text: string, originalText = `original ${phraseIndex}`): CaptionOverrideItem => ({ sceneId: "scene-hook", phraseIndex, text, originalText });

  it("overrides add up across saves; a later edit of the same phrase replaces the earlier one; back to the original removes it", () => {
    const first = mergeCaptionOverrides([], [edit(0, "A"), edit(2, "C")]);
    expect(first).toEqual([edit(0, "A"), edit(2, "C")]);
    const second = mergeCaptionOverrides(first, [edit(2, "C2"), edit(3, "D")]);
    expect(second).toEqual([edit(0, "A"), edit(2, "C2"), edit(3, "D")]);
    // The fix keeps the phrase's compiled text even when the second edit was made on the fixed video.
    expect(mergeCaptionOverrides(first, [edit(0, "A2", "A")])).toEqual([edit(0, "A2"), edit(2, "C")]);
    expect(mergeCaptionOverrides(second, [edit(0, "original 0", "A")])).toEqual([edit(2, "C2"), edit(3, "D")]);
  });

  function saving(options: { project?: ProjectDocument; render?: RenderDocument; previous?: CaptionOverrideSetDocument | null; moved?: boolean } = {}) {
    const project = options.project ?? projectDoc();
    const writes: { set?: CaptionOverrideSetDocument; job?: JobDocument; project?: any } = {};
    const fake = fakeDb({
      "projects.findOne": () => project,
      "renders.findOne": () => options.render ?? renderDoc(),
      "captionOverrides.findOne": () => options.previous ?? null,
      "captionOverrides.insertOne": (doc: CaptionOverrideSetDocument) => void (writes.set = doc),
      "jobs.insertOne": (doc: JobDocument) => void (writes.job = doc),
      "projects.findOneAndUpdate": (_f: unknown, update: any) => ((writes.project = update), options.moved === false ? null : { ...project, ...update.$set, stateVersion: project.stateVersion + 1 }),
    });
    const run = (edits: CaptionOverrideItem[], expectedStateVersion = 7) =>
      saveCaptionFixes(fake.db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), renderId: "current", expectedStateVersion, edits, respond: () => ({ status: 202, body: {} }), now: NOW });
    return { ...fake, writes, run };
  }

  it("ONE transaction: a new set (previous fixes of the same version + these), a queued caption job (cap:{setId}), project → generating", async () => {
    const previousSet: CaptionOverrideSetDocument = { _id: new ObjectId(), ownerId: OWNER, projectId: PROJECT, schemaVersion: 1, basePlanVersionId: V1, baseRenderId: OLD_RENDER, overrides: [edit(0, "A")], createdAt: NOW };
    const s = saving({ render: renderDoc({ captionOverrideSetId: previousSet._id }), previous: previousSet });
    const out = await s.run([edit(1, "B")]);
    expect(s.writes.set).toMatchObject({ basePlanVersionId: V1, baseRenderId: RENDER, overrides: [edit(0, "A"), edit(1, "B")] });
    expect(out.job).toMatchObject({ type: "caption", state: "queued", attempt: 1, idempotencyKey: captionJobKey(out.set._id), event: { id: captionJobKey(out.set._id) } });
    expect(out.job.inputRef).toEqual({ planVersionId: V1, renderId: RENDER, captionOverrideSetId: out.set._id });
    expect(out.job.stages.map((x) => x.name)).toEqual(["compile", "render", "validate"]);
    expect(out.job.progress.message).toBe("Waiting to start…");
    expect(s.writes.project.$set).toMatchObject({ state: "generating", activeJobId: out.job._id });
    // The video stays the project's video until the fixed one is ready.
    expect(s.writes.project.$set).not.toHaveProperty("currentRenderId");
    // The update only matches the exact project the checks saw.
    expect(s.calls.find((c) => c.name === "projects.findOneAndUpdate")!.args[0]).toMatchObject({ stateVersion: 7, activeJobId: null, state: "video_ready", currentRenderId: RENDER });
  });

  it("no usage counters change: no videos/day, no voice characters (any usageCounters call would fail this test)", async () => {
    const s = saving();
    await s.run([edit(0, "A")]);
    expect(s.names().some((n) => n.startsWith("usageCounters") || n.startsWith("providerUsage") || n.startsWith("speechArtifacts"))).toBe(false);
    expect(s.names()).toEqual(["projects.findOne", "renders.findOne", "captionOverrides.insertOne", "jobs.insertOne", "projects.findOneAndUpdate"]);
  });

  it("fixes of ANOTHER storyboard version are not carried over (they belong to their version)", async () => {
    const oldSet: CaptionOverrideSetDocument = { _id: new ObjectId(), ownerId: OWNER, projectId: PROJECT, schemaVersion: 1, basePlanVersionId: V2, baseRenderId: OLD_RENDER, overrides: [edit(0, "A")], createdAt: NOW };
    const s = saving({ render: renderDoc({ captionOverrideSetId: oldSet._id }), previous: oldSet });
    await s.run([edit(1, "B")]);
    expect(s.writes.set!.overrides).toEqual([edit(1, "B")]);
  });

  it("re-checked inside the transaction: not current / wrong state / a job running → 409; nothing written", async () => {
    for (const project of [projectDoc({ currentRenderId: OLD_RENDER }), projectDoc({ state: "generate_failed" }), projectDoc({ activeJobId: new ObjectId() })]) {
      const s = saving({ project });
      const error = await refusal(s.run([edit(0, "A")]));
      expect(statusOf(error)).toBe(409);
      expect(s.names().filter((n) => n.endsWith("insertOne") || n.endsWith("findOneAndUpdate"))).toEqual([]);
    }
  });

  it("nothing changed (the same text as now) → 400, nothing written; another tab won the race → 409 STALE_VERSION", async () => {
    const s = saving();
    const same = await refusal(s.run([edit(0, "original 0")]));
    expect([statusOf(same), same.message]).toEqual([400, "These captions already read like this."]);
    expect(s.names()).not.toContain("jobs.insertOne");
    expect((await refusal(saving({ moved: false }).run([edit(0, "A")])) as ProjectActionError).code).toBe("STALE_VERSION");
  });
});

describe("a fixed phrase: same span, new word times, the compiler's line breaking", () => {
  const { track } = compiled();
  const captions = indexCaptions(track);

  it("word times: the same phrase span, monotonic, no gaps or overlaps, proportional to length", () => {
    const times = spreadWordTimes(["a", "evaporation", "is", "fast."], 100, 160);
    expect(times[0]!.startFrame).toBe(100);
    expect(times.at(-1)!.endFrame).toBe(160);
    for (let i = 0; i < times.length; i++) {
      expect(times[i]!.endFrame).toBeGreaterThan(times[i]!.startFrame);
      if (i > 0) expect(times[i]!.startFrame).toBe(times[i - 1]!.endFrame);
    }
    const lengths = times.map((t) => t.endFrame - t.startFrame);
    expect(lengths[1]).toBeGreaterThan(lengths[0]!);
    expect(lengths[1]).toBeGreaterThan(lengths[3]!);
    // Every word gets at least one frame even in a short span.
    const tight = spreadWordTimes(["a", "b", "c"], 10, 13);
    expect(tight.map((t) => [t.startFrame, t.endFrame])).toEqual([[10, 11], [11, 12], [12, 13]]);
  });

  it("every fixed phrase keeps its start/end frame and stays inside its words' span: no overlap with the neighbours", () => {
    for (const [i, { caption }] of captions.entries()) {
      const fixed = fixCaption(caption, "Fixed words here.");
      expect([fixed.startFrame, fixed.endFrame]).toEqual([caption.startFrame, caption.endFrame]);
      expect(fixed.words[0]!.startFrame).toBe(Math.min(...caption.words.map((w) => w.startFrame)));
      expect(fixed.words.at(-1)!.endFrame).toBe(Math.max(...caption.words.map((w) => w.endFrame)));
      const previous = captions[i - 1]?.caption;
      const next = captions[i + 1]?.caption;
      if (previous && previous.sceneId === caption.sceneId) expect(fixed.words[0]!.startFrame).toBeGreaterThanOrEqual(previous.words.at(-1)!.endFrame - 1);
      if (next && next.sceneId === caption.sceneId) expect(fixed.words.at(-1)!.endFrame).toBeLessThanOrEqual(next.words[0]!.startFrame + 1);
    }
  });

  it("lines are re-broken with the compiler's rule (1 or 2 lines, joined they are the text) at the normal size", () => {
    const { caption } = captions[0]!;
    const one = fixCaption({ ...caption, fontSizePx: 50 }, "Rain falls fast.");
    expect(one.lines).toEqual(["Rain falls fast."]);
    expect(one).not.toHaveProperty("fontSizePx");
    const two = fixCaption(caption, "Where does rain come from?");
    expect(two.lines).toHaveLength(2);
    expect(two.lines.join(" ")).toBe(two.text);
    expect(two.words.map((w) => w.text).join(" ")).toBe(two.text);
    expect(two.originalText).toBe(caption.text);
    expect(() => CaptionTrackSchema.parse({ ...track, captions: [two] })).not.toThrow();
  });

  it("'fits on screen' is the compiler's breakLines plus the real drawn width (ExtraBold, pill padding, gaps)", () => {
    expect(fixedCaptionLines("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen")).toBeNull();
    expect(fixedCaptionLines("Supercalifragilisticexpialidocious-ness")).toBeNull();
    // A line that passes the estimate but is wider than the box once drawn (ExtraBold, a pill's
    // padding per word, the gaps) is refused too (with today's 650/850 px this is a safety net).
    expect(fixedCaptionLines("WWWWWWW WWWW")).toEqual([["WWWWWWW"], ["WWWW"]]);
    expect(renderedLineWidth(["WWWWWWW", "WWWW"])).toBeGreaterThan(CAPTION_STYLE.boxWidth);
    expect(fixedCaptionLines("WWWWWWW WWWW", { fontSizePx: CAPTION_STYLE.fontSizePx, maxLineWidthPx: 800 })).toBeNull();
    // Every caption the compiler made fits by this rule too (an unchanged phrase is never "too long").
    for (const { caption } of captions) {
      expect(fixedCaptionLines(caption.text) === null && caption.fontSizePx === undefined).toBe(false);
      if (caption.fontSizePx === undefined) for (const line of caption.lines) expect(renderedLineWidth(line.split(" "))).toBeLessThanOrEqual(CAPTION_STYLE.boxWidth);
    }
    expect(captionFixProblem(captions[0]!.caption, "Short fix")).toBeNull();
  });

  it("key-term highlighting is kept only for words that still match", () => {
    const caption = { ...captions[0]!.caption, words: captions[0]!.caption.words.map((w, i) => ({ ...w, key: i === 1 })) };
    const keyWord = caption.words[1]!.text.replace(/[^\p{L}\p{N}]/gu, "");
    const fixed = fixCaption(caption, `The ${keyWord.toUpperCase()}, and more`);
    expect(fixed.words.filter((w) => w.key).map((w) => w.text)).toEqual([`${keyWord.toUpperCase()},`]);
    expect(fixCaption(caption, "Nothing matches here").words.some((w) => w.key)).toBe(false);
  });

  it("applyCaptionOverrides: only the named phrases change; a stale or unknown fix is refused (never put on the wrong phrase)", () => {
    const target = captions[3]!;
    const out = applyCaptionOverrides(track, [{ sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: "NPCI is the switch.", originalText: target.caption.text }]);
    expect(out.captions[3]!.text).toBe("NPCI is the switch.");
    expect(out.captions.filter((_c, i) => i !== 3)).toEqual(track.captions.filter((_c, i) => i !== 3));
    expect(() => applyCaptionOverrides(track, [{ sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: "x y", originalText: "something else" }])).toThrow(CaptionOverrideError);
    expect(() => applyCaptionOverrides(track, [{ sceneId: target.sceneId, phraseIndex: 99, text: "x y", originalText: "z" }])).toThrow(CaptionOverrideError);
  });
});

// ---------- the caption worker ----------

const goodProbe = (frames: number): Mp4Probe => ({ codec: "h264", width: 1080, height: 1920, frameRate: "30/1", decodedFrames: frames, durationSeconds: frames / 30, pixelFormat: "yuv420p", audioStreams: 1, audioCodec: "aac", audioDurationSeconds: frames / 30, audioSampleRate: 48000 });

function fakeFiles(): FileStore & { objects: Map<string, Uint8Array>; puts: string[] } {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    objects,
    puts,
    checkBucket: async () => undefined,
    put: async (key, data, options) => {
      puts.push(key);
      const bytes = typeof data === "string" ? new Uint8Array(Buffer.from(data)) : data;
      if (options?.createOnly && objects.has(key)) throw new StorageError("put", "already_exists", 412);
      objects.set(key, bytes);
      return { key, sha256: sha(bytes), bytes: bytes.byteLength };
    },
    get: async (key) => objects.get(key) ?? null,
    head: async (key) => (objects.has(key) ? { key, sha256: sha(objects.get(key)!), bytes: objects.get(key)!.byteLength, contentType: null, lastModified: null } : null) as never,
  };
}

/** The video the creator fixes: recorded with the stand-in voice, its files in the fake R2. */
async function recordedVideo() {
  const plan = validPlan();
  const config = speechConfigFor(plan, "e2eStandInFemale", "e2e_stand_in");
  const files = fakeFiles();
  const docs: SpeechArtifactDocument[] = [];
  for (const [i, scene] of plan.scenes.entries()) {
    const request = speechRequestFor(plan, i, config);
    const response = await new FakeElevenLabsSpeech("en").synthesize(request);
    const cacheKey = speechCacheKey(scene, config);
    const record = cacheRecordFor(cacheKey, request, response, NOW);
    const audioKey = StorageKeys.speechAudio(OWNER.toHexString(), cacheKey);
    const alignmentKey = StorageKeys.speechAlignment(OWNER.toHexString(), cacheKey);
    files.objects.set(audioKey, response.audio);
    files.objects.set(alignmentKey, new Uint8Array(Buffer.from(JSON.stringify(record))));
    docs.push({ _id: new ObjectId(), ownerId: OWNER, schemaVersion: 1, cacheKey, sceneId: scene.id, firstProjectId: PROJECT, voiceId: config.voiceId, model: config.modelId, settings: { ...config.settings }, audioKey, alignmentKey, normalizedAlignmentKey: StorageKeys.speechNormalizedAlignment(OWNER.toHexString(), cacheKey), durationMs: 1000, characters: 10, audioSha256: record.audioSha256, status: "ready", claim: null, response: null, paidByJobId: null, error: null, createdAt: NOW, updatedAt: NOW, readyAt: NOW });
  }
  const render = renderDoc({ speech: docs.map((d) => ({ sceneId: d.sceneId, speechArtifactId: d._id })) });
  const version = { _id: V1, ownerId: OWNER, projectId: PROJECT, schemaVersion: 1, versionNumber: 1, parentVersionId: null, source: "ai_plan", plan: plan as unknown as StoredPlan, planHash: hashPlan(plan), validation: { valid: true, issues: [], warnings: [] }, stats: { sceneCount: plan.scenes.length, wordCount: 1, estimatedSeconds: 70 }, plannerUsage: null, createdAt: NOW } as unknown as PlanVersionDocument;
  return { plan, config, files, docs, render, version };
}

function captionStore(video: Awaited<ReturnType<typeof recordedVideo>>, events: string[], options: { cancel?: boolean } = {}) {
  const set: CaptionOverrideSetDocument = { _id: new ObjectId(), ownerId: OWNER, projectId: PROJECT, schemaVersion: 1, basePlanVersionId: V1, baseRenderId: RENDER, overrides: [{ sceneId: video.plan.scenes[0]!.id, phraseIndex: 0, text: "Fixed caption words.", originalText: "unchecked here" }], createdAt: NOW };
  const job = newCaptionJob({ ownerId: OWNER, projectId: PROJECT, render: video.render, set, now: NOW });
  const ctx = (): CaptionJobContext => ({ job: { ...job, state: "running", cancelRequestedAt: options.cancel ? NOW : null }, project: projectDoc({ state: "generating", activeJobId: job._id }), version: video.version, baseRender: video.render, set });
  const saved: Parameters<CaptionJobStore["complete"]>[0][] = [];
  const ends: Parameters<CaptionJobStore["end"]>[0][] = [];
  const store: CaptionJobStore = {
    start: async () => (events.push("start"), ctx()),
    load: async () => ctx(),
    speechByIds: async (ownerId, ids) => video.docs.filter((d) => d.ownerId.equals(ownerId) && ids.some((id) => id.equals(d._id))),
    progress: async () => ({ cancelRequested: false }),
    beginRender: async () => (events.push("begin-render"), { cancelRequested: false }),
    complete: async (input) => (events.push("complete"), saved.push(input), true),
    end: async (input) => (events.push(`end:${input.outcome}:${input.code ?? ""}`), ends.push(input), true),
  };
  return { store, job, set, saved, ends };
}

async function readyResult(spec: RenderJobSpec): Promise<RenderJobResult> {
  const out = path.join(spec.workDir, "out");
  await mkdir(out, { recursive: true });
  const files = { video: path.join(out, "output.mp4"), thumbnail: path.join(out, "thumbnail.jpg"), timeline: path.join(out, "timeline.json"), captions: path.join(out, "captions.json"), qa: path.join(out, "qa.json") };
  for (const [name, file] of Object.entries(files)) await writeFile(file, `${name} bytes`);
  return { status: "ready", files, qa: { sha256: sha("video bytes"), ok: true } as never, durationMs: 70000, frames: 2100, renderMs: 1, bundleMs: 1 };
}

const quiet = { log: () => undefined, sleep: async () => undefined };
const steps = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };

describe("the caption worker: the SAME narration, zero voice calls", () => {
  afterEach(() => vi.restoreAllMocks());

  it("cannot reach the voice provider: a throwing provider is injected and NEVER called; the module imports no voice code", async () => {
    await withTempDir(async (root) => {
      const video = await recordedVideo();
      // Any voice request from here on would throw AND be counted.
      const voiceCalls = { real: 0, standIn: 0, injected: 0 };
      vi.spyOn(ElevenLabsSpeech.prototype, "synthesize").mockImplementation(async () => {
        voiceCalls.real++;
        throw new Error("ElevenLabs must never be called by a caption fix");
      });
      vi.spyOn(FakeElevenLabsSpeech.prototype, "synthesize").mockImplementation(async () => {
        voiceCalls.standIn++;
        throw new Error("the stand-in voice must never be called by a caption fix");
      });
      const throwingVoice = () => ({ ok: true, fake: false, configFor: () => video.config, provider: () => ({ name: "throwing", synthesize: async () => (voiceCalls.injected++, Promise.reject(new Error("no voice calls"))) }) });
      const events: string[] = [];
      const bundle = captionStore(video, events);
      let seen: RenderJobSpec | undefined;
      const deps = {
        ...quiet,
        store: bundle.store,
        files: () => video.files,
        render: ((spec: RenderJobSpec) => ((seen = spec), { result: readyResult(spec), cancel: () => undefined })) as unknown as CaptionJobDeps["render"],
        root,
        voice: throwingVoice, // not part of CaptionJobDeps: the worker has nowhere to call it from
      };
      const outcome = await runCaptionJob({ event: { jobId: bundle.job._id.toHexString(), attempt: 1 }, runId: null, step: steps }, deps as CaptionJobDeps);
      expect(outcome).toBe("done");
      expect(voiceCalls).toEqual({ real: 0, standIn: 0, injected: 0 });
      // The store the worker gets has no way to count or reserve voice characters.
      expect(Object.keys(bundle.store).sort()).toEqual(["beginRender", "complete", "end", "load", "progress", "speechByIds", "start"]);
      // The worker module imports nothing that can record narration.
      const source = readFileSync(path.join(ROOT, "apps/web/lib/video/run-caption-job.ts"), "utf8");
      const imports = [...source.matchAll(/^import[^;]*?from "([^"]+)";/gms)].map((m) => m[1]);
      expect(imports.some((m) => /voice|fake-elevenlabs|run-generate-job|providers|generate-video/.test(m!))).toBe(false);
      // The render used the recordings exactly as saved, the fixes, the same style and music.
      expect(seen!.scenes.map((s) => s.record.audioSha256)).toEqual(video.docs.map((d) => d.audioSha256));
      expect(seen!.captionOverrides).toEqual(bundle.set.overrides);
      expect(seen!.music).toBe(true);
      expect(seen!.thumbnailSeconds).toBe(THUMBNAIL_SECONDS);
      expect(seen!.speechConfig).toEqual(video.config);
    });
  });

  it("uploads create-only under a NEW renderId and saves the video with the same recordings; cleans its work folder", async () => {
    await withTempDir(async (root) => {
      const video = await recordedVideo();
      const events: string[] = [];
      const bundle = captionStore(video, events);
      let seen: RenderJobSpec | undefined;
      const render = ((spec: RenderJobSpec) => ((seen = spec), { result: readyResult(spec), cancel: () => undefined })) as unknown as CaptionJobDeps["render"];
      expect(await runCaptionJob({ event: { jobId: bundle.job._id.toHexString(), attempt: 1 }, runId: null, step: steps }, { ...quiet, store: bundle.store, files: () => video.files, render, root })).toBe("done");
      expect(events).toEqual(["start", "begin-render", "complete"]);
      const saved = bundle.saved[0]!.render;
      expect(saved.renderId.equals(RENDER)).toBe(false);
      expect(saved.speech).toEqual(video.render.speech);
      expect(saved.cacheKeys).toEqual(video.docs.map((d) => d.cacheKey));
      const uploads = video.files.puts.filter((k) => k.includes("/renders/"));
      expect(uploads.map((k) => k.split("/").pop()).sort()).toEqual(["captions.json", "output.mp4", "qa.json", "thumbnail.jpg", "timeline.json"]);
      expect(uploads.every((k) => k.includes(`/renders/${saved.renderId.toHexString()}/`))).toBe(true);
      expect(saved.mp4Sha256).toBe(sha("video bytes"));
      expect(existsSync(seen!.workDir)).toBe(false);
      expect(seen!.workDir.startsWith(path.join(root, "runs", ".tmp", "generate"))).toBe(true);
    });
  });

  it("narration missing or changed → fails with a plain message (not retryable); nothing is recorded or rendered", async () => {
    await withTempDir(async (root) => {
      for (const breakIt of [(v: Awaited<ReturnType<typeof recordedVideo>>) => v.files.objects.delete(v.docs[2]!.audioKey), (v: Awaited<ReturnType<typeof recordedVideo>>) => v.files.objects.set(v.docs[1]!.audioKey, new Uint8Array([1, 2, 3])), (v: Awaited<ReturnType<typeof recordedVideo>>) => void (v.docs[0]!.status = "failed")]) {
        const video = await recordedVideo();
        breakIt(video);
        const events: string[] = [];
        const bundle = captionStore(video, events);
        const synth = vi.spyOn(FakeElevenLabsSpeech.prototype, "synthesize");
        const outcome = await runCaptionJob({ event: { jobId: bundle.job._id.toHexString(), attempt: 1 }, runId: null, step: steps }, { ...quiet, store: bundle.store, files: () => video.files, render: (() => events.push("render")) as never, root });
        expect(outcome).toBe("failed");
        expect(events).not.toContain("render");
        expect(events.at(-1)).toBe("end:failed:NARRATION_MISSING");
        expect(synth).not.toHaveBeenCalled();
        synth.mockRestore();
      }
      expect(CAPTION_ERRORS.NARRATION_MISSING.retryable).toBe(false);
    });
  });

  it("a render error → RENDER_FAILED (retryable), only a fixed line stored; Cancel → cancelled before the render", async () => {
    await withTempDir(async (root) => {
      const video = await recordedVideo();
      const events: string[] = [];
      const bundle = captionStore(video, events);
      const render = (() => ({ result: Promise.resolve({ status: "failed", stage: "render", detail: "Error: chrome crashed at /secret/path" }), cancel: () => undefined })) as unknown as CaptionJobDeps["render"];
      expect(await runCaptionJob({ event: { jobId: bundle.job._id.toHexString(), attempt: 1 }, runId: null, step: steps }, { ...quiet, store: bundle.store, files: () => video.files, render, root })).toBe("failed");
      expect(bundle.ends[0]).toMatchObject({ outcome: "failed", code: "RENDER_FAILED" });
      expect(JSON.stringify(bundle.ends)).not.toContain("chrome crashed");
      expect(CAPTION_ERRORS.RENDER_FAILED.retryable).toBe(true);

      const cancelled: string[] = [];
      const c = captionStore(video, cancelled, { cancel: true });
      expect(await runCaptionJob({ event: { jobId: c.job._id.toHexString(), attempt: 1 }, runId: null, step: steps }, { ...quiet, store: c.store, files: () => video.files, render: (() => cancelled.push("render")) as never, root })).toBe("cancelled");
      expect(cancelled).not.toContain("render");
    });
  });

  it("the narration's voice setup comes from its saved request, and must give the same cache key", async () => {
    const video = await recordedVideo();
    const record = JSON.parse(Buffer.from(video.files.objects.get(video.docs[0]!.alignmentKey)!).toString());
    const config = speechConfigFromRecord(video.plan, record);
    expect(config).toEqual(video.config);
    expect(speechCacheKey(video.plan.scenes[0]!, config)).toBe(video.docs[0]!.cacheKey);
    expect(() => speechConfigFromRecord(video.plan, { request: {} })).toThrow();
  });

  it("progress: Updating captions → Rendering", () => {
    expect(captionPhaseProgress("timing", 50).message).toBe("Updating captions…");
    expect(captionPhaseProgress("captions", 100)).toMatchObject({ stage: "compile", message: "Updating captions…" });
    expect(captionPhaseProgress("rendering", 40)).toMatchObject({ stage: "render", message: "Rendering · 40%", stages: { compile: "succeeded", render: "running" } });
    const running = { state: "running", stages: [{ name: "compile", status: "succeeded" }, { name: "render", status: "running" }, { name: "validate", status: "pending" }], progress: { stage: "render", percent: 40, message: "Rendering · 40%" } };
    expect(captionSteps(running).map((s) => [s.label, s.status])).toEqual([["Updating captions", "done"], ["Rendering", "active"]]);
    expect(captionSteps(null).map((s) => s.status)).toEqual(["todo", "todo"]);
  });
});

describe("the render job applies the fixes right after compiling (same narration timing)", () => {
  it("captions.json has the fixed text and the compiled phrase times; a stale fix fails the compile step", async () => {
    await withTempDir(async (dir) => {
      const plan = validPlan();
      const config = speechConfigFor(plan, "e2eStandInFemale", "e2e_stand_in");
      const scenes: RenderJobSpec["scenes"] = [];
      const seconds: Record<string, number> = {};
      for (const [i, scene] of plan.scenes.entries()) {
        const request = speechRequestFor(plan, i, config);
        const response = await new FakeElevenLabsSpeech("en").synthesize(request);
        const audioFile = path.join(dir, `${scene.id}.mp3`);
        await writeFile(audioFile, response.audio);
        scenes.push({ sceneId: scene.id, audioFile, record: cacheRecordFor(speechCacheKey(scene, config), request, response, NOW) });
        seconds[audioFile] = (response.audio.byteLength / 417) * (1152 / 44100);
      }
      const probeAudio = async (file: string) => ({ codec: "mp3", sampleRate: 44100, channels: 1, decodedSeconds: seconds[file]! });
      const run = async (captionOverrides: RenderJobSpec["captionOverrides"], sub: string) => {
        const seen: RenderJob[] = [];
        const render = async (job: RenderJob): Promise<RenderReport> => {
          seen.push(job);
          await writeFile(job.outputPath, "mp4 bytes");
          if (job.thumbnail) await writeFile(job.thumbnail.outputPath, "jpeg");
          return { musicMs: 0, bundleMs: 1, renderMs: 2, stillsMs: 0, previews: [], thumbnailPath: job.thumbnail?.outputPath ?? null };
        };
        const result = await runRenderJob(
          { workDir: path.join(dir, sub), plan, planHash: hashPlan(plan), speechConfig: config, scenes, music: true, thumbnailSeconds: THUMBNAIL_SECONDS, ...(captionOverrides ? { captionOverrides } : {}) },
          { render, probeAudio, probe: async () => goodProbe(seen[0]!.timeline.totalFrames) },
        );
        return { result, job: seen[0] };
      };
      const plain = await run(undefined, "plain");
      expect(plain.result.status).toBe("ready");
      const target = indexCaptions(plain.job!.captions)[2]!;
      const fixed = await run([{ sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: "Fixed by the creator.", originalText: target.caption.text }], "fixed");
      expect(fixed.result.status).toBe("ready");
      const after = fixed.job!.captions.captions[2]!;
      expect(after.text).toBe("Fixed by the creator.");
      expect([after.startFrame, after.endFrame]).toEqual([target.caption.startFrame, target.caption.endFrame]);
      // Everything else, timeline included, is exactly as before: the narration is unchanged.
      expect(fixed.job!.timeline).toEqual(plain.job!.timeline);
      expect(fixed.job!.captions.captions.filter((_c, i) => i !== 2)).toEqual(plain.job!.captions.captions.filter((_c, i) => i !== 2));
      const stale = await run([{ sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: "x", originalText: "not the compiled text" }], "stale");
      expect(stale.result).toMatchObject({ status: "failed", stage: "compile" });
      expect(durationMessage).toBeTypeOf("function");
    });
  });
});

describe("one render queue for videos and caption fixes, and its stuck-job rule", () => {
  const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000);
  const captionJob = (overrides: Partial<JobDocument> = {}): JobDocument => ({
    ...newCaptionJob({ ownerId: OWNER, projectId: PROJECT, render: renderDoc(), set: { _id: new ObjectId(), overrides: [] }, now: minutes(20) }),
    ...overrides,
  });

  it("both Inngest functions use the SAME one-at-a-time concurrency (VIDEO_CONCURRENCY)", () => {
    for (const file of ["generate-video.ts", "fix-captions.ts"]) {
      expect(readFileSync(path.join(ROOT, "apps/web/inngest/functions", file), "utf8")).toContain("concurrency: VIDEO_CONCURRENCY,");
    }
    expect(readFileSync(path.join(ROOT, "apps/web/app/api/inngest/route.ts"), "utf8")).toContain("createFixCaptionsFunction(setup.client)");
    expect(VIDEO_JOB_TYPES).toEqual(["generate", "caption"]);
  });

  it("'Waiting to start…' counts and the queue's heartbeat both see generate AND caption jobs", async () => {
    const filters: any[] = [];
    const { db } = fakeDb({ "jobs.countDocuments": (f: unknown) => (filters.push(f), 1), "jobs.findOne": (f: unknown) => (filters.push(f), null) });
    await generateJobsAhead(db, captionJob());
    await lastGenerateActivity(db, new ObjectId());
    expect(filters.map((f) => f.type)).toEqual([{ $in: ["generate", "caption"] }, { $in: ["generate", "caption"] }]);
  });

  it("a caption job waiting behind a render is never failed for waiting; one with a still queue is failed (retryable) and the project goes back to video_ready", async () => {
    expect(isGenerateJobStuck({ state: "queued", queuedAt: minutes(40), updatedAt: minutes(40) }, minutes(1), NOW)).toBe(false);
    const job = captionJob();
    const writes: any[] = [];
    const { db } = fakeDb({
      "jobs.findOne": (f: any) => (f.type?.$in ? null : job),
      "jobs.updateOne": (_f: unknown, u: unknown) => void writes.push(u),
      "projects.updateOne": (_f: unknown, u: unknown) => void writes.push(u),
    });
    await checkStuckJob(db, job, NOW);
    expect(writes[0].$set).toMatchObject({ state: "failed", error: { code: "INTERNAL", retryable: true } });
    expect(writes[1].$set).toMatchObject({ state: "video_ready", activeJobId: null });
    expect(writes[1].$set).not.toHaveProperty("currentRenderId");
  });

  it("Cancel pressed but the worker is gone → cancelled after a minute; the previous video stays", async () => {
    const job = captionJob({ state: "running", cancelRequestedAt: minutes(2), updatedAt: minutes(2) });
    const writes: any[] = [];
    const { db } = fakeDb({ "jobs.findOne": () => job, "jobs.updateOne": (_f: unknown, u: unknown) => void writes.push(u), "projects.updateOne": (_f: unknown, u: unknown) => void writes.push(u) });
    await checkStuckJob(db, job, NOW);
    expect(writes[0].$set).toMatchObject({ state: "cancelled", error: { code: "CANCELLED" } });
    expect(writes[1].$set).toMatchObject({ state: "video_ready" });
  });

  it("how a caption job ends: failed or cancelled → video_ready, the old video kept, no speech claims touched", async () => {
    for (const outcome of ["failed", "cancelled"] as const) {
      const job = captionJob({ state: "running" });
      const writes: any[] = [];
      const fake = fakeDb({ "jobs.findOne": () => job, "jobs.updateOne": (_f: unknown, u: unknown) => void writes.push(u), "projects.updateOne": (_f: unknown, u: unknown) => void writes.push(u) });
      expect(await endCaptionJob(fake.db, { jobId: job._id, attempt: 1, outcome, ...(outcome === "failed" ? { code: "RENDER_FAILED" as const } : {}), now: NOW })).toBe(true);
      expect(writes[1].$set).toMatchObject({ state: "video_ready", activeJobId: null });
      expect(fake.names().some((n) => n.startsWith("speechArtifacts") || n.startsWith("usageCounters"))).toBe(false);
    }
  });
});

describe("Try again (E2), allowedActions and the card", () => {
  const failed = (overrides: Partial<JobDocument> = {}): JobDocument => ({
    ...newCaptionJob({ ownerId: OWNER, projectId: PROJECT, render: renderDoc(), set: { _id: new ObjectId(), overrides: [] }, now: NOW }),
    state: "failed",
    error: { code: "RENDER_FAILED", message: "", retryable: true },
    ...overrides,
  });

  it("edit_captions on a ready video; Cancel while a caption job runs; Try again for the last fix of THIS video", () => {
    expect(allowedActionsFor(projectDoc(), null)).toContain("edit_captions");
    expect(allowedActionsFor(projectDoc({ state: "storyboard_ready" }), null)).not.toContain("edit_captions");
    expect(allowedActionsFor(projectDoc({ state: "archived" }), null)).toEqual([]);
    expect(allowedActionsFor(projectDoc({ language: "hi" }), null)).not.toContain("edit_captions");
    const running = { ...failed(), state: "running" as const, error: null };
    expect(allowedActionsFor(projectDoc({ state: "generating", activeJobId: running._id }), null, null, { activeJob: running })).toEqual(["cancel_job"]);
    expect(allowedActionsFor(projectDoc(), null, null, { latestCaptionJob: failed() })).toContain("retry_job");
    expect(allowedActionsFor(projectDoc(), null, null, { latestCaptionJob: failed({ state: "cancelled", error: { code: "CANCELLED", message: "", retryable: false } }) })).toContain("retry_job");
    expect(allowedActionsFor(projectDoc(), null, null, { latestCaptionJob: failed({ error: { code: "NARRATION_MISSING", message: "", retryable: false } }) })).not.toContain("retry_job");
    expect(allowedActionsFor(projectDoc({ currentRenderId: OLD_RENDER }), null, null, { latestCaptionJob: failed() })).not.toContain("retry_job");
    expect(canRetryCaptionJob(failed({ state: "succeeded" }))).toBe(false);
  });

  it("E2: the same job back in the queue (attempt 2) only while its video is still the project's video", async () => {
    const job = failed();
    const writes: any[] = [];
    const ok = fakeDb({
      "jobs.findOne": () => job,
      "projects.findOne": () => projectDoc(),
      "projects.updateOne": (_f: unknown, u: unknown) => (writes.push(u), { matchedCount: 1 }),
      "jobs.findOneAndUpdate": (_f: unknown, u: any) => ({ ...job, ...u.$set }),
    });
    const retried = await retryCaptionJob(ok.db, { ownerId: OWNER.toHexString(), jobId: job._id.toHexString(), respond: () => ({ status: 202, body: {} }), now: NOW });
    expect(retried).toMatchObject({ state: "queued", attempt: 2, event: { id: `${job._id.toHexString()}:retry:2` } });
    expect(writes[0].$set).toMatchObject({ state: "generating", activeJobId: job._id });
    expect(ok.names().some((n) => n.startsWith("usageCounters"))).toBe(false);

    const moved = fakeDb({ "jobs.findOne": () => job, "projects.findOne": () => projectDoc({ currentRenderId: OLD_RENDER }) });
    const refused = await refusal(retryCaptionJob(moved.db, { ownerId: OWNER.toHexString(), jobId: job._id.toHexString(), respond: () => ({ status: 202, body: {} }) }));
    expect([statusOf(refused), (refused as ProjectActionError).details]).toEqual([409, { reason: "video_changed" }]);
  });

  it("My videos card: 'Updating captions…' while a fix renders", () => {
    expect(cardStatus({ state: "generating", activeJobType: "caption", storyboardApproved: true, activeJobState: "running" }).label).toBe("Updating captions…");
    expect(cardStatus({ state: "generating", activeJobType: "generate", storyboardApproved: true, activeJobState: "running" }).label).toBe("Making video…");
  });

  it("the render input hash changes with the fixes (and is the F23 hash without them)", () => {
    const base = { planHash: "sha256:x", cacheKeys: ["a"], music: true };
    expect(renderInputHash({ ...base, captionOverrides: [] })).toBe(renderInputHash(base));
    expect(renderInputHash({ ...base, captionOverrides: [{ sceneId: "s", phraseIndex: 0, text: "t" }] })).not.toBe(renderInputHash(base));
    expect(newGenerateJob).toBeTypeOf("function");
  });
});
