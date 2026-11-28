import {
  allowedActionsFor,
  cancelScheduledPost,
  CreatePostBodySchema,
  earliestScheduleTime,
  fromIstParts,
  isScheduleMissed,
  istApprovalLabel,
  istDateLabel,
  istDateTimeLabel,
  istParts,
  istTimeLabel,
  latestScheduleTime,
  parseScheduledAt,
  POST_MESSAGES,
  PUBLISH_FAILURES,
  SCHEDULE_MESSAGES,
  scheduleProblem,
  toIstIso,
  checkStuckJob,
  invalidateOpenPosts,
  retryPost,
  scheduledWait,
  startPublishAttempt,
  wakeScheduledPost,
  type JobDocument,
  type PostDocument,
  type ProjectDocument,
} from "@bytereel/db";
import { type Db, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { cardStatus, scheduledLine } from "../apps/web/lib/dashboard/cards";
import { FAKE_DELAYS, runPublishJob, type PublishJobStore } from "../apps/web/lib/publish/run-publish-job";

// F31 "Schedule a post": the window and the 5-minute step, the India-time words, the job's sleep and
// wake (a scheduled post that is no longer `scheduled` when it wakes never reaches Instagram; a missed
// one is never posted), the wake / cancel transactions' conditional writes (fake database), H6 refusing a
// missed post, allowedActions and the dashboard card. ZERO network calls; the real database, the real
// Inngest sleep and the stand-in Instagram are covered by tools/e2e/f31-schedule.ts.

const NOW = new Date("2026-11-26T06:00:00.000Z"); // 11:30 AM IST

describe("the schedule window and the 5-minute step (scheduleProblem)", () => {
  it("accepts 10 minutes to 7 days ahead, on a 5-minute step", () => {
    expect(scheduleProblem(new Date("2026-11-26T06:10:00.000Z"), NOW)).toBeNull();
    expect(scheduleProblem(new Date("2026-12-03T06:00:00.000Z"), NOW)).toBeNull();
    expect(scheduleProblem(new Date("2026-11-28T13:30:00.000Z"), NOW)).toBeNull(); // Sat 28 Nov, 7:00 PM IST
  });
  it("refuses too soon, too late, and off the 5-minute step (never rounds)", () => {
    expect(scheduleProblem(new Date("2026-11-26T06:05:00.000Z"), NOW)).toBe(SCHEDULE_MESSAGES.TOO_SOON);
    expect(scheduleProblem(new Date("2026-11-26T05:00:00.000Z"), NOW)).toBe(SCHEDULE_MESSAGES.TOO_SOON);
    expect(scheduleProblem(new Date("2026-12-03T06:05:00.000Z"), NOW)).toBe(SCHEDULE_MESSAGES.TOO_LATE);
    expect(scheduleProblem(new Date("2026-11-26T07:03:00.000Z"), NOW)).toBe(SCHEDULE_MESSAGES.NOT_ON_STEP);
    expect(scheduleProblem(new Date("2026-11-26T07:05:30.000Z"), NOW)).toBe(SCHEDULE_MESSAGES.NOT_ON_STEP);
    expect(scheduleProblem(new Date("2026-11-26T07:05:00.001Z"), NOW)).toBe(SCHEDULE_MESSAGES.NOT_ON_STEP);
  });
  it("parses ISO times with an offset only", () => {
    expect(parseScheduledAt("2026-11-28T19:00:00+05:30")?.toISOString()).toBe("2026-11-28T13:30:00.000Z");
    expect(parseScheduledAt("2026-11-28T13:30Z")?.toISOString()).toBe("2026-11-28T13:30:00.000Z");
    expect(parseScheduledAt("2026-11-28T19:00:00")).toBeNull();
    expect(parseScheduledAt("2026-13-45T19:00:00+05:30")).toBeNull();
    expect(parseScheduledAt("tomorrow")).toBeNull();
  });
  it("missed: more than 1 hour after the time; up to 1 hour late still posts", () => {
    const at = new Date("2026-11-28T13:30:00.000Z");
    expect(isScheduleMissed(at, new Date("2026-11-28T14:30:00.000Z"))).toBe(false);
    expect(isScheduleMissed(at, new Date("2026-11-28T14:30:00.001Z"))).toBe(true);
  });
});

describe("India time (IST) words and the picker", () => {
  const at = new Date("2026-11-28T13:30:00.000Z");
  it("shows times the same way everywhere", () => {
    expect(istDateTimeLabel(at)).toBe("Sat 28 Nov, 7:00 PM IST");
    expect(istApprovalLabel(at)).toBe("Sat 28 Nov at 7:00 PM IST");
    expect(istTimeLabel(at)).toBe("7:00 PM IST");
    expect(istDateLabel(at)).toBe("Sat, 28 Nov 2026");
    expect(istDateTimeLabel(new Date("2026-11-28T18:35:00.000Z"))).toBe("Sun 29 Nov, 12:05 AM IST");
    expect(istDateTimeLabel(new Date("2026-11-28T06:30:00.000Z"))).toBe("Sat 28 Nov, 12:00 PM IST");
  });
  it("turns the picker's IST date + time into the instant and back", () => {
    expect(fromIstParts("2026-11-28", "19:00")?.toISOString()).toBe("2026-11-28T13:30:00.000Z");
    expect(istParts(at)).toEqual({ date: "2026-11-28", time: "19:00" });
    expect(toIstIso(at)).toBe("2026-11-28T19:00:00+05:30");
    expect(fromIstParts("2026-02-30", "19:00")).toBeNull();
    expect(fromIstParts("2026-11-28", "7pm")).toBeNull();
  });
  it("offers from now + 10 min (next 5-minute step) to now + 7 days", () => {
    expect(earliestScheduleTime(new Date("2026-11-26T06:01:00.000Z")).toISOString()).toBe("2026-11-26T06:15:00.000Z");
    expect(earliestScheduleTime(NOW).toISOString()).toBe("2026-11-26T06:10:00.000Z");
    expect(latestScheduleTime(new Date("2026-11-26T06:01:00.000Z")).toISOString()).toBe("2026-12-03T06:00:00.000Z");
    expect(scheduleProblem(earliestScheduleTime(new Date("2026-11-26T06:01:00.000Z")), new Date("2026-11-26T06:01:00.000Z"))).toBeNull();
  });
  it("H2 accepts what the picker sends", () => {
    const body = {
      mode: "scheduled",
      renderId: "67330f109f1e4b2a7c0d6f01",
      mp4Sha256: `sha256:${"d".repeat(64)}`,
      connectionId: "67330f109f1e4b2a7c0d6f02",
      caption: "Rain #WaterCycle",
      scheduledAt: toIstIso(at),
      expectedStateVersion: 5,
    };
    expect(CreatePostBodySchema.safeParse(body).success).toBe(true);
  });
});

// ---------- the job: sleep, wake ----------

function scheduledRun(wake: "go" | "missed" | "skip", options: { sleepUntil?: boolean } = {}) {
  const jobId = new ObjectId().toHexString();
  const at = "2026-11-28T13:30:00.000Z";
  let t = Date.parse("2026-11-26T06:00:00.000Z");
  const steps: string[] = [];
  const untils: string[] = [];
  const sleeps: number[] = [];
  const store = {
    scheduled: vi.fn(async () => ({ scheduledAt: at })),
    wake: vi.fn(async () => wake),
    // After a "go" the F30 run starts; here it finds nothing (the e2e runs the whole publish).
    start: vi.fn(async () => null),
  } as unknown as PublishJobStore;
  const publisher = vi.fn(() => ({ ok: false as const, problems: ["should never be asked"] }));
  const step = {
    run: async <T>(id: string, fn: () => Promise<T>) => {
      steps.push(id);
      return fn();
    },
    sleep: async (_id: string, ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    ...(options.sleepUntil === false
      ? {}
      : {
          sleepUntil: async (_id: string, until: Date) => {
            untils.push(until.toISOString());
            t = until.getTime();
          },
        }),
  };
  const run = () =>
    runPublishJob(
      { event: { jobId, attempt: 1 }, runId: "run-1", step },
      { store, publisher, token: vi.fn(() => "never"), videoUrl: vi.fn(async () => "never"), delays: FAKE_DELAYS, now: () => new Date(t), log: () => undefined },
    );
  return { run, steps, untils, sleeps, store, publisher, at };
}

describe("the publish job for a scheduled post", () => {
  it("sleeps until the exact time, wakes, then runs the F30 job (start → …)", async () => {
    const s = scheduledRun("go");
    expect(await s.run()).toBe("skipped"); // the fake `start` finds nothing to do
    expect(s.untils).toEqual([s.at]);
    expect(s.steps).toEqual(["schedule", "wake", "start"]);
  });
  it("cancelled or its approval cancelled by a change while it slept → ends quietly, no Instagram at all", async () => {
    const s = scheduledRun("skip");
    expect(await s.run()).toBe("skipped");
    expect(s.steps).toEqual(["schedule", "wake"]);
    expect(s.publisher).not.toHaveBeenCalled();
    expect(s.store.start).not.toHaveBeenCalled();
  });
  it("woke more than 1 hour late → missed, never posted", async () => {
    const s = scheduledRun("missed");
    expect(await s.run()).toBe("failed");
    expect(s.publisher).not.toHaveBeenCalled();
    expect(s.store.start).not.toHaveBeenCalled();
  });
  it("without sleepUntil (tests) it sleeps the difference", async () => {
    const s = scheduledRun("skip", { sleepUntil: false });
    await s.run();
    expect(s.sleeps).toEqual([Date.parse(s.at) - Date.parse("2026-11-26T06:00:00.000Z")]);
  });
});

// ---------- the transactions (fake database: the conditional filters) ----------

type Calls = { name: string; args: any[] }[];
function fakeDb(handlers: Record<string, (...args: any[]) => unknown>) {
  const calls: Calls = [];
  const collection = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => (...args: any[]) => {
          calls.push({ name: `${name}.${method}`, args });
          const handler = handlers[`${name}.${method}`];
          if (!handler) throw new Error(`unexpected ${name}.${method}`);
          return Promise.resolve(handler(...args));
        },
      },
    );
  const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: async () => undefined };
  return { db: { client: { startSession: () => session }, collection } as unknown as Db, calls };
}

function docs(postState: PostDocument["state"], options: { scheduledAt?: Date; projectState?: ProjectDocument["state"]; activeJobId?: ObjectId | null } = {}) {
  const ownerId = new ObjectId();
  const projectId = new ObjectId();
  const jobId = new ObjectId();
  const postId = new ObjectId();
  const job = { _id: jobId, ownerId, projectId, type: "publish", attempt: 1, state: "queued", inputRef: { postId }, stages: [{ name: "approve", status: "pending", startedAt: null, endedAt: null, attempts: 0, error: null }], progress: { stage: "approve", percent: 0, message: "Scheduled" }, inngestRunId: null } as unknown as JobDocument;
  const post = { _id: postId, ownerId, projectId, jobId, state: postState, mode: "scheduled", scheduledAt: options.scheduledAt ?? new Date("2026-11-28T13:30:00.000Z"), approval: { igUserId: "1784" }, destination: { username: "e2e" } } as unknown as PostDocument;
  const project = { _id: projectId, ownerId, title: "The water cycle", state: options.projectState ?? "scheduled", activeJobId: options.activeJobId ?? null, stateVersion: 9, currentRenderId: new ObjectId() } as unknown as ProjectDocument;
  return { job, post, project };
}

describe("wakeScheduledPost (the job's wake step)", () => {
  const ok = { modifiedCount: 1, matchedCount: 1 };
  it("still scheduled, on time: post → publishing and project → publishing with this job, all conditional", async () => {
    const d = docs("scheduled");
    const { db, calls } = fakeDb({ "jobs.findOne": () => d.job, "posts.findOne": () => d.post, "projects.findOne": () => d.project, "posts.updateOne": () => ok, "projects.updateOne": () => ok, "jobs.updateOne": () => ok });
    expect(await wakeScheduledPost(db, { jobId: d.job._id.toHexString(), attempt: 1, runId: "run-1", now: new Date("2026-11-28T13:30:05.000Z") })).toBe("go");
    const postWrite = calls.find((c) => c.name === "posts.updateOne")!;
    expect(postWrite.args[0]).toMatchObject({ _id: d.post._id, state: "scheduled" });
    expect(postWrite.args[1]).toMatchObject({ $set: { state: "publishing" }, $inc: { attempts: 1 } });
    const projectWrite = calls.find((c) => c.name === "projects.updateOne")!;
    expect(projectWrite.args[0]).toMatchObject({ state: "scheduled", activeJobId: null, stateVersion: 9 });
    expect(projectWrite.args[1].$set).toMatchObject({ state: "publishing", activeJobId: d.job._id });
    const jobWrite = calls.find((c) => c.name === "jobs.updateOne")!;
    expect(jobWrite.args[1].$set).toMatchObject({ inngestRunId: "run-1" });
    expect(jobWrite.args[1].$set.queuedAt).toEqual(new Date("2026-11-28T13:30:05.000Z"));
  });

  it.each(["cancelled", "approval_invalidated"] as const)("post %s → skip: nothing moves to publishing, the waiting job is marked cancelled", async (state) => {
    const d = docs(state);
    const { db, calls } = fakeDb({ "jobs.findOne": () => d.job, "posts.findOne": () => d.post, "jobs.updateMany": () => ok });
    expect(await wakeScheduledPost(db, { jobId: d.job._id.toHexString(), attempt: 1, runId: "run-1", now: new Date("2026-11-28T13:30:05.000Z") })).toBe("skip");
    expect(calls.some((c) => c.name === "posts.updateOne" || c.name === "projects.updateOne")).toBe(false);
    expect(calls.find((c) => c.name === "jobs.updateMany")!.args[1].$set).toMatchObject({ state: "cancelled" });
  });

  it("more than 1 hour late → missed: post publish_failed SCHEDULE_MISSED (not retryable), job failed, project publish_failed, a notification", async () => {
    const d = docs("scheduled");
    const { db, calls } = fakeDb({
      "jobs.findOne": () => d.job,
      "posts.findOne": () => d.post,
      "posts.updateOne": () => ok,
      "jobs.updateOne": () => ok,
      "projects.findOneAndUpdate": () => ({ ...d.project, state: "publish_failed" }),
      "notifications.insertMany": () => ({}),
      "auditLogs.insertOne": () => ({}),
    });
    expect(await wakeScheduledPost(db, { jobId: d.job._id.toHexString(), attempt: 1, runId: "run-1", now: new Date("2026-11-28T14:31:00.000Z") })).toBe("missed");
    const postWrite = calls.find((c) => c.name === "posts.updateOne")!;
    expect(postWrite.args[0]).toMatchObject({ state: "scheduled" });
    expect(postWrite.args[1].$set).toMatchObject({ state: "publish_failed", lastError: { code: "SCHEDULE_MISSED" } });
    expect(calls.find((c) => c.name === "jobs.updateOne")!.args[1].$set).toMatchObject({ state: "failed", error: { code: "SCHEDULE_MISSED", retryable: false } });
    expect(calls.find((c) => c.name === "projects.findOneAndUpdate")!.args[0]).toMatchObject({ state: "scheduled", activeJobId: null });
    const note = calls.find((c) => c.name === "notifications.insertMany")!.args[0][0];
    expect(note).toMatchObject({ type: "post_failed" });
    expect(note.message).toContain("Sat 28 Nov, 7:00 PM IST");
    expect(note.message).toContain("7:00 PM IST");
    expect(PUBLISH_FAILURES.missed.retryable).toBe(false);
  });

  it("up to 1 hour late still posts", async () => {
    const d = docs("scheduled");
    const { db } = fakeDb({ "jobs.findOne": () => d.job, "posts.findOne": () => d.post, "projects.findOne": () => d.project, "posts.updateOne": () => ok, "projects.updateOne": () => ok, "jobs.updateOne": () => ok });
    expect(await wakeScheduledPost(db, { jobId: d.job._id.toHexString(), attempt: 1, runId: "run-1", now: new Date("2026-11-28T14:30:00.000Z") })).toBe("go");
  });

  it("the same run's wake step again (its answer was lost) → go, without writing twice", async () => {
    const d = docs("publishing");
    (d.job as { inngestRunId: string | null }).inngestRunId = "run-1";
    const { db, calls } = fakeDb({ "jobs.findOne": () => d.job, "posts.findOne": () => d.post, "projects.findOne": () => ({ _id: d.project._id }) });
    expect(await wakeScheduledPost(db, { jobId: d.job._id.toHexString(), attempt: 1, runId: "run-1", now: new Date("2026-11-28T13:31:00.000Z") })).toBe("go");
    expect(calls.some((c) => c.name.endsWith("updateOne"))).toBe(false);
  });

  it("ANOTHER run finds the post already publishing → skip (only one run publishes)", async () => {
    const d = docs("publishing");
    (d.job as { inngestRunId: string | null }).inngestRunId = "run-1";
    const { db, calls } = fakeDb({ "jobs.findOne": () => d.job, "posts.findOne": () => d.post });
    expect(await wakeScheduledPost(db, { jobId: d.job._id.toHexString(), attempt: 1, runId: "run-2", now: new Date("2026-11-28T13:31:00.000Z") })).toBe("skip");
    expect(calls.some((c) => c.name.endsWith("updateOne") || c.name.endsWith("updateMany"))).toBe(false);
  });
});

describe("code review MUST 1: only the run that woke a scheduled post may publish it", () => {
  const ok = { modifiedCount: 1, matchedCount: 1 };
  it("scheduledWait gives the time to EVERY attempt-1 run of a scheduled post, whatever its state; none to Try again or Publish now", async () => {
    const d = docs("publishing");
    const { db } = fakeDb({ "jobs.findOne": () => d.job, "posts.findOne": (filter: { mode?: string }) => (filter.mode === "scheduled" ? d.post : null) });
    expect(await scheduledWait(db, { jobId: d.job._id.toHexString(), attempt: 1 })).toEqual({ scheduledAt: d.post.scheduledAt!.toISOString() });
    expect(await scheduledWait(db, { jobId: d.job._id.toHexString(), attempt: 2 })).toBeNull();
    const now = fakeDb({ "jobs.findOne": () => d.job, "posts.findOne": () => null });
    expect(await scheduledWait(now.db, { jobId: d.job._id.toHexString(), attempt: 1 })).toBeNull();
  });

  it("a second run that starts AFTER the first woke the post: schedule → wake says skip → no Instagram call at all", async () => {
    const d = docs("publishing");
    (d.job as { inngestRunId: string | null }).inngestRunId = "run-1";
    const { db, calls } = fakeDb({ "jobs.findOne": () => d.job, "posts.findOne": (filter: { mode?: string }) => (filter.mode === "scheduled" || filter.mode === undefined ? d.post : null) });
    const publisher = vi.fn(() => ({ ok: false as const, problems: ["never"] }));
    const store = {
      scheduled: (input: { jobId: string; attempt: number }) => scheduledWait(db, input),
      wake: (input: { jobId: string; attempt: number; runId: string | null }) => wakeScheduledPost(db, { ...input, now: new Date("2026-11-28T13:31:00.000Z") }),
      start: vi.fn(async () => null),
    } as unknown as PublishJobStore;
    const steps: string[] = [];
    const out = await runPublishJob(
      {
        event: { jobId: d.job._id.toHexString(), attempt: 1 },
        runId: "run-2",
        step: { run: async (id, fn) => (steps.push(id), fn()), sleep: async () => undefined, sleepUntil: async () => undefined },
      },
      { store, publisher, token: vi.fn(() => "never"), videoUrl: vi.fn(async () => "never"), delays: FAKE_DELAYS, now: () => new Date("2026-11-28T13:31:00.000Z"), log: () => undefined },
    );
    expect(out).toBe("skipped");
    expect(steps).toEqual(["schedule", "wake"]);
    expect(store.start).not.toHaveBeenCalled();
    expect(publisher).not.toHaveBeenCalled();
    expect(calls.some((c) => c.name.endsWith("updateOne") || c.name.endsWith("updateMany") || c.name.endsWith("findOneAndUpdate"))).toBe(false);
  });

  it("startPublishAttempt refuses a scheduled post's first attempt for any run but the one that woke it", async () => {
    const d = docs("publishing");
    (d.job as { inngestRunId: string | null }).inngestRunId = "run-1";
    const project = { ...d.project, state: "publishing", activeJobId: d.job._id };
    const handlers = { "jobs.findOne": () => d.job, "posts.findOne": () => d.post, "projects.findOne": () => project, "jobs.findOneAndUpdate": () => d.job };
    const other = fakeDb(handlers);
    expect(await startPublishAttempt(other.db, { jobId: d.job._id.toHexString(), attempt: 1, runId: "run-2" })).toBeNull();
    expect(other.calls.some((c) => c.name === "jobs.findOneAndUpdate")).toBe(false);
    expect(await startPublishAttempt(fakeDb(handlers).db, { jobId: d.job._id.toHexString(), attempt: 1, runId: null })).toBeNull();
    const same = fakeDb(handlers);
    expect(await startPublishAttempt(same.db, { jobId: d.job._id.toHexString(), attempt: 1, runId: "run-1" })).not.toBeNull();
  });

  it("the stuck-job rule never re-sends a sleeping scheduled job's event after its time (only one never handed over)", async () => {
    const d = docs("scheduled", { scheduledAt: new Date("2026-11-28T13:30:00.000Z") });
    const sent = { ...d.job, event: { id: "pubjob:x", sentAt: new Date("2026-11-26T06:00:00.000Z"), lastTriedAt: null }, queuedAt: new Date("2026-11-26T06:00:00.000Z") } as unknown as JobDocument;
    const a = fakeDb({ "posts.findOne": () => d.post });
    expect((await checkStuckJob(a.db, sent, new Date("2026-11-28T13:35:00.000Z"))).resendEventId).toBeNull();
    expect(a.calls.map((c) => c.name)).toEqual(["posts.findOne"]);
    const unsent = { ...sent, event: { id: "pubjob:x", sentAt: null, lastTriedAt: null } } as unknown as JobDocument;
    const b = fakeDb({ "posts.findOne": () => d.post, "jobs.updateOne": () => ok });
    expect((await checkStuckJob(b.db, unsent, new Date("2026-11-26T06:01:00.000Z"))).resendEventId).toBe("pubjob:x");
  });
});

describe("H5 cancelScheduledPost", () => {
  const ok = { modifiedCount: 1, matchedCount: 1 };
  it.each(["scheduled", "approval_invalidated"] as const)("%s → cancelled (conditional), the waiting job cancelled, the project back to video_ready, audit", async (state) => {
    const d = docs(state);
    const { db, calls } = fakeDb({
      "posts.findOne": () => d.post,
      "posts.findOneAndUpdate": (_f: unknown, u: { $set: object }) => ({ ...d.post, ...u.$set }),
      "jobs.updateMany": () => ok,
      "projects.findOne": () => d.project,
      "projects.findOneAndUpdate": (_f: unknown, u: { $set: object }) => ({ ...d.project, ...u.$set }),
      "auditLogs.insertOne": () => ({}),
    });
    const out = await cancelScheduledPost(db, { ownerId: d.post.ownerId.toHexString(), postId: d.post._id.toHexString() });
    expect(out.changed).toBe(true);
    expect(out.post.state).toBe("cancelled");
    expect(out.cancelledJobId).toEqual(d.job._id);
    expect(calls.find((c) => c.name === "posts.findOneAndUpdate")!.args[0]).toMatchObject({ state });
    expect(out.project?.state).toBe("video_ready");
    expect(calls.find((c) => c.name === "auditLogs.insertOne")!.args[0]).toMatchObject({ action: "post.cancelled" });
  });

  it("already cancelled → 200 with the post, nothing written", async () => {
    const d = docs("cancelled");
    const { db, calls } = fakeDb({ "posts.findOne": () => d.post });
    const out = await cancelScheduledPost(db, { ownerId: d.post.ownerId.toHexString(), postId: d.post._id.toHexString() });
    expect(out.changed).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(["posts.findOne"]);
  });

  it.each([
    ["publishing", POST_MESSAGES.CANCEL_PUBLISHING],
    ["outcome_unknown", POST_MESSAGES.CANCEL_PUBLISHING],
    ["published", POST_MESSAGES.CANCEL_NOT_ALLOWED],
    ["publish_failed", POST_MESSAGES.CANCEL_NOT_ALLOWED],
  ] as const)("%s → 409 INVALID_STATE, nothing written", async (state, message) => {
    const d = docs(state);
    const { db, calls } = fakeDb({ "posts.findOne": () => d.post });
    await expect(cancelScheduledPost(db, { ownerId: d.post.ownerId.toHexString(), postId: d.post._id.toHexString() })).rejects.toMatchObject({ code: "INVALID_STATE", message });
    expect(calls).toHaveLength(1);
  });

  it("someone else's / a missing post / a bad id → 404", async () => {
    const { db } = fakeDb({ "posts.findOne": () => null });
    await expect(cancelScheduledPost(db, { ownerId: new ObjectId().toHexString(), postId: new ObjectId().toHexString() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(cancelScheduledPost(db, { ownerId: new ObjectId().toHexString(), postId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("while a revision of the project runs, the project is left alone (the revision sets its state)", async () => {
    const d = docs("approval_invalidated", { activeJobId: new ObjectId() });
    const { db, calls } = fakeDb({
      "posts.findOne": () => d.post,
      "posts.findOneAndUpdate": (_f: unknown, u: { $set: object }) => ({ ...d.post, ...u.$set }),
      "jobs.updateMany": () => ({ modifiedCount: 0 }),
      "projects.findOne": () => d.project,
      "auditLogs.insertOne": () => ({}),
    });
    const out = await cancelScheduledPost(db, { ownerId: d.post.ownerId.toHexString(), postId: d.post._id.toHexString() });
    expect(calls.some((c) => c.name === "projects.findOneAndUpdate")).toBe(false);
    expect(out.cancelledJobId).toBeNull();
  });
});

describe("H6 Try again refuses a missed post (a new approval is needed)", () => {
  it("409 INVALID_STATE schedule_missed, before anything else is read", async () => {
    const d = docs("publish_failed");
    (d.post as { lastError: unknown }).lastError = { code: "SCHEDULE_MISSED", message: "x", at: NOW };
    const { db, calls } = fakeDb({ "posts.findOne": () => d.post });
    await expect(retryPost(db, { ownerId: d.post.ownerId.toHexString(), postId: d.post._id.toHexString(), respond: () => ({ status: 202, body: {} }) })).rejects.toMatchObject({
      code: "INVALID_STATE",
      message: SCHEDULE_MESSAGES.MISSED_REFUSED,
      details: { reason: "schedule_missed" },
    });
    expect(calls).toHaveLength(1);
  });
});

describe("a change cancels a scheduled post's approval AND its waiting job (invalidateOpenPosts)", () => {
  it("post scheduled → approval_invalidated (conditional) + notification; its queued job → cancelled", async () => {
    const d = docs("scheduled");
    const { db, calls } = fakeDb({
      "posts.find": () => ({ toArray: async () => [{ _id: d.post._id, projectId: d.post.projectId, state: "scheduled", jobId: d.job._id }] }),
      "projects.find": () => ({ toArray: async () => [{ _id: d.post.projectId, title: "The water cycle" }] }),
      "posts.updateOne": () => ({ modifiedCount: 1 }),
      "jobs.updateMany": () => ({ modifiedCount: 1 }),
      "notifications.insertMany": () => ({}),
    });
    // find() is synchronous in the driver: the fake returns a promise, so wrap it.
    const sync = new Proxy(db, { get: (t, k) => (k === "collection" ? (name: string) => syncFind((t as Db).collection(name)) : (t as never)[k]) });
    const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: async () => undefined };
    expect(await invalidateOpenPosts(sync as Db, session as never, { ownerId: d.post.ownerId, projectId: d.post.projectId, reason: "narration_edit", now: NOW })).toBe(1);
    expect(calls.find((c) => c.name === "posts.updateOne")!.args[0]).toMatchObject({ _id: d.post._id, state: "scheduled" });
    const jobs = calls.find((c) => c.name === "jobs.updateMany")!;
    expect(jobs.args[0]).toMatchObject({ type: "publish", state: "queued" });
    expect(jobs.args[1].$set).toMatchObject({ state: "cancelled" });
    expect(calls.find((c) => c.name === "notifications.insertMany")!.args[0][0]).toMatchObject({ type: "approval_invalidated" });
  });
});

/** The driver's find() returns a cursor synchronously; the fake's proxy returns a promise. */
function syncFind(collection: object) {
  return new Proxy(collection, {
    get: (t, k) =>
      k === "find"
        ? (...args: unknown[]) => ({ toArray: async () => (await ((t as Record<string, (...a: unknown[]) => Promise<{ toArray: () => Promise<unknown[]> }>>).find!(...args))).toArray() })
        : (t as Record<string | symbol, unknown>)[k],
  });
}

// ---------- allowedActions and the dashboard card ----------

function project(state: ProjectDocument["state"]): ProjectDocument {
  const v = new ObjectId();
  return { _id: new ObjectId(), ownerId: new ObjectId(), schemaVersion: 1, title: "T", language: "en", voiceGender: "female", input: { type: "topic", text: "T", brainstormChoice: null }, state, currentPlanVersionId: v, approvedPlanVersionId: v, currentRenderId: new ObjectId(), activeJobId: null, stateVersion: 3, planRequestCount: 1, lastError: null, createdAt: NOW, updatedAt: NOW, archivedAt: null };
}

describe("allowedActions (F31)", () => {
  const post = (state: PostDocument["state"], code?: string) => ({ state, lastError: code ? { code, message: "x", at: NOW } : null });
  it("scheduled: cancel_post (no publish while it waits)", () => {
    const actions = allowedActionsFor(project("scheduled"), null, null, { latestPost: post("scheduled") });
    expect(actions).toContain("cancel_post");
    expect(actions).not.toContain("publish");
    expect(actions).not.toContain("retry_post");
  });
  it("scheduled with a cancelled approval: publish (approve again) and cancel_post", () => {
    const actions = allowedActionsFor(project("scheduled"), null, null, { latestPost: post("approval_invalidated") });
    expect(actions).toEqual(expect.arrayContaining(["publish", "cancel_post"]));
  });
  it("missed: publish (a new approval), never retry_post", () => {
    const actions = allowedActionsFor(project("publish_failed"), null, null, { latestPost: post("publish_failed", "SCHEDULE_MISSED") });
    expect(actions).toContain("publish");
    expect(actions).not.toContain("retry_post");
    expect(allowedActionsFor(project("publish_failed"), null, null, { latestPost: post("publish_failed", "PUBLISH_FAILED") })).toContain("retry_post");
  });
});

describe("the dashboard card (F31)", () => {
  const summary = (state: PostDocument["state"]) =>
    ({ state: "scheduled", activeJobType: null, storyboardApproved: true, latestPost: { id: "x", state, mode: "scheduled", scheduledAt: "2026-11-28T13:30:00.000Z", permalink: null } }) as const;
  it("shows the time in India time, and 'Needs approval' after a change", () => {
    expect(scheduledLine(summary("scheduled"))).toBe("Sat 28 Nov, 7:00 PM IST");
    expect(cardStatus(summary("scheduled")).label).toBe("Scheduled");
    expect(cardStatus(summary("approval_invalidated")).label).toBe("Needs approval");
    expect(scheduledLine({ state: "video_ready", latestPost: null })).toBeNull();
    expect(scheduledLine({ ...summary("cancelled") })).toBeNull();
  });
});
