import {
  checkStuckJob,
  getJob,
  getLatestPlanJob,
  getLatestReviseJob,
  getOwnedProject,
  markJobEventSent,
  type JobDocument,
  type ProjectDocument,
} from "@bytereel/db";
import type { Db } from "mongodb";
import { getInngest, PLAN_REQUESTED, REVISION_REQUESTED } from "../../inngest/client";

// Starting and watching plan jobs (F15) and revise jobs (F18) from the API routes and the project
// pages (server only).
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
        name: job.type === "revise" ? REVISION_REQUESTED : PLAN_REQUESTED,
        data: { jobId: job._id.toHexString(), projectId: job.projectId.toHexString(), ownerId: job.ownerId.toHexString(), attempt: job.attempt },
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

/** Apply the stuck-job rule to a job and send its event again when due. Returns the job as it is now. */
export async function refreshJob(db: Db, job: JobDocument, log: Log = defaultLog): Promise<JobDocument> {
  const checked = await checkStuckJob(db, job);
  if (checked.resendEventId) {
    await sendPlanEvent(db, checked.job, log);
    return (await getJob(db, job._id)) ?? checked.job;
  }
  return checked.job;
}

export type ProjectWithJobs = { project: ProjectDocument; activeJob: JobDocument | null; latestPlanJob: JobDocument | null; latestReviseJob?: JobDocument | null };

/** The owner's project with its active job (stuck-job rule applied) and its newest plan and revise jobs, or null. */
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
  const activeJob = project.activeJobId ? await getJob(db, project.activeJobId) : null;
  const [latestPlanJob, latestReviseJob] = await Promise.all([getLatestPlanJob(db, project._id), project.currentPlanVersionId ? getLatestReviseJob(db, project._id) : null]);
  return { project, activeJob, latestPlanJob, latestReviseJob };
}
