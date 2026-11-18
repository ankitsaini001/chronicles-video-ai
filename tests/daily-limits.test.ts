import {
  approveAndGenerate,
  approveLimitCheck,
  endGenerateJob,
  limitShortReason,
  newGenerateJob,
  ProjectActionError,
  resetClock,
  resetDate,
  usageCounterPeriod,
  usagePeriods,
  videosPerDayMessage,
  voiceCeilingMessage,
  voiceLimitError,
  voiceLimitProblem,
  voiceQuotaMessage,
  wouldExceed,
  type JobDocument,
  type PlanVersionDocument,
  type ProjectDocument,
  type StoredPlan,
  type VoiceScene,
} from "@bytereel/db";
import { type Db, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { newVideoNote } from "../apps/web/lib/video/new-video";
import { validPlan } from "./helpers";

// F27 "Daily limits": the wording with the reset time in the creator's timezone (decision 1), the
// storyboard's pre-check before Approve (decision 2: the same functions and order as D8, so they
// can't disagree), a video job stopped by a voice limit (decision 3), and the reset at midnight
// (decision 4). Fake databases only (every unexpected read or write fails the test); the real
// transactions and screens are checked by tools/e2e/f27-limits.ts.

const OWNER = new ObjectId("67330c1a9f1e4b2a7c0d1e01");
const PROJECT = new ObjectId("67330d5e9f1e4b2a7c0d2a10");
const V1 = new ObjectId("67330e019f1e4b2a7c0d2b02");
const HASH = `sha256:${"a".repeat(64)}`;
/** 2026-11-18 15:30 in Kolkata, 05:00 in New York. */
const NOW = new Date("2026-11-18T10:00:00.000Z");
const KOLKATA = "Asia/Kolkata";
const NEW_YORK = "America/New_York";

const VIDEOS_MESSAGE = "You've made 3 videos today, the most for one day. You can make more after 12:00 am (midnight) your time.";
const CEILING_DEC_1 = "Video making is paused for everyone until 1 December (the app's monthly voice limit is used up). Your videos and downloads still work.";

describe("the wording (decision 1), in the creator's timezone", () => {
  it("videos per day: the decision's exact text, midnight in Kolkata and in New York", () => {
    expect(videosPerDayMessage({ limit: 3, resetsAt: usagePeriods(KOLKATA, NOW).dayResetsAt, timezone: KOLKATA })).toBe(VIDEOS_MESSAGE);
    expect(videosPerDayMessage({ limit: 3, resetsAt: usagePeriods(NEW_YORK, NOW).dayResetsAt, timezone: NEW_YORK })).toBe(VIDEOS_MESSAGE);
  });

  it("videos per day where midnight is skipped (Santiago's clocks jump 00:00 → 01:00): the real time, no '(midnight)'", () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const resetsAt = usagePeriods("America/Santiago", now).dayResetsAt;
    expect(videosPerDayMessage({ limit: 3, resetsAt, timezone: "America/Santiago" })).toBe("You've made 3 videos today, the most for one day. You can make more after 1:00 am your time.");
  });

  it("the creator's voice: needed vs left and the reset date (the decision's example numbers)", () => {
    const resetsAt = usagePeriods(KOLKATA, NOW).monthResetsAt;
    expect(voiceQuotaMessage({ needed: 1050, used: 2206, limit: 3000, resetsAt, timezone: KOLKATA })).toBe(
      "This video needs about 1,050 voice characters, but you have 794 left this month. The limit resets on 1 December.",
    );
  });

  it("the creator's voice at a month boundary: already December in Kolkata while UTC is still in November → resets on 1 January", () => {
    const now = new Date("2026-11-30T20:00:00.000Z"); // 1 December 01:30 in Kolkata
    const resetsAt = usageCounterPeriod("voiceChars", KOLKATA, now).resetsAt;
    expect(voiceQuotaMessage({ needed: 300, used: 2800, limit: 3000, resetsAt, timezone: KOLKATA })).toBe(
      "This video needs about 300 voice characters, but you have 200 left this month. The limit resets on 1 January.",
    );
  });

  it("over the limit already (used > limit) says 0 left, never a negative number", () => {
    expect(voiceQuotaMessage({ needed: 10, used: 3100, limit: 3000, resetsAt: NOW, timezone: KOLKATA })).toContain("but you have 0 left this month");
  });

  it("the app's voice (UTC month): the day it ends in the creator's timezone; a negative-offset zone sees 30 November", () => {
    const resetsAt = usageCounterPeriod("appVoiceChars", "UTC", NOW).resetsAt;
    expect(resetsAt.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(voiceCeilingMessage({ resetsAt, timezone: KOLKATA })).toBe(CEILING_DEC_1);
    expect(voiceCeilingMessage({ resetsAt, timezone: NEW_YORK })).toBe(
      "Video making is paused for everyone until 30 November (the app's monthly voice limit is used up). Your videos and downloads still work.",
    );
  });

  it("dates and times the en-IN way; an unknown timezone falls back to Asia/Kolkata", () => {
    const midnight = new Date("2026-11-18T18:30:00.000Z");
    expect(resetClock(midnight, KOLKATA)).toBe("12:00 am");
    expect(resetClock(midnight, KOLKATA, { zoneName: true })).toBe("12:00 am IST"); // the Idea page's projects/day line
    expect(resetDate(midnight, KOLKATA)).toBe("19 November");
    expect(resetClock(midnight, "Not/AZone")).toBe("12:00 am");
  });

  it("D8's refusals carry the sentence as the message and the numbers in details", () => {
    const user = voiceLimitError("user", { used: 2206, needed: 1050, timezone: NEW_YORK, now: NOW });
    expect(user.message).toBe("This video needs about 1,050 voice characters, but you have 794 left this month. The limit resets on 1 December.");
    expect(user.details).toEqual({ quota: "voice_characters_per_month", limit: 3000, used: 2206, needed: 1050, resetsAt: "2026-12-01T05:00:00.000Z" });
    const app = voiceLimitError("app", { used: 9000, needed: 1, timezone: KOLKATA, now: NOW });
    expect(app).toMatchObject({ code: "SPEND_CEILING", message: CEILING_DEC_1, details: { ceiling: "voice_characters_per_month", resetsAt: "2026-12-01T00:00:00.000Z" } });
  });

  it("the short reason next to a greyed-out button", () => {
    expect(limitShortReason({ code: "QUOTA_EXCEEDED", details: { quota: "videos_per_day" } })).toBe("No videos left today.");
    expect(limitShortReason({ code: "QUOTA_EXCEEDED", details: { quota: "voice_characters_per_month" } })).toBe("Not enough voice characters left this month.");
    expect(limitShortReason({ code: "SPEND_CEILING", details: {} })).toBe("Video making is paused for everyone.");
  });
});

describe("exactly enough is allowed, 1 short is refused (one rule: wouldExceed / voiceLimitProblem)", () => {
  it("the limit rule", () => {
    expect(wouldExceed(2, 1, 3)).toBe(false); // the 3rd video of the day
    expect(wouldExceed(3, 1, 3)).toBe(true); // the 4th
    expect(wouldExceed(2206, 794, 3000)).toBe(false);
    expect(wouldExceed(2206, 795, 3000)).toBe(true);
  });

  it("the creator's 3,000 and the app's 9,000", () => {
    expect(voiceLimitProblem({ needed: 794, userUsed: 2206, appUsed: 0 })).toBeNull();
    expect(voiceLimitProblem({ needed: 795, userUsed: 2206, appUsed: 0 })).toBe("user");
    expect(voiceLimitProblem({ needed: 1000, userUsed: 0, appUsed: 8000 })).toBeNull();
    expect(voiceLimitProblem({ needed: 1001, userUsed: 0, appUsed: 8000 })).toBe("app");
  });
});

describe("reset at midnight in the creator's timezone (decision 4)", () => {
  it("Kolkata: the day's counter changes at 18:30 UTC", () => {
    expect(usageCounterPeriod("videos", KOLKATA, new Date("2026-11-18T18:29:59.999Z")).period).toBe("2026-11-18");
    expect(usageCounterPeriod("videos", KOLKATA, new Date("2026-11-18T18:30:00.000Z")).period).toBe("2026-11-19");
  });

  it("New York (UTC−5): the day's counter changes at 05:00 UTC", () => {
    expect(usageCounterPeriod("videos", NEW_YORK, new Date("2026-11-19T04:59:59.999Z")).period).toBe("2026-11-18");
    expect(usageCounterPeriod("videos", NEW_YORK, new Date("2026-11-19T05:00:00.000Z")).period).toBe("2026-11-19");
  });

  it("the month: the creator's in their timezone, the app's in UTC", () => {
    const t = new Date("2026-11-30T20:00:00.000Z");
    expect(usageCounterPeriod("voiceChars", KOLKATA, t).period).toBe("2026-12");
    expect(usageCounterPeriod("appVoiceChars", "UTC", t).period).toBe("2026-11");
    expect(usageCounterPeriod("voiceChars", NEW_YORK, new Date("2026-12-01T03:00:00.000Z")).period).toBe("2026-11");
  });

  it("3 of 3 before midnight is refused; one second after midnight the new day's counter is empty → allowed", async () => {
    const before = new Date("2026-11-18T18:29:59.000Z");
    const after = new Date("2026-11-18T18:30:01.000Z");
    const counts = { "videos:2026-11-18": 3 };
    const check = (now: Date) => approveLimitCheck(precheckDb({ counts }).db, { ownerId: OWNER, projectId: PROJECT, planVersionId: V1, timezone: KOLKATA, scenes: scenesOf([100]), now });
    expect((await check(before)).refusal?.message).toBe(VIDEOS_MESSAGE);
    expect((await check(after)).refusal).toBeNull();
  });
});

// ---------- the pre-check (decision 2) ----------

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

/** One recording per number, with that many characters. */
const scenesOf = (characters: number[]): VoiceScene[] => characters.map((c, i) => ({ cacheKey: `sha256:${String(i).repeat(64).slice(0, 64)}`, characters: c }));

type World = {
  /** usageCounters by "kind:period" (videos: the day, voiceChars: the creator's month, appVoiceChars: the UTC month). */
  counts?: Record<string, number>;
  /** This version's existing `gen:` job. */
  job?: JobDocument | null;
  /** Its ready video. */
  render?: boolean;
  /** Recordings the owner already has (cache keys). */
  ready?: string[];
};

const readCount = (counts: Record<string, number>, filter: { kind: string; period: string }) => ({ count: counts[`${filter.kind}:${filter.period}`] ?? 0 });

function precheckDb(world: World) {
  const counts = world.counts ?? {};
  return fakeDb({
    "jobs.findOne": () => world.job ?? null,
    "renders.findOne": () => (world.render ? { _id: new ObjectId(), status: "ready" } : null),
    "usageCounters.findOne": (filter: { kind: string; period: string }) => readCount(counts, filter),
    "speechArtifacts.find": (filter: { cacheKey: { $in: string[] } }) => filter.cacheKey.$in.filter((k) => world.ready?.includes(k)).map((cacheKey) => ({ cacheKey })),
  });
}

const generateJob = (overrides: Partial<JobDocument> = {}): JobDocument => ({ ...newGenerateJob({ ownerId: OWNER, projectId: PROJECT, version: { _id: V1, planHash: HASH }, now: NOW }), ...overrides });
const failedJob = (overrides: Partial<JobDocument> = {}) => generateJob({ state: "failed", error: { code: "RENDER_FAILED", message: "Rendering failed.", retryable: true }, ...overrides });

describe("the storyboard's pre-check (approveLimitCheck): read-only, the same order as D8", () => {
  const check = (world: World, scenes: VoiceScene[] | null = scenesOf([400, 400, 250]), timezone = KOLKATA) => {
    const fake = precheckDb(world);
    return { fake, out: approveLimitCheck(fake.db, { ownerId: OWNER, projectId: PROJECT, planVersionId: V1, timezone, scenes, now: NOW }) };
  };

  it("a first video with room: path new, no refusal; nothing is written", async () => {
    const { fake, out } = check({ counts: { "videos:2026-11-18": 2 } });
    expect(await out).toEqual({ path: "new", refusal: null });
    expect(fake.names().every((n) => n.endsWith(".findOne") || n.endsWith(".find"))).toBe(true);
  });

  it("0 videos left today → the videos/day refusal; the voice isn't even looked at (as D8)", async () => {
    const { fake, out } = check({ counts: { "videos:2026-11-18": 3 } });
    const result = await out;
    expect(result.path).toBe("new");
    expect(result.refusal).toBeInstanceOf(ProjectActionError);
    expect(result.refusal).toMatchObject({ code: "QUOTA_EXCEEDED", message: VIDEOS_MESSAGE, details: { quota: "videos_per_day", limit: 3, used: 3, resetsAt: "2026-11-18T18:30:00.000Z" } });
    expect(fake.names()).not.toContain("speechArtifacts.find");
  });

  it("not enough voice characters (1,050 needed, 794 left) → the creator's sentence", async () => {
    const { out } = check({ counts: { "voiceChars:2026-11": 2206 } });
    expect((await out).refusal).toMatchObject({ code: "QUOTA_EXCEEDED", message: "This video needs about 1,050 voice characters, but you have 794 left this month. The limit resets on 1 December." });
  });

  it("exactly enough (794 needed, 794 left) passes; 1 short (795) is refused", async () => {
    expect((await check({ counts: { "voiceChars:2026-11": 2206 } }, scenesOf([400, 394])).out).refusal).toBeNull();
    expect((await check({ counts: { "voiceChars:2026-11": 2206 } }, scenesOf([400, 395])).out).refusal?.message).toBe(
      "This video needs about 795 voice characters, but you have 794 left this month. The limit resets on 1 December.",
    );
  });

  it("recordings the creator already has are free (as D8): only the missing ones count", async () => {
    const scenes = scenesOf([400, 400, 250]);
    const { out } = check({ counts: { "voiceChars:2026-11": 2206 }, ready: [scenes[0]!.cacheKey] }, scenes);
    expect((await out).refusal).toBeNull(); // 650 needed, 794 left
  });

  it("the app's 9,000 → the pause-for-everyone sentence (after the creator's own limit)", async () => {
    const { out } = check({ counts: { "appVoiceChars:2026-11": 8500 } });
    expect((await out).refusal).toMatchObject({ code: "SPEND_CEILING", message: CEILING_DEC_1 });
  });

  it("this version already has its video (reuse): approving costs nothing → never refused, no counter read", async () => {
    const { fake, out } = check({ job: generateJob({ state: "succeeded" }), render: true, counts: { "videos:2026-11-18": 3, "voiceChars:2026-11": 3000, "appVoiceChars:2026-11": 9000 } });
    expect(await out).toEqual({ path: "reuse", refusal: null });
    expect(fake.names()).not.toContain("usageCounters.findOne");
  });

  it("a failed job of this version (D8 queues the same job again): no videos/day count, only the voice", async () => {
    expect(await check({ job: failedJob(), counts: { "videos:2026-11-18": 3 } }).out).toEqual({ path: "requeue", refusal: null });
    expect((await check({ job: failedJob(), counts: { "videos:2026-11-18": 3, "voiceChars:2026-11": 2206 } }).out).refusal?.details).toMatchObject({ quota: "voice_characters_per_month", needed: 1050 });
  });

  it("characters this job already reserved this month are not needed again (a retry never counts twice)", async () => {
    const scenes = scenesOf([400, 400, 250]);
    const job = failedJob({ voice: { cacheKeys: [scenes[0]!.cacheKey, scenes[1]!.cacheKey], characters: 800, sentKeys: [], period: { user: "2026-11", app: "2026-11" } } });
    expect((await check({ job, counts: { "voiceChars:2026-11": 2900 } }, scenes).out).refusal?.details).toMatchObject({ needed: 250, used: 2900 });
  });

  it("a succeeded job whose video is gone is queued again (requeue), as D8 does", async () => {
    expect((await check({ job: generateJob({ state: "succeeded" }), render: false }).out).path).toBe("requeue");
  });

  it("the voice isn't set up on this server (scenes null): only videos/day is checked", async () => {
    expect(await check({ counts: { "voiceChars:2026-11": 3000 } }, null).out).toEqual({ path: "new", refusal: null });
  });
});

// ---------- the pre-check and D8 never disagree ----------

function projectDoc(): ProjectDocument {
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
  };
}

function versionDoc(): PlanVersionDocument {
  return { _id: V1, ownerId: OWNER, projectId: PROJECT, schemaVersion: 1, versionNumber: 1, parentVersionId: null, source: "ai_plan", plan: validPlan() as unknown as StoredPlan, planHash: HASH, validation: { valid: true, issues: [], warnings: [] }, stats: { sceneCount: 6, wordCount: 170, estimatedSeconds: 70 }, plannerUsage: null, createdAt: NOW } as PlanVersionDocument;
}

/** D8 against the same world: its refusal, or null when it would queue the video. */
async function d8Refusal(world: World, scenes: VoiceScene[], timezone: string): Promise<ProjectActionError | null> {
  const counts = { ...(world.counts ?? {}) };
  const { db } = fakeDb({
    "projects.findOne": () => projectDoc(),
    "planVersions.findOne": () => versionDoc(),
    "jobs.findOne": () => world.job ?? null,
    "renders.findOne": () => (world.render ? { _id: new ObjectId(), status: "ready" } : null),
    "usageCounters.findOneAndUpdate": (filter: { kind: string; period: string }, update: { $inc: { count: number } }) => {
      const key = `${filter.kind}:${filter.period}`;
      counts[key] = (counts[key] ?? 0) + update.$inc.count;
      return { count: counts[key] };
    },
    "usageCounters.findOne": (filter: { kind: string; period: string }) => readCount(counts, filter),
    "speechArtifacts.find": (filter: { cacheKey: { $in: string[] } }) => filter.cacheKey.$in.filter((k) => world.ready?.includes(k)).map((cacheKey) => ({ cacheKey })),
    "storyboardApprovals.findOne": () => null,
    "storyboardApprovals.insertOne": () => ({}),
    "auditLogs.insertOne": () => ({}),
    "jobs.insertOne": () => ({}),
    "jobs.findOneAndUpdate": () => generateJob({ state: "queued", attempt: 2 }),
    "projects.findOneAndUpdate": (_f: unknown, update: { $set: Partial<ProjectDocument> }) => ({ ...projectDoc(), ...update.$set, stateVersion: 5 }),
  });
  try {
    await approveAndGenerate(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), timezone, body: { planVersionId: V1.toHexString(), planHash: HASH, expectedStateVersion: 4 }, voice: () => scenes, respond: () => ({ status: 202, body: {} }), now: NOW });
    return null;
  } catch (error) {
    if (error instanceof ProjectActionError) return error;
    throw error;
  }
}

describe("no drift: the pre-check says exactly what D8 answers", () => {
  const scenes = scenesOf([400, 400, 250]);
  const worlds: [string, World][] = [
    ["room for everything", { counts: { "videos:2026-11-18": 1 } }],
    ["the 3rd video of the day", { counts: { "videos:2026-11-18": 2 } }],
    ["the 4th video of the day", { counts: { "videos:2026-11-18": 3 } }],
    ["the 4th video, but this version's failed job is queued again", { counts: { "videos:2026-11-18": 3 }, job: failedJob() }],
    ["voice exactly enough", { counts: { "voiceChars:2026-11": 1950 } }],
    ["voice 1 short", { counts: { "voiceChars:2026-11": 1951 } }],
    ["the app's month full", { counts: { "appVoiceChars:2026-11": 8000 } }],
    ["0 videos left AND no voice left: videos/day wins", { counts: { "videos:2026-11-18": 3, "voiceChars:2026-11": 3000 } }],
    ["voice left only thanks to a ready recording", { counts: { "voiceChars:2026-11": 2500 }, ready: [scenes[0]!.cacheKey, scenes[1]!.cacheKey] }],
  ];
  for (const timezone of [KOLKATA, NEW_YORK]) {
    it.each(worlds)(`${timezone}: %s`, async (_name, world) => {
      const pre = (await approveLimitCheck(precheckDb(world).db, { ownerId: OWNER, projectId: PROJECT, planVersionId: V1, timezone, scenes, now: NOW })).refusal;
      const d8 = await d8Refusal(world, scenes, timezone);
      expect(pre ? { code: pre.code, message: pre.message, details: pre.details } : null).toEqual(d8 ? { code: d8.code, message: d8.message, details: d8.details } : null);
    });
  }
});

// ---------- a video job that hits a limit (decision 3) ----------

describe("a video job stopped by a voice limit fails with the same sentence (endGenerateJob)", () => {
  const ended = async (input: { code: "QUOTA_EXCEEDED" | "SPEND_CEILING"; needed?: number; timezone?: string; used?: number }) => {
    const job = generateJob({ state: "running", attempt: 1 });
    const fake = fakeDb({
      "jobs.findOne": () => job,
      "user.findOne": () => ({ _id: OWNER, timezone: input.timezone ?? KOLKATA }),
      "usageCounters.findOne": () => ({ count: input.used ?? 0 }),
      "jobs.updateOne": () => ({ matchedCount: 1 }),
      "projects.updateOne": () => ({ matchedCount: 1 }),
      "speechArtifacts.updateMany": () => ({}),
    });
    expect(await endGenerateJob(fake.db, { jobId: job._id, attempt: 1, outcome: "failed", code: input.code, stage: "speech", detail: "fixed line", ...(input.needed !== undefined ? { needed: input.needed } : {}), now: NOW })).toBe(true);
    const jobSet = fake.calls.find((c) => c.name === "jobs.updateOne")!.args[1].$set;
    const projectSet = fake.calls.find((c) => c.name === "projects.updateOne")!.args[1].$set;
    return { job: jobSet, project: projectSet };
  };

  it("the creator's limit: needed vs left and the reset date, on the job and on the project (the failure screen); Try again stays", async () => {
    const out = await ended({ code: "QUOTA_EXCEEDED", needed: 1050, used: 2206 });
    const message = "This video needs about 1,050 voice characters, but you have 794 left this month. The limit resets on 1 December.";
    expect(out.job.error).toEqual({ code: "QUOTA_EXCEEDED", message, retryable: true });
    expect(out.project.lastError).toMatchObject({ code: "QUOTA_EXCEEDED", message });
    expect(out.job.stages.find((s: { name: string }) => s.name === "speech").error).toEqual({ code: "QUOTA_EXCEEDED", message: "fixed line" });
  });

  it("the app's limit: the pause-for-everyone sentence in the creator's timezone", async () => {
    expect((await ended({ code: "SPEND_CEILING", needed: 500 })).project.lastError.message).toBe(CEILING_DEC_1);
    expect((await ended({ code: "SPEND_CEILING", timezone: NEW_YORK })).job.error.message).toContain("until 30 November");
  });

  it("the creator's limit without the characters (should not happen): the short fallback", async () => {
    expect((await ended({ code: "QUOTA_EXCEEDED" })).job.error.message).toBe("Voice limit reached this month.");
  });
});

describe("the storyboard's cost note (F26) with F27's rules", () => {
  const cost = { newScenes: [2], reusedScenes: [0, 1, 3, 4, 5], characters: 135 };

  it("counts 1 of today's videos only when told to (a new job with one left)", () => {
    expect(newVideoNote(cost, { used: 1, limit: 3 })).toBe("In your new video, scene 3 gets new narration (about 135 voice characters). The other 5 scenes reuse their recordings. It counts as 1 of your 3 videos today (2 left).");
    expect(newVideoNote(cost, null)).toBe("In your new video, scene 3 gets new narration (about 135 voice characters). The other 5 scenes reuse their recordings.");
  });
});
