import {
  checkStuckJob,
  generateJobsAhead,
  getJob,
  getLatestCaptionJob,
  getLatestGenerateJob,
  getLatestPlanJob,
  getLatestReviseJob,
  getOwnedProject,
  latestPostOf,
  markJobEventSent,
  type JobDocument,
  type PostDocument,
  type ProjectDocument,
} from "@bytereel/db";
import type { Db } from "mongodb";
import { getInngest, JOB_CANCELLED, PLAN_REQUESTED, POST_PUBLISH_REQUESTED, REVISION_REQUESTED, VIDEO_GENERATE_REQUESTED, VIDEO_RECAPTION_REQUESTED } from "../../inngest/client";

/** The Inngest event that starts each job type. */
const EVENT_OF: Partial<Record<JobDocument["type"], string>> = {
  plan: PLAN_REQUESTED,
  revise: REVISION_REQUESTED,
  generate: VIDEO_GENERATE_REQUESTED,
  caption: VIDEO_RECAPTION_REQUESTED,
  publish: POST_PUBLISH_REQUESTED,
};

// Starting and watching plan jobs (F15), revise jobs (F18), video jobs (F23) and caption jobs (F25) from the API routes
// and the project pages (server only).
// - sendPlanEvent: hands a queued job to Inngest AFTER its transaction committed (DATABASE.md §7.1).
//   The event id is the job's event id (the job key, or `{jobId}:retry:{attempt}`), so sending it
//   twice starts only one run. A failed send is logged and remembered; the stuck-job rule sends it again.
// - loadProjectWithJobs: the project with its active job, after applying the stuck-job rule, so a
//   job that died or never started becomes failed/retryable instead of blocking forever.

type Log = (level: "warn" | "error", message: string) => void;
const defaultLog: Log = (level, message) => console[level](message);

export async function sendPlanEvent(db: Db, job: JobDocument, log: Log = defaultLog): Promise<boolean> {
  const inngest = getInngest(process.env);
  let ok = false;
  if (!inngest.ok) {
    log("error", `Job ${job._id.toHexString()} not started: Inngest is not set up: ${inngest.problem}`);
  } else {
    try {
      await inngest.client.send({
        id: job.event.id,
        name: EVENT_OF[job.type] ?? PLAN_REQUESTED,
        data: {
          jobId: job._id.toHexString(),
          projectId: job.projectId.toHexString(),
          ownerId: job.ownerId.toHexString(),
          attempt: job.attempt,
          // F30: the publish job's post (its runs are lined up one at a time per post).
          ...(job.inputRef.postId ? { postId: job.inputRef.postId.toHexString() } : {}),
        },
      });
      ok = true;
    } catch (error) {
      const hint = inngest.dev ? " Is the Inngest Dev Server running? Start it in a second terminal with: npm run inngest" : "";
      log("error", `Job ${job._id.toHexString()}: couldn't hand it to Inngest (${error instanceof Error ? error.message : String(error)}).${hint} It will be sent again automatically.`);
    }
  }
  await markJobEventSent(db, job._id, job.event.id, ok).catch((error: unknown) => log("error", `Couldn't record the event send for job ${job._id.toHexString()}: ${String(error)}`));
  return ok;
}

/**
 * F31: tell Inngest a waiting job was cancelled (H5), AFTER the commit, so its sleeping run stops
 * (`cancelOn` in publish-post). Best effort: if it is lost, the run wakes later and ends quietly,
 * because the post is no longer `scheduled`.
 */
export async function sendJobCancelled(jobId: string, log: Log = defaultLog): Promise<void> {
  const inngest = getInngest(process.env);
  if (!inngest.ok) return log("warn", `Job ${jobId}: cancel not sent (Inngest is not set up). Its run ends by itself when it wakes.`);
  try {
    await inngest.client.send({ id: `${jobId}:cancelled`, name: JOB_CANCELLED, data: { jobId } });
  } catch (error) {
    log("warn", `Job ${jobId}: couldn't send the cancel to Inngest (${error instanceof Error ? error.message : String(error)}). Its run ends by itself when it wakes.`);
  }
}

/**
 * F31: a scheduled post's waiting job gets the stuck-job rule when the post is read (it is not the
 * project's active job): after its time + 1 hour it becomes "missed"; a lost start event is sent again.
 * True when the post may have changed (read it again).
 */
export async function refreshScheduledPost(db: Db, post: Pick<PostDocument, "state" | "jobId" | "scheduledAt">, log: Log = defaultLog): Promise<boolean> {
  if (post.state !== "scheduled" || !post.jobId) return false;
  const job = await getJob(db, post.jobId);
  if (!job || job.state !== "queued") return false;
  const fresh = await refreshJob(db, job, log);
  return fresh.state !== job.state;
}

/** Apply the stuck-job rule to a job and send its event again when due. Returns the job as it is now. */
export async function refreshJob(db: Db, job: JobDocument, log: Log = defaultLog): Promise<JobDocument> {
  const checked = await checkStuckJob(db, job);
  if (checked.resendEventId) {
    await sendPlanEvent(db, checked.job, log);
    return (await getJob(db, job._id)) ?? checked.job;
  }
  return checked.job;
}

export type ProjectWithJobs = {
  project: ProjectDocument;
  activeJob: JobDocument | null;
  latestPlanJob: JobDocument | null;
  latestReviseJob?: JobDocument | null;
  latestGenerateJob?: JobDocument | null;
  latestCaptionJob?: JobDocument | null;
  /** F30: the project's newest post. */
  latestPost?: PostDocument | null;
};

/** The owner's project with its active job (stuck-job rule applied), its newest plan, revise, video and caption jobs, and (F30) its newest post, or null. */
export async function loadProjectWithJobs(db: Db, ownerId: string, projectId: string, log: Log = defaultLog): Promise<ProjectWithJobs | null> {
  let project = await getOwnedProject(db, ownerId, projectId);
  if (!project) return null;
  if (project.activeJobId) {
    const job = await getJob(db, project.activeJobId);
    if (job) {
      const fresh = await refreshJob(db, job, log);
      if (fresh.state !== job.state) project = (await getOwnedProject(db, ownerId, projectId)) ?? project;
    }
  }
  // F31: a scheduled post's sleeping job (not the active job): the missed rule and a lost event.
  if (project.state === "scheduled" && project.currentRenderId) {
    const waiting = await latestPostOf(db, { ownerId: project.ownerId, projectId: project._id });
    if (waiting && (await refreshScheduledPost(db, waiting, log))) project = (await getOwnedProject(db, ownerId, projectId)) ?? project;
  }
  const activeJob = project.activeJobId ? await getJob(db, project.activeJobId) : null;
  const [latestPlanJob, latestReviseJob, latestGenerateJob, latestCaptionJob, latestPost] = await Promise.all([
    getLatestPlanJob(db, project._id),
    project.currentPlanVersionId ? getLatestReviseJob(db, project._id) : null,
    project.currentPlanVersionId ? getLatestGenerateJob(db, project._id) : null,
    project.currentRenderId ? getLatestCaptionJob(db, project._id) : null,
    project.currentRenderId ? latestPostOf(db, { ownerId: project.ownerId, projectId: project._id }) : null,
  ]);
  return { project, activeJob, latestPlanJob, latestReviseJob, latestGenerateJob, latestCaptionJob, latestPost };
}

/** A video or caption job waiting for its turn: how many video jobs are running or wait before it (else null). */
export async function videosAhead(db: Db, job: JobDocument | null): Promise<number | null> {
  return (job?.type === "generate" || job?.type === "caption") && job.state === "queued" ? generateJobsAhead(db, job) : null;
}
