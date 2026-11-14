import type { Db } from "mongodb";
import { getJob, JOBS_COLLECTION, type JobDocument } from "./jobs";
import { failPlanJob, STUCK_JOB_RULES } from "./plan-jobs";
import { failReviseJob } from "./revisions";

// The stuck-job rule (ARCHITECTURE §20.3, DATABASE.md Q11, API.md §8.5), checked whenever the status
// of an active job is read (C6, C3, E1, the project pages), so nothing waits forever and no cron is
// needed yet. For `plan` jobs (F15) and `revise` jobs (F18):
// - running with no update for 10 min → failed (INTERNAL, retryable): the run died;
// - queued for 15 min → failed (INTERNAL, retryable): Inngest never started it;
// - queued and its start event not handed over (or sent but not started after 2 min) → the caller
//   sends the event again; the same event id means Inngest drops it if the first one did arrive.
// Only one reader claims a resend (conditional update on `event.lastTriedAt`).
// A failed plan job leaves the project `plan_failed`; a failed revise job leaves the storyboard as it was.

export type StuckCheck = { job: JobDocument; resendEventId: string | null };

export async function checkStuckJob(db: Db, job: JobDocument, now: Date = new Date()): Promise<StuckCheck> {
  if (job.type !== "plan" && job.type !== "revise") return { job, resendEventId: null };
  const fail = job.type === "plan" ? failPlanJob : failReviseJob;
  const at = now.getTime();
  const reload = async () => (await getJob(db, job._id)) ?? job;
  if (job.state === "running" && at - job.updatedAt.getTime() >= STUCK_JOB_RULES.runningStaleMs) {
    await fail(db, { jobId: job._id, attempt: job.attempt, code: "INTERNAL", stage: "plan", detail: "No progress for 10 minutes (stuck-job rule)", staleBefore: new Date(at - STUCK_JOB_RULES.runningStaleMs), now });
    return { job: await reload(), resendEventId: null };
  }
  if (job.state !== "queued") return { job, resendEventId: null };
  if (at - job.queuedAt.getTime() >= STUCK_JOB_RULES.queuedGiveUpMs) {
    await fail(db, { jobId: job._id, attempt: job.attempt, code: "INTERNAL", stage: "plan", detail: "Never started (stuck-job rule)", queuedBefore: new Date(at - STUCK_JOB_RULES.queuedGiveUpMs), now });
    return { job: await reload(), resendEventId: null };
  }
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
