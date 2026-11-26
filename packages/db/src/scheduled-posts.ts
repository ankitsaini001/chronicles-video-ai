import { type ClientSession, type Db, ObjectId } from "mongodb";
import { AUDIT_LOGS_COLLECTION } from "./collections";
import { JOBS_COLLECTION, type JobDocument } from "./jobs";
import { insertNotifications, newNotification, POST_NOTIFICATIONS } from "./notifications";
import { cancelWaitingPublishJobs, POSTS_COLLECTION, type PostDocument, type PostState } from "./post-approval";
import { istDateTimeLabel, isScheduleMissed } from "./post-schedule";
import { POST_MESSAGES, PUBLISH_FAILURES, PUBLISH_MESSAGES } from "./posts";
import { POST_OPEN_PROJECT_STATES, ProjectActionError, PROJECTS_COLLECTION, type ProjectDocument } from "./projects";

// F31 "Schedule a post" (API.md H2 `mode: "scheduled"`, H5; DATABASE.md §4.22; ARCHITECTURE §17.4;
// founder decisions 2026-11-26). The SAME publish job and every F30 protection; only the start differs:
// - H2 saves the post `scheduled`, its job `queued`, the project `scheduled` (no activeJobId) and sends
//   `post.publish.requested` at once. The job (`publish-post`) reads the time (scheduledWait), sleeps
//   until it (Inngest step.sleepUntil), then wakes (wakeScheduledPost): ONE transaction, conditional on
//   the post still being `scheduled` → `publishing`, the project → `publishing` with this job as its
//   active job. Then the F30 run as is: `start`, the full approval re-check (approve), container, poll,
//   the re-check right before media_publish, the claim, reconcile.
// - Anything that changed meanwhile (cancel, a change that cancelled the approval, archive) moved the
//   post away from `scheduled` in its own transaction, so the wake finds nothing to do and ends quietly:
//   no Instagram call. The post's state is the real guard.
// - Missed (decision 3): more than 1 hour after its time and still `scheduled` → never posted:
//   `publish_failed` with SCHEDULE_MISSED (not retryable), the job `failed`, the project `publish_failed`,
//   a notification. Found by the job when it wakes late, or at read time (stuck-jobs.ts) when the job
//   never woke (e.g. the Inngest Dev Server restarted and forgot the sleep). No cron.
// - H5 (cancelScheduledPost): `scheduled` / `approval_invalidated` → `cancelled`, the waiting job
//   `cancelled`, the project → `video_ready`.

const posts = (db: Db) => db.collection<PostDocument>(POSTS_COLLECTION);
const isHex = (id: string) => /^[0-9a-f]{24}$/.test(id);

async function audit(db: Db, session: ClientSession, input: { actorId: ObjectId; action: string; postId: ObjectId; data: Record<string, unknown>; now: Date }): Promise<void> {
  await db.collection(AUDIT_LOGS_COLLECTION).insertOne({ schemaVersion: 1, actorId: input.actorId, action: input.action, subject: { type: "post", id: input.postId }, data: input.data, at: input.now }, { session });
}

/** The job's first step for a scheduled post: when to wake (ISO), or null when this run doesn't wait (a Publish now post, a Try again, or nothing left to do). */
export async function scheduledWait(db: Db, input: { jobId: string; attempt: number }): Promise<{ scheduledAt: string } | null> {
  if (!isHex(input.jobId)) return null;
  const job = await db.collection<JobDocument>(JOBS_COLLECTION).findOne({ _id: new ObjectId(input.jobId), type: "publish", attempt: input.attempt, state: "queued" });
  if (!job?.inputRef.postId) return null;
  const post = await posts(db).findOne({ _id: job.inputRef.postId, ownerId: job.ownerId, jobId: job._id, state: "scheduled" }, { projection: { scheduledAt: 1 } });
  return post?.scheduledAt ? { scheduledAt: post.scheduledAt.toISOString() } : null;
}

export type WakeOutcome = "go" | "missed" | "skip";

/**
 * Inside the caller's transaction: a scheduled post that missed its time → never posted (decision 3).
 * Post `publish_failed` (SCHEDULE_MISSED), the waiting job `failed`, the project → `publish_failed`
 * (only while it is still `scheduled` for this post: no job of its own runs), notification `post_failed`
 * with the missed words, audit `post.missed`. False when the post is no longer `scheduled`.
 */
async function endAsMissed(db: Db, session: ClientSession, input: { job: JobDocument; post: PostDocument; now: Date; via: "job" | "read" }): Promise<boolean> {
  const { job, post, now } = input;
  const { code, message, retryable } = PUBLISH_FAILURES.missed;
  const moved = await posts(db).updateOne(
    { _id: post._id, jobId: job._id, state: "scheduled" },
    { $set: { state: "publish_failed", lastError: { code, message, at: now }, nextAttemptAt: null, updatedAt: now } },
    { session },
  );
  if (moved.modifiedCount !== 1) return false;
  await db.collection<JobDocument>(JOBS_COLLECTION).updateOne(
    { _id: job._id, state: "queued" },
    {
      $set: {
        state: "failed",
        stages: job.stages.map((s, i) => (i === 0 ? { ...s, status: "failed" as const, startedAt: s.startedAt ?? now, endedAt: now, error: { code, message } } : s)),
        progress: { ...job.progress, message },
        error: { code, message, retryable },
        finishedAt: now,
        updatedAt: now,
      },
    },
    { session },
  );
  const project = await db
    .collection<ProjectDocument>(PROJECTS_COLLECTION)
    .findOneAndUpdate(
      { _id: post.projectId, ownerId: post.ownerId, state: "scheduled", activeJobId: null },
      { $set: { state: "publish_failed", lastError: { code, message, at: now }, updatedAt: now }, $inc: { stateVersion: 1 } },
      { session, returnDocument: "after" },
    );
  const title = project?.title ?? (await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: post.projectId }, { session, projection: { title: 1 } }))?.title ?? "Your video";
  const words = POST_NOTIFICATIONS.post_missed(title, istDateTimeLabel(post.scheduledAt ?? now));
  await insertNotifications(db, session, [newNotification({ ownerId: post.ownerId, type: "post_failed", projectId: post.projectId, postId: post._id, ...words, now })]);
  await audit(db, session, { actorId: post.ownerId, action: "post.missed", postId: post._id, data: { projectId: post.projectId, scheduledAt: post.scheduledAt, via: input.via }, now });
  return true;
}

/**
 * The job wakes at the scheduled time, ONE transaction (decision 4):
 * - the post is no longer `scheduled` (cancelled, its approval cancelled by a change, archived) →
 *   `skip`: nothing is sent (a still-waiting job is marked cancelled);
 * - more than 1 hour late → `missed` (endAsMissed), nothing is sent;
 * - the project isn't waiting for it (`scheduled` with no job of its own) → the post fails with
 *   APPROVAL_STALE (approve again), nothing is sent;
 * - else `go`: post → `publishing` (attempts + 1), project → `publishing` with this job as its active job
 *   (+1 stateVersion), the job stays `queued` with `queuedAt` = now (the F30 run's `start` makes it
 *   running) and records this run. A repeat of the step by the same run answers `go` again.
 */
export async function wakeScheduledPost(db: Db, input: { jobId: string; attempt: number; runId: string | null; now?: Date }): Promise<WakeOutcome> {
  const now = input.now ?? new Date();
  if (!isHex(input.jobId)) return "skip";
  const session = db.client.startSession();
  let outcome: WakeOutcome = "skip";
  try {
    await session.withTransaction(async () => {
      outcome = "skip";
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = await jobs.findOne({ _id: new ObjectId(input.jobId), type: "publish", attempt: input.attempt }, { session });
      if (!job?.inputRef.postId) return;
      const post = await posts(db).findOne({ _id: job.inputRef.postId, ownerId: job.ownerId, jobId: job._id }, { session });
      if (!post) return;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      // The same run's step again (its first answer was lost): it already woke the post.
      if (post.state === "publishing" && input.runId !== null && job.inngestRunId === input.runId && job.state === "queued") {
        const project = await projects.findOne({ _id: post.projectId, ownerId: post.ownerId, activeJobId: job._id, state: "publishing" }, { session, projection: { _id: 1 } });
        if (project) outcome = "go";
        return;
      }
      if (post.state !== "scheduled" || job.state !== "queued") {
        if (job.state === "queued" && post.state !== "publishing" && post.state !== "outcome_unknown") await cancelWaitingPublishJobs(db, session, { ownerId: job.ownerId, jobIds: [job._id], now });
        return;
      }
      if (!post.scheduledAt || isScheduleMissed(post.scheduledAt, now)) {
        if (await endAsMissed(db, session, { job, post, now, via: "job" })) outcome = "missed";
        return;
      }
      const project = await projects.findOne({ _id: post.projectId, ownerId: post.ownerId }, { session });
      if (!project || project.state !== "scheduled" || project.activeJobId !== null) {
        // Should not happen (every change moves the post away from `scheduled`): never post on a doubt.
        const { code, message, retryable } = PUBLISH_FAILURES.approval_stale;
        await posts(db).updateOne({ _id: post._id, state: "scheduled" }, { $set: { state: "publish_failed", lastError: { code, message, at: now }, updatedAt: now } }, { session });
        await jobs.updateOne({ _id: job._id, state: "queued" }, { $set: { state: "failed", error: { code, message, retryable }, progress: { ...job.progress, message }, finishedAt: now, updatedAt: now } }, { session });
        return;
      }
      const woke = await posts(db).updateOne({ _id: post._id, jobId: job._id, state: "scheduled" }, { $set: { state: "publishing", updatedAt: now }, $inc: { attempts: 1 } }, { session });
      if (woke.modifiedCount !== 1) return;
      const moved = await projects.updateOne(
        { _id: project._id, ownerId: project.ownerId, state: "scheduled", activeJobId: null, stateVersion: project.stateVersion },
        { $set: { state: "publishing", activeJobId: job._id, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      if (moved.modifiedCount !== 1) throw new Error("The project changed while the scheduled post woke up; the transaction is retried.");
      await jobs.updateOne(
        { _id: job._id, attempt: job.attempt, state: "queued" },
        { $set: { queuedAt: now, progress: { stage: "approve", percent: 0, message: PUBLISH_MESSAGES.QUEUED }, ...(input.runId ? { inngestRunId: input.runId } : {}), updatedAt: now } },
        { session },
      );
      outcome = "go";
    });
  } finally {
    await session.endSession();
  }
  return outcome;
}

/**
 * The read-time missed rule (decision 3b; called by the stuck-job rule): a scheduled post more than
 * 1 hour past its time whose job never woke → missed (endAsMissed). True when it changed something.
 */
export async function settleMissedSchedule(db: Db, input: { jobId: ObjectId; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let changed = false;
  try {
    await session.withTransaction(async () => {
      changed = false;
      const job = await db.collection<JobDocument>(JOBS_COLLECTION).findOne({ _id: input.jobId, type: "publish", state: "queued" }, { session });
      if (!job?.inputRef.postId) return;
      const post = await posts(db).findOne({ _id: job.inputRef.postId, ownerId: job.ownerId, jobId: job._id, state: "scheduled" }, { session });
      if (!post?.scheduledAt || !isScheduleMissed(post.scheduledAt, now)) return;
      changed = await endAsMissed(db, session, { job, post, now, via: "read" });
    });
  } finally {
    await session.endSession();
  }
  return changed;
}

/** The post that a waiting (queued) publish job is for, when that post is still `scheduled` (read-only). */
export async function waitingScheduledPost(db: Db, job: Pick<JobDocument, "_id" | "ownerId" | "inputRef" | "type">): Promise<PostDocument | null> {
  if (job.type !== "publish" || !job.inputRef.postId) return null;
  return posts(db).findOne({ _id: job.inputRef.postId, ownerId: job.ownerId, jobId: job._id, state: "scheduled" });
}

export type CancelPostResult = { post: PostDocument; project: ProjectDocument | null; cancelledJobId: ObjectId | null; changed: boolean };

const CANCELLABLE: readonly PostState[] = ["scheduled", "approval_invalidated"];

/**
 * H5 "Cancel schedule" (API.md H5), ONE transaction, owner only: a `scheduled` or `approval_invalidated`
 * post → `cancelled` (conditional on its state); its waiting job → `cancelled`; the project → `video_ready`
 * (+1 stateVersion) while it is still on the publish step for it (`scheduled` / `publish_failed`, no job
 * of its own running); audit
 * `post.cancelled`. Already `cancelled` → the post as it is (`changed: false`). Refused: 404 (missing,
 * someone else's, bad id) · 409 INVALID_STATE while it is being published, or once it is published/failed.
 */
export async function cancelScheduledPost(db: Db, input: { ownerId: string; postId: string; now?: Date }): Promise<CancelPostResult> {
  const now = input.now ?? new Date();
  if (!isHex(input.ownerId) || !isHex(input.postId)) throw new ProjectActionError("NOT_FOUND", POST_MESSAGES.POST_NOT_FOUND);
  const ownerId = new ObjectId(input.ownerId);
  const session = db.client.startSession();
  let result: CancelPostResult | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const post = await posts(db).findOne({ _id: new ObjectId(input.postId), ownerId }, { session });
      if (!post) throw new ProjectActionError("NOT_FOUND", POST_MESSAGES.POST_NOT_FOUND);
      if (post.state === "cancelled") {
        result = { post, project: null, cancelledJobId: null, changed: false };
        return;
      }
      if (post.state === "publishing" || post.state === "outcome_unknown") throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.CANCEL_PUBLISHING, { postState: post.state });
      if (!CANCELLABLE.includes(post.state)) throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.CANCEL_NOT_ALLOWED, { postState: post.state });
      const updated = await posts(db).findOneAndUpdate(
        { _id: post._id, ownerId, state: post.state },
        { $set: { state: "cancelled", nextAttemptAt: null, updatedAt: now } },
        { session, returnDocument: "after" },
      );
      if (!updated) throw new ProjectActionError("STALE_VERSION", "This post changed in another tab, refresh.");
      const cancelled = post.jobId ? await cancelWaitingPublishJobs(db, session, { ownerId, jobIds: [post.jobId], now }) : 0;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const project = await projects.findOne({ _id: post.projectId, ownerId }, { session });
      const moved =
        // Not while another job of the project runs (e.g. the revision that cancelled the approval): it sets the state itself.
        project && POST_OPEN_PROJECT_STATES.includes(project.state) && project.currentRenderId !== null && project.activeJobId === null
          ? await projects.findOneAndUpdate(
              { _id: project._id, ownerId, stateVersion: project.stateVersion, state: project.state, activeJobId: null },
              { $set: { state: "video_ready", lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
              { session, returnDocument: "after" },
            )
          : project;
      await audit(db, session, { actorId: ownerId, action: "post.cancelled", postId: post._id, data: { projectId: post.projectId, from: post.state, scheduledAt: post.scheduledAt }, now });
      result = { post: updated, project: moved, cancelledJobId: cancelled > 0 ? post.jobId : null, changed: true };
    });
  } finally {
    await session.endSession();
  }
  return result!;
}
