import type { Db } from "mongodb";
import { endCaptionJob } from "./caption-fixes";
import { endGenerateJob, lastGenerateActivity } from "./generate-jobs";
import { getJob, JOBS_COLLECTION, type JobDocument } from "./jobs";
import { failPlanJob, STUCK_JOB_RULES } from "./plan-jobs";
import { SCHEDULE_LIMITS } from "./post-schedule";
import { endPublishJob } from "./posts";
import { settleMissedSchedule, waitingScheduledPost } from "./scheduled-posts";
import { failReviseJob } from "./revisions";

// The stuck-job rule (ARCHITECTURE §20.3, DATABASE.md Q11, API.md §8.5), checked whenever the status
// of an active job is read (C6, C3, C1, E1, the project pages), so nothing waits forever and no cron is
// needed yet.
// For `plan` jobs (F15) and `revise` jobs (F18):
// - running with no update for 10 min → failed (INTERNAL, retryable): the run died;
// - queued for 15 min → failed (INTERNAL, retryable): Inngest never started it.
// For `generate` jobs (F23): only ONE video is made at a time, app-wide, so a video job may wait
// behind others ("Waiting to start…") and must never be failed for waiting. It is failed (INTERNAL,
// retryable) only when NOTHING in the video queue has moved for 15 min: neither this job (its own
// progress, or since it was queued) nor any other video job (their progress, start or finish). A
// render writes progress every few seconds, so a long render keeps the whole queue alive. A running
// video job whose Cancel was pressed and that hasn't moved for a minute is ended as cancelled.
// `caption` jobs (F25) re-render a video and share the SAME queue, so the same rule applies to them
// (the queue counts both types); a stuck or abandoned caption job ends with the project back at
// `video_ready` and the previous video still its video.
// For all three: queued and its start event not handed over (or sent but not started after 2 min)
// → the caller sends the event again; the same event id means Inngest drops it if the first one
// did arrive. Only one reader claims a resend (conditional update on `event.lastTriedAt`).
// A failed plan job leaves the project `plan_failed`; a failed revise job leaves the storyboard as it
// was; a failed generate job leaves the project `generate_failed` (an older video stays its video).
// `publish` jobs (F30) follow the plan-job rule (they write progress at least every ~20 s while they
// run, and give up by themselves after ~10 min): running with no update for 10 min, or queued for
// 15 min → failed (INTERNAL, retryable): the post and project become `publish_failed` (Try again; a
// publish that may have gone out is checked on Instagram first).
// F31: a SCHEDULED post's job waits `queued` (sleeping in Inngest) until its time, so it is never
// failed for waiting. Instead: more than 1 hour past its time and still `scheduled` → missed
// (settleMissedSchedule: never posted, Publish now or Schedule again). Its start event is sent again
// only when it was never handed over, or when the time passed 2 minutes ago and the job hasn't woken
// (e.g. the Inngest Dev Server restarted and forgot the sleep): the same event id, so Inngest drops it
// if the first run is still there, and the wake step lets only one run publish.

/** Generate jobs: failed only when the whole video queue has been still for this long. */
export const GENERATE_IDLE_LIMIT_MS = 15 * 60_000;
/** Generate jobs: Cancel was pressed and the job hasn't moved for this long (the worker is gone): cancelled. */
export const GENERATE_CANCEL_GRACE_MS = 60_000;

/**
 * Pure: is this generate job stuck? `lastOtherActivity` is when any other video job last moved.
 * Running: counted from its own last update. Queued: from when it was queued. Either way, never
 * while another video job moved within the limit (it is waiting for its turn, not stuck).
 */
export function isGenerateJobStuck(job: Pick<JobDocument, "state" | "updatedAt" | "queuedAt">, lastOtherActivity: Date | null, now: Date): boolean {
  if (job.state !== "running" && job.state !== "queued") return false;
  const own = (job.state === "running" ? job.updatedAt : job.queuedAt).getTime();
  const since = Math.max(own, lastOtherActivity?.getTime() ?? 0);
  return now.getTime() - since >= GENERATE_IDLE_LIMIT_MS;
}

export type StuckCheck = { job: JobDocument; resendEventId: string | null };

export async function checkStuckJob(db: Db, job: JobDocument, now: Date = new Date()): Promise<StuckCheck> {
  if (job.type !== "plan" && job.type !== "revise" && job.type !== "generate" && job.type !== "caption" && job.type !== "publish") return { job, resendEventId: null };
  const at = now.getTime();
  const reload = async () => (await getJob(db, job._id)) ?? job;

  if (job.type === "generate" || job.type === "caption") {
    // The job's own end: generate → generate_failed / the storyboard; caption → back to video_ready.
    const endJob = job.type === "caption" ? endCaptionJob : endGenerateJob;
    // Cancel was pressed but nothing stopped the job (the worker died between steps): end it as cancelled.
    if (job.state === "running" && job.cancelRequestedAt && at - job.updatedAt.getTime() >= GENERATE_CANCEL_GRACE_MS) {
      await endJob(db, { jobId: job._id, attempt: job.attempt, outcome: "cancelled", staleBefore: new Date(at - GENERATE_CANCEL_GRACE_MS), now });
      return { job: await reload(), resendEventId: null };
    }
    const own = (job.state === "running" ? job.updatedAt : job.queuedAt).getTime();
    // Cheap first: only look at the rest of the queue when this job itself has been still that long.
    if ((job.state === "running" || job.state === "queued") && at - own >= GENERATE_IDLE_LIMIT_MS && isGenerateJobStuck(job, await lastGenerateActivity(db, job._id), now)) {
      const cutoff = new Date(at - GENERATE_IDLE_LIMIT_MS);
      await endJob(db, {
        jobId: job._id,
        attempt: job.attempt,
        outcome: "failed",
        code: "INTERNAL",
        detail: job.state === "running" ? "No progress for 15 minutes while nothing else moved (stuck-job rule)" : "Never started while nothing else moved (stuck-job rule)",
        ...(job.state === "running" ? { staleBefore: cutoff } : { queuedBefore: cutoff }),
        now,
      });
      return { job: await reload(), resendEventId: null };
    }
  } else if (job.type === "publish") {
    const waiting = job.state === "queued" ? await waitingScheduledPost(db, job) : null;
    if (waiting?.scheduledAt) {
      const due = waiting.scheduledAt.getTime();
      if (at > due + SCHEDULE_LIMITS.missedAfterMs) {
        await settleMissedSchedule(db, { jobId: job._id, now });
        return { job: await reload(), resendEventId: null };
      }
      // Sleeping until its time: not stuck. Resend only when it was never handed over, or it should have woken.
      const lastTried = job.event.lastTriedAt?.getTime() ?? null;
      const resend = job.event.sentAt
        ? at - due >= STUCK_JOB_RULES.sentResendMs && (lastTried === null || at - lastTried >= STUCK_JOB_RULES.sentResendMs)
        : lastTried === null || at - lastTried >= STUCK_JOB_RULES.unsentResendMs;
      if (!resend) return { job, resendEventId: null };
      const claimed = await db
        .collection<JobDocument>(JOBS_COLLECTION)
        .updateOne({ _id: job._id, state: "queued", attempt: job.attempt, "event.id": job.event.id, "event.lastTriedAt": job.event.lastTriedAt }, { $set: { "event.lastTriedAt": now } });
      return { job, resendEventId: claimed.matchedCount === 1 ? job.event.id : null };
    }
    if (job.state === "running" && at - job.updatedAt.getTime() >= STUCK_JOB_RULES.runningStaleMs) {
      // No progress for 10 minutes (stuck-job rule): the plain "Something went wrong" line, retryable.
      await endPublishJob(db, { jobId: job._id, attempt: job.attempt, failure: "internal", staleBefore: new Date(at - STUCK_JOB_RULES.runningStaleMs), now });
      return { job: await reload(), resendEventId: null };
    }
    if (job.state === "queued" && at - job.queuedAt.getTime() >= STUCK_JOB_RULES.queuedGiveUpMs) {
      // Never started (stuck-job rule).
      await endPublishJob(db, { jobId: job._id, attempt: job.attempt, failure: "internal", stage: "approve", queuedBefore: new Date(at - STUCK_JOB_RULES.queuedGiveUpMs), now });
      return { job: await reload(), resendEventId: null };
    }
  } else {
    const fail = job.type === "plan" ? failPlanJob : failReviseJob;
    if (job.state === "running" && at - job.updatedAt.getTime() >= STUCK_JOB_RULES.runningStaleMs) {
      await fail(db, { jobId: job._id, attempt: job.attempt, code: "INTERNAL", stage: "plan", detail: "No progress for 10 minutes (stuck-job rule)", staleBefore: new Date(at - STUCK_JOB_RULES.runningStaleMs), now });
      return { job: await reload(), resendEventId: null };
    }
    if (job.state === "queued" && at - job.queuedAt.getTime() >= STUCK_JOB_RULES.queuedGiveUpMs) {
      await fail(db, { jobId: job._id, attempt: job.attempt, code: "INTERNAL", stage: "plan", detail: "Never started (stuck-job rule)", queuedBefore: new Date(at - STUCK_JOB_RULES.queuedGiveUpMs), now });
      return { job: await reload(), resendEventId: null };
    }
  }

  if (job.state !== "queued") return { job, resendEventId: null };
  const lastTried = job.event.lastTriedAt?.getTime() ?? null;
  const due = job.event.sentAt
    ? at - job.queuedAt.getTime() >= STUCK_JOB_RULES.sentResendMs && (lastTried === null || at - lastTried >= STUCK_JOB_RULES.sentResendMs)
    : lastTried === null || at - lastTried >= STUCK_JOB_RULES.unsentResendMs;
  if (!due) return { job, resendEventId: null };
  const claimed = await db
    .collection<JobDocument>(JOBS_COLLECTION)
    .updateOne({ _id: job._id, state: "queued", attempt: job.attempt, "event.id": job.event.id, "event.lastTriedAt": job.event.lastTriedAt }, { $set: { "event.lastTriedAt": now } });
  return { job, resendEventId: claimed.matchedCount === 1 ? job.event.id : null };
}

/** The F15 name, kept for existing callers. */
export const checkStuckPlanJob = checkStuckJob;
