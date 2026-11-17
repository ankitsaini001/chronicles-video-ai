import {
  allowedActionsFor,
  narrationCost,
  newPlanJob,
  ProjectActionError,
  requestRevision,
  USAGE_LIMITS,
  VIDEO_STAGE_NOT_READY,
  type JobDocument,
  type ProjectDocument,
  type StoredPlan,
} from "@bytereel/db";
import { type Db, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { afterChange, changeEndedMessage, historyUrl, revisionBody, runningNote, wholeLabel } from "../apps/web/lib/storyboard/changes";
import { newVideoCost } from "../apps/web/lib/video/narration-cost";
import { approveLabel, newVideoNote } from "../apps/web/lib/video/new-video";
import { voiceEstimatorFor, type VoiceSetup } from "../apps/web/lib/video/voice";
import type { Plan } from "../packages/pipeline/src/contracts";
import { countCharacters, speechConfigFor, speechRequestFor } from "../packages/pipeline/src/pipeline/speech";
import { validPlan } from "./helpers";

// F26 "Revision chat on the video": the F18 panel's stage handling (lib/storyboard/changes.ts), the
// new video's cost (narrationCost: the SAME rule D8 checks the voice limits with), the storyboard's
// note and button label, what the video page may offer (allowedActions), and D5 `stage: video`.
// The real flow (a real revise job, a real second video that reuses the unchanged narration) is
// checked by tools/e2e/f26-video-revision.ts.

const OWNER = new ObjectId("67330c1a9f1e4b2a7c0d1e01");
const PROJECT = new ObjectId("67330d5e9f1e4b2a7c0d2a10");
const V1 = new ObjectId("67330e019f1e4b2a7c0d2b02");
const RENDER = new ObjectId("67330f109f1e4b2a7c0d6f01");
const NOW = new Date("2026-11-17T05:00:00.000Z");

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

/** A database whose collections answer from `handlers` ("collection.method") and record every call. */
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
          return method === "find" ? { toArray: async () => value } : Promise.resolve(value);
        },
      },
    );
  const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: async () => undefined };
  const db = { client: { startSession: () => session }, collection } as unknown as Db;
  return { db, calls, names: () => calls.map((c) => c.name) };
}

async function refusal(promise: Promise<unknown>): Promise<ProjectActionError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProjectActionError);
  return error as ProjectActionError;
}

describe("the Ask for changes panel on the video page (stage handling)", () => {
  it("names the whole thing after its place and sends its stage", () => {
    expect(wholeLabel("video")).toBe("Whole video");
    expect(wholeLabel("storyboard")).toBe("Whole storyboard");
    expect(revisionBody({ stage: "video", scope: "project", message: "Make the ending punchier", baseVersionId: V1.toHexString(), stateVersion: 7 })).toEqual({
      stage: "video",
      scope: "project",
      message: "Make the ending punchier",
      basePlanVersionId: V1.toHexString(),
      expectedStateVersion: 7,
    });
    expect(revisionBody({ stage: "video", scope: "scene-condensation", message: "Say it more simply", baseVersionId: V1.toHexString(), stateVersion: 7 })).toEqual({
      stage: "video",
      scope: "scene",
      sceneId: "scene-condensation",
      message: "Say it more simply",
      basePlanVersionId: V1.toHexString(),
      expectedStateVersion: 7,
    });
    expect(revisionBody({ stage: "storyboard", scope: "project", message: "Shorter", baseVersionId: V1.toHexString(), stateVersion: 2 }).stage).toBe("storyboard");
    expect(historyUrl(PROJECT.toHexString(), "video")).toBe(`/api/v1/projects/${PROJECT.toHexString()}/revisions?stage=video`);
  });

  it("a new version asked for on the video page opens the storyboard; anything else stays and reloads", () => {
    expect(afterChange("video", { state: "succeeded" })).toBe("open_storyboard");
    expect(afterChange("video", { state: "needs_input" })).toBe("reload"); // unclear request: the reply shows here
    expect(afterChange("video", { state: "failed" })).toBe("reload");
    expect(afterChange("video", null)).toBe("reload"); // the job couldn't be read: reload shows the truth
    expect(afterChange("storyboard", { state: "succeeded" })).toBe("reload"); // F18 unchanged
  });

  it("says how the change ended, and that the video stays while it runs", () => {
    expect(changeEndedMessage("video", { state: "succeeded", error: null, needsInput: null })).toMatch(/make your new video/);
    expect(changeEndedMessage("storyboard", { state: "succeeded", error: null, needsInput: null })).toBe("Your storyboard is updated.");
    expect(changeEndedMessage("video", { state: "needs_input", error: null, needsInput: { message: "Say exactly what to change." } })).toBe("Say exactly what to change.");
    expect(changeEndedMessage("video", { state: "failed", error: { message: "Our AI is very busy right now." }, needsInput: null })).toBe("Our AI is very busy right now.");
    expect(runningNote("video")).toMatch(/Your video stays as it is/);
  });
});

describe("what the video page may offer (allowedActions)", () => {
  it("video_ready, no job, under the 20 AI requests: request_revision next to edit_captions", () => {
    const actions = allowedActionsFor(projectDoc(), null);
    expect(actions).toContain("request_revision");
    expect(actions).toContain("edit_captions");
  });

  it("not at 20 requests, not while a job runs, not archived, not for a switched-off language", () => {
    expect(allowedActionsFor(projectDoc({ planRequestCount: USAGE_LIMITS.planRequestsPerProject }), null)).not.toContain("request_revision");
    const revise = { ...newPlanJob({ ownerId: OWNER, projectId: PROJECT, project: projectDoc(), now: NOW }), type: "revise", state: "running" } as JobDocument;
    const running = projectDoc({ activeJobId: revise._id });
    expect(allowedActionsFor(running, null, null, { activeJob: revise })).toEqual([]); // no caption fix, no second change, no cancel
    expect(allowedActionsFor(projectDoc({ state: "archived" }), null)).toEqual([]);
    expect(allowedActionsFor(projectDoc({ language: "hi" }), null)).not.toContain("request_revision");
  });

  it("a failed change made on this version offers Try again", () => {
    const job = { ...newPlanJob({ ownerId: OWNER, projectId: PROJECT, project: projectDoc(), now: NOW }), type: "revise", state: "failed", error: { code: "PROVIDER_BUSY", message: "busy", retryable: true } } as JobDocument;
    job.inputRef = { ...job.inputRef, planVersionId: V1 };
    expect(allowedActionsFor(projectDoc(), null, job)).toContain("retry_job");
  });
});

describe("D5 stage: video (requestRevision)", () => {
  const body = { stage: "video" as const, scope: "project" as const, message: "Make the ending punchier", basePlanVersionId: V1.toHexString(), expectedStateVersion: 7 };
  const run = (db: Db) => requestRevision(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), body, respond: () => ({ status: 202, body: {} }), now: NOW });

  it("is accepted on a ready video: a pending video-stage revision and its revise job, the video kept", async () => {
    const { db, calls, names } = fakeDb({
      "projects.findOne": () => projectDoc(),
      "planVersions.findOne": () => ({ _id: V1, plan: { scenes: [{ id: "scene-hook" }, { id: "scene-condensation" }] } }),
      "revisions.insertOne": () => ({}),
      "jobs.insertOne": () => ({}),
      "projects.findOneAndUpdate": (_f: unknown, update: { $set: Record<string, unknown> }) => ({ ...projectDoc(), ...update.$set, stateVersion: 8 }),
    });
    const out = await run(db);
    expect(names()).toEqual(["projects.findOne", "planVersions.findOne", "revisions.insertOne", "jobs.insertOne", "projects.findOneAndUpdate"]);
    expect(out.revision.stage).toBe("video");
    expect(out.revision.status).toBe("pending");
    expect(out.job.type).toBe("revise");
    const update = calls.find((c) => c.name === "projects.findOneAndUpdate")!.args[1] as { $set: Record<string, unknown> };
    expect(Object.keys(update.$set).sort()).toEqual(["activeJobId", "updatedAt"]); // state and currentRenderId untouched while it runs
    expect(out.project.currentRenderId).toEqual(RENDER);
  });

  it("is refused after a storyboard change (the older video kept) and without a video: nothing written", async () => {
    for (const [project, message] of [
      [projectDoc({ state: "storyboard_ready", approvedPlanVersionId: null }), VIDEO_STAGE_NOT_READY],
      [projectDoc({ state: "storyboard_ready", currentRenderId: null, approvedPlanVersionId: null }), "There is no video to change yet."],
    ] as const) {
      const { db, names } = fakeDb({ "projects.findOne": () => project });
      const error = await refusal(run(db));
      expect(error.code).toBe("INVALID_STATE");
      expect(error.message).toBe(message);
      expect(names()).toEqual(["projects.findOne"]);
    }
  });

  it("is refused while another job runs (one job at a time)", async () => {
    const { db } = fakeDb({ "projects.findOne": () => projectDoc({ activeJobId: new ObjectId() }) });
    expect((await refusal(run(db))).code).toBe("JOB_ALREADY_RUNNING");
  });
});

// ---------- the new video's cost ----------

/** The stand-in voice set-up (no provider is ever made here). */
const setup = (voiceId = "voiceFemale"): Extract<VoiceSetup, { ok: true }> => ({
  ok: true,
  fake: true,
  configFor: (plan) => speechConfigFor(plan, plan.voicePreset.endsWith("-male") ? "voiceMale" : voiceId, "model_x"),
  provider: () => {
    throw new Error("no provider in this test");
  },
});
const stored = (plan: Plan) => plan as unknown as StoredPlan;
/** The owner already has these recordings (ready). */
const recorded = (keys: string[]) => fakeDb({ "speechArtifacts.find": (filter: { cacheKey: { $in: string[] } }) => filter.cacheKey.$in.filter((k) => keys.includes(k)).map((cacheKey) => ({ cacheKey })) });

describe("the new video's cost (narrationCost, the same rule as D8)", () => {
  const estimator = voiceEstimatorFor(setup());
  const before = validPlan();
  const video1Keys = estimator(stored(before)).map((s) => s.cacheKey);

  it("only the changed scene gets new narration; the others reuse their recording", async () => {
    const after = validPlan();
    after.scenes[2]!.narration[0]!.text = `${after.scenes[2]!.narration[0]!.text} Simple as that.`;
    const { db, calls } = recorded(video1Keys);
    const cost = await narrationCost(db, { ownerId: OWNER, scenes: estimator(stored(after)) });
    expect(cost.newScenes).toEqual([2]);
    expect(cost.reusedScenes).toEqual([0, 1, 3, 4, 5].filter((i) => i < after.scenes.length));
    expect(cost.characters).toBe(countCharacters(speechRequestFor(after, 2, setup().configFor(after)).text));
    // Owner-scoped: only this owner's recordings count.
    expect((calls[0]!.args[0] as { ownerId: ObjectId }).ownerId).toEqual(OWNER);
  });

  it("nothing changed in the narration: every scene reuses its recording, no characters", async () => {
    const { db } = recorded(video1Keys);
    const cost = await narrationCost(db, { ownerId: OWNER, scenes: estimator(stored(validPlan())) });
    expect(cost).toEqual({ newScenes: [], reusedScenes: before.scenes.map((_s, i) => i), characters: 0 });
  });

  it("the same new words in two scenes share ONE recording (counted once)", async () => {
    const after = validPlan();
    after.scenes[1]!.narration = [{ ...after.scenes[1]!.narration[0]!, text: "Water moves in a loop." }];
    after.scenes[3]!.narration = [{ ...after.scenes[1]!.narration[0]!, id: after.scenes[3]!.narration[0]!.id }];
    const scenes = estimator(stored(after));
    expect(scenes[1]!.cacheKey).toBe(scenes[3]!.cacheKey);
    const { db } = recorded(video1Keys);
    const cost = await narrationCost(db, { ownerId: OWNER, scenes });
    expect(cost.newScenes).toEqual([1, 3]);
    expect(cost.characters).toBe(scenes[1]!.characters); // one recording, not two
  });

  it("a voice switch gives every scene new narration", async () => {
    const male = { ...validPlan(), voicePreset: validPlan().voicePreset.replace(/female$/, "male") } as Plan;
    expect(male.voicePreset).not.toBe(before.voicePreset);
    const scenes = estimator(stored(male));
    const { db } = recorded(video1Keys);
    const cost = await narrationCost(db, { ownerId: OWNER, scenes });
    expect(cost.newScenes).toEqual(male.scenes.map((_s, i) => i));
    expect(cost.reusedScenes).toEqual([]);
    expect(cost.characters).toBe([...new Map(scenes.map((s) => [s.cacheKey, s.characters])).values()].reduce((a, b) => a + b, 0));
  });

  it("no note when the voice isn't set up on this server (never a provider call, never a throw)", async () => {
    const { db, calls } = recorded([]);
    expect(await newVideoCost(db, { ownerId: OWNER }, stored(validPlan()), {})).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("the storyboard after a change on the video: the note and the button", () => {
  it("the button reads 'Approve & make new video' only when the project already has a video", () => {
    expect(approveLabel(true)).toBe("Approve & make new video");
    expect(approveLabel(false)).toBe("Approve & generate video");
  });

  it("names the scenes that get new narration, the characters, and that the others reuse their recording", () => {
    expect(newVideoNote({ newScenes: [2], reusedScenes: [0, 1, 3, 4, 5], characters: 151 }, 3)).toBe(
      "In your new video, scene 3 gets new narration (about 151 voice characters). The other 5 scenes reuse their recordings. It counts as 1 of your 3 videos today.",
    );
    expect(newVideoNote({ newScenes: [1, 3], reusedScenes: [0, 2, 4, 5], characters: 1234 }, 3)).toBe(
      "In your new video, scenes 2 and 4 get new narration (about 1,234 voice characters). The other 4 scenes reuse their recordings. It counts as 1 of your 3 videos today.",
    );
    expect(newVideoNote({ newScenes: [0, 1], reusedScenes: [2], characters: 90 }, 3)).toMatch(/The other scene reuses its recording\./);
    expect(newVideoNote({ newScenes: [0, 1, 2], reusedScenes: [], characters: 400 }, 3)).toBe(
      "Your new video records new narration for all 3 scenes (about 400 voice characters). It counts as 1 of your 3 videos today.",
    );
    expect(newVideoNote({ newScenes: [], reusedScenes: [0, 1, 2], characters: 0 }, 3)).toBe(
      "Your new video reuses the recorded narration of every scene: no voice characters needed. It counts as 1 of your 3 videos today.",
    );
  });
});
