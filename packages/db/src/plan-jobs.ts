import { type Db, ObjectId } from "mongodb";
import { finishIdempotencyInTransaction, type IdempotencyLock } from "./idempotency";
import {
  canRetryPlanJob,
  getJob,
  JOB_MESSAGES,
  JOBS_COLLECTION,
  PLAN_ERROR_RETRYABLE,
  planInputHash,
  planJobKey,
  retryEventId,
  type JobDocument,
  type PlanCheckpoint,
  type PlanJobErrorCode,
  type PlannerAnswer,
} from "./jobs";
import { PLAN_VERSION_SCHEMA_VERSION, PLAN_VERSIONS_COLLECTION, type PlanVersionDocument, type PlanStatsDoc, type StoredPlan, type ValidationIssueDoc } from "./plan-versions";
import { ProjectActionError, PROJECTS_COLLECTION, titleAfterPlan, type ProjectDocument } from "./projects";
import type { RevisionDocument } from "./revisions";
import { USAGE_LIMITS } from "./usage";

// The life of a `plan` job (F15; docs/DATABASE.md §4.9, §7.2 rows 8 and 18; API.md E2).
// Called by the Inngest function `plan-video` (apps/web/inngest) and by the API routes.
//
// Safety rules:
// - Every write of the background job is conditional on "this job is still running this attempt",
//   so an older attempt, a duplicate run, or a job that the stuck-job rule already failed can
//   never overwrite newer data.
// - Each Gemini request is counted on the job BEFORE it is sent (`planner.requests`, at most the
//   caller's limit per attempt) and its answer is saved as soon as it arrives (`planner.answers`).
//   A retried step or a retried job reuses a saved answer instead of asking (and paying) again.
// - Finishing (success or failure) is ONE short transaction: job state + project state +
//   `activeJobId` cleared (+ the new plan version), so the project can't show "working" forever.

/** Stuck-job rule (ARCHITECTURE §20.3, Q11), checked whenever the job's status is read. */
export const STUCK_JOB_RULES = {
  /** A running job with no update for this long has died (crash, deploy, timeout): failed, retryable. */
  runningStaleMs: 10 * 60_000,
  /** A queued job whose start event couldn't be handed to Inngest: send again after this long. */
  unsentResendMs: 15_000,
  /** A queued job whose event was sent but hasn't started: send again (same id, so a duplicate is dropped). */
  sentResendMs: 2 * 60_000,
  /** A job still queued after this long gives up: failed, retryable. */
  queuedGiveUpMs: 15 * 60_000,
} as const;

/**
 * What a job step reads. Revise jobs (F18, revisions.ts) also carry the base version and the
 * revision the change is made on.
 */
export type PlanJobContext = { job: JobDocument; project: ProjectDocument; base?: PlanVersionDocument; revision?: RevisionDocument };

/**
 * Step 1 of a run: the job becomes `running` for this attempt and gets its planner checkpoint.
 * Returns null when there is nothing to do (the job finished, a newer attempt exists, or the
 * project no longer waits for this job): the run then ends without any AI call.
 * A valid answer saved by an earlier attempt for the SAME idea is kept, so a retry after e.g. a
 * failed save never asks Gemini again.
 */
export async function startPlanAttempt(db: Db, input: { jobId: string; attempt: number; runId?: string | null; now?: Date }): Promise<PlanJobContext | null> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.jobId)) return null;
  const job = await getJob(db, new ObjectId(input.jobId));
  if (!job || job.type !== "plan" || job.attempt !== input.attempt || (job.state !== "queued" && job.state !== "running")) return null;
  const project = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: job.projectId, ownerId: job.ownerId });
  if (!project || !project.activeJobId?.equals(job._id) || project.state !== "planning") return null;

  let planner: PlanCheckpoint;
  if (job.planner && job.planner.attempt === input.attempt) {
    planner = job.planner; // the start step ran before (Inngest retried it): keep everything
  } else {
    const reusable = job.planner && job.planner.inputHash === job.inputHash ? job.planner.answers.filter((a) => a.valid).slice(0, 1) : [];
    planner = {
      attempt: input.attempt,
      inputHash: job.inputHash,
      planVersionId: reusable.length && job.planner ? job.planner.planVersionId : new ObjectId(),
      requests: 0,
      answers: reusable,
    };
  }
  const updated = await db.collection<JobDocument>(JOBS_COLLECTION).findOneAndUpdate(
    { _id: job._id, attempt: input.attempt, state: { $in: ["queued", "running"] } },
    {
      $set: {
        state: "running",
        startedAt: job.startedAt ?? now,
        "stages.0.status": "running",
        "stages.0.startedAt": job.stages[0]?.startedAt ?? now,
        progress: { stage: "plan", percent: 10, message: JOB_MESSAGES.WRITING },
        planner,
        ...(input.runId ? { inngestRunId: input.runId } : {}),
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  return updated ? { job: updated, project } : null;
}

/** Read-only: the job and its project while the job is running this attempt (else null). */
export async function loadPlanAttempt(db: Db, input: { jobId: string; attempt: number }): Promise<PlanJobContext | null> {
  if (!/^[0-9a-f]{24}$/.test(input.jobId)) return null;
  const job = await getJob(db, new ObjectId(input.jobId));
  if (!job || job.type !== "plan" || job.state !== "running" || job.attempt !== input.attempt || job.planner?.attempt !== input.attempt) return null;
  const project = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: job.projectId, ownerId: job.ownerId, activeJobId: job._id });
  return project ? { job, project } : null;
}

/**
 * Count one Gemini request BEFORE it is sent. "ok": go ahead. "limit": this attempt already made
 * `maxRequests` requests (no more AI calls). "quota": this is the attempt's FIRST request and the
 * project already used its 20 storyboard requests. "stale": the job is no longer running this attempt.
 * The attempt's first request also adds 1 to `projects.planRequestCount` (only below 20), in the same
 * transaction: only an attempt that really asks Gemini counts toward the 20 (a job that never got to
 * Gemini, or a Try again that reuses a saved answer, costs nothing). F15, after code review.
 */
export async function reservePlanRequest(
  db: Db,
  input: { jobId: ObjectId; attempt: number; maxRequests: number; message: string; percent: number; now?: Date },
): Promise<"ok" | "limit" | "quota" | "stale"> {
  const now = input.now ?? new Date();
  const limit = USAGE_LIMITS.planRequestsPerProject;
  const session = db.client.startSession();
  let result: "ok" | "limit" | "quota" | "stale" = "stale";
  try {
    await session.withTransaction(async () => {
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = await jobs.findOne({ _id: input.jobId, attempt: input.attempt, state: "running", "planner.attempt": input.attempt }, { session });
      if (!job?.planner) {
        result = "stale";
        return;
      }
      if (job.planner.requests >= input.maxRequests) {
        result = "limit";
        return;
      }
      if (job.planner.requests === 0) {
        const counted = await db
          .collection<ProjectDocument>(PROJECTS_COLLECTION)
          .updateOne({ _id: job.projectId, activeJobId: job._id, planRequestCount: { $lt: limit } }, { $inc: { planRequestCount: 1 }, $set: { updatedAt: now } }, { session });
        if (counted.matchedCount !== 1) {
          result = "quota";
          return;
        }
      }
      const updated = await jobs.updateOne(
        { _id: job._id, attempt: input.attempt, state: "running", "planner.requests": job.planner.requests },
        { $inc: { "planner.requests": 1, "stages.0.attempts": 1 }, $set: { progress: { stage: "plan", percent: input.percent, message: input.message }, updatedAt: now } },
        { session },
      );
      // Someone else counted a request at the same moment: refuse this one (the transaction rolls back).
      if (updated.matchedCount !== 1) throw new Error("Concurrent request reservation; try again.");
      result = "ok";
    });
  } finally {
    await session.endSession();
  }
  return result;
}

/** Save one planner answer on the job (once per answer number and attempt). */
export async function savePlannerAnswer(db: Db, input: { jobId: ObjectId; attempt: number; answer: PlannerAnswer; now?: Date }): Promise<boolean> {
  const result = await db.collection<JobDocument>(JOBS_COLLECTION).updateOne(
    { _id: input.jobId, attempt: input.attempt, state: "running", "planner.attempt": input.attempt, "planner.answers.n": { $ne: input.answer.n } },
    { $push: { "planner.answers": input.answer }, $set: { updatedAt: input.now ?? new Date() } },
  );
  return result.matchedCount === 1;
}

/** Touch the job's progress (e.g. "Checking your storyboard…"). Only while running this attempt. */
export async function setPlanProgress(db: Db, input: { jobId: ObjectId; attempt: number; stage: string; percent: number; message: string; now?: Date }): Promise<void> {
  await db
    .collection<JobDocument>(JOBS_COLLECTION)
    .updateOne(
      { _id: input.jobId, attempt: input.attempt, state: "running" },
      { $set: { progress: { stage: input.stage, percent: input.percent, message: input.message }, updatedAt: input.now ?? new Date() } },
    );
}

export interface ValidPlanToSave {
  plan: StoredPlan;
  planHash: string;
  stats: PlanStatsDoc;
  warnings: ValidationIssueDoc[];
  plannerUsage: PlanVersionDocument["plannerUsage"];
}

/**
 * The job succeeded (DATABASE.md §7.2 #18), ONE transaction: insert the plan version (the next
 * version number, id = the checkpoint's planVersionId), project → `storyboard_ready` with the plan's
 * topic as title (unless the creator chose the title: `titleSetByUser`, F21 review), `currentPlanVersionId`,
 * `activeJobId` cleared, +1 stateVersion; job → `succeeded`.
 * Returns false (nothing written) when the job is no longer running this attempt.
 */
export async function completePlanJob(db: Db, input: { jobId: ObjectId; attempt: number; result: ValidPlanToSave; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let saved = false;
  try {
    await session.withTransaction(async () => {
      saved = false;
      const job = await db.collection<JobDocument>(JOBS_COLLECTION).findOne({ _id: input.jobId, attempt: input.attempt, state: "running" }, { session });
      if (!job?.planner) return;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const project = await projects.findOne({ _id: job.projectId, ownerId: job.ownerId, activeJobId: job._id }, { session });
      if (!project) return;
      const versions = db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION);
      const last = await versions.findOne({ projectId: job.projectId }, { session, sort: { versionNumber: -1 }, projection: { versionNumber: 1 } });
      const versionId = job.planner.planVersionId;
      await versions.insertOne(
        {
          _id: versionId,
          ownerId: job.ownerId,
          projectId: job.projectId,
          schemaVersion: PLAN_VERSION_SCHEMA_VERSION,
          versionNumber: (last?.versionNumber ?? 0) + 1,
          parentVersionId: null,
          source: "ai_plan",
          plan: input.result.plan,
          planHash: input.result.planHash,
          validation: { valid: true, issues: [], warnings: input.result.warnings },
          stats: input.result.stats,
          plannerUsage: input.result.plannerUsage,
          createdAt: now,
        },
        { session },
      );
      // The plan's topic becomes the title, unless the creator chose one (rename / Edit idea title).
      const topic = titleAfterPlan(project, input.result.plan.topic);
      await projects.updateOne(
        { _id: project._id, activeJobId: job._id },
        { $set: { state: "storyboard_ready", title: topic, currentPlanVersionId: versionId, activeJobId: null, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      const planStage = job.stages[0]!;
      await db.collection<JobDocument>(JOBS_COLLECTION).updateOne(
        { _id: job._id, attempt: input.attempt, state: "running" },
        {
          $set: {
            state: "succeeded",
            stages: [
              { ...planStage, status: "succeeded", endedAt: now, error: null },
              { name: "validate", status: "succeeded", startedAt: now, endedAt: now, attempts: 1, error: null },
            ],
            progress: { stage: "validate", percent: 100, message: JOB_MESSAGES.DONE },
            error: null,
            result: { planVersionId: versionId },
            finishedAt: now,
            updatedAt: now,
          },
        },
        { session },
      );
      saved = true;
    });
  } finally {
    await session.endSession();
  }
  return saved;
}

/**
 * The job failed (DATABASE.md §7.2 #18), ONE transaction: job → `failed` with the plain-language
 * error (retryable per PLAN_ERROR_RETRYABLE), project → `plan_failed` with `lastError`, `activeJobId`
 * cleared, +1 stateVersion. Only while the job is queued/running (and, when given, this attempt
 * and/or not updated since `staleBefore`, for the stuck-job rule). Returns false when nothing changed.
 */
export async function failPlanJob(
  db: Db,
  input: { jobId: ObjectId; attempt?: number; code: PlanJobErrorCode; stage: "plan" | "validate"; detail?: string; staleBefore?: Date; queuedBefore?: Date; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const message = JOB_MESSAGES[input.code];
  const session = db.client.startSession();
  let failed = false;
  try {
    await session.withTransaction(async () => {
      failed = false;
      const filter = {
        _id: input.jobId,
        state: { $in: ["queued", "running"] as JobDocument["state"][] },
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        ...(input.staleBefore ? { updatedAt: { $lt: input.staleBefore } } : {}),
        ...(input.queuedBefore ? { state: "queued" as const, queuedAt: { $lt: input.queuedBefore } } : {}),
      };
      const job = await db.collection<JobDocument>(JOBS_COLLECTION).findOne(filter, { session });
      if (!job) return;
      const stageError = { code: input.code, message: (input.detail ?? message).slice(0, 300) };
      const stages = job.stages.map((s) =>
        s.name === input.stage ? { ...s, status: "failed" as const, startedAt: s.startedAt ?? now, endedAt: now, error: stageError } : s.name === "plan" && input.stage === "validate" ? { ...s, status: "succeeded" as const, endedAt: s.endedAt ?? now } : s,
      );
      await db.collection<JobDocument>(JOBS_COLLECTION).updateOne(
        { _id: job._id, attempt: job.attempt, state: job.state },
        {
          $set: {
            state: "failed",
            stages,
            progress: { stage: input.stage, percent: job.progress.percent, message },
            error: { code: input.code, message, retryable: PLAN_ERROR_RETRYABLE[input.code] },
            finishedAt: now,
            updatedAt: now,
          },
        },
        { session },
      );
      await db.collection<ProjectDocument>(PROJECTS_COLLECTION).updateOne(
        { _id: job.projectId, activeJobId: job._id },
        { $set: { state: "plan_failed", lastError: { code: input.code, message, at: now }, activeJobId: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      failed = true;
    });
  } finally {
    await session.endSession();
  }
  return failed;
}

/**
 * E2 "Try again" on a failed plan job (API.md E2, DATABASE.md §7.2 #8), ONE transaction: the same
 * job back to `queued` with attempt + 1, planning from the project's CURRENT idea (new inputHash and
 * key when the idea was edited), project → `planning` with `activeJobId`, `lastError` cleared,
 * +1 stateVersion. Refused (429) when the project already used its 20 storyboard requests; the new
 * attempt is counted only when it really sends a request to Gemini (reservePlanRequest). The answer
 * is saved on the Idempotency-Key record in the same transaction. Throws ProjectActionError (nothing
 * changed) when it isn't allowed.
 * The caller sends the Inngest event (id `{jobId}:retry:{attempt}`) after this returns.
 */
export async function retryPlanJob(
  db: Db,
  input: { ownerId: string; jobId: string; idempotencyLock?: IdempotencyLock | null; respond: (job: JobDocument) => { status: number; body: unknown }; now?: Date },
): Promise<JobDocument> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.jobId) || !/^[0-9a-f]{24}$/.test(input.ownerId)) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
  const ownerId = new ObjectId(input.ownerId);
  const jobId = new ObjectId(input.jobId);
  const limit = USAGE_LIMITS.planRequestsPerProject;
  const session = db.client.startSession();
  let result: JobDocument | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const job = await jobs.findOne({ _id: jobId, ownerId }, { session });
      if (!job) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
      const project = await projects.findOne({ _id: job.projectId, ownerId }, { session });
      if (!project) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
      if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.");
      const inputHash = planInputHash(project);
      if (project.state !== "plan_failed" || !canRetryPlanJob(job, inputHash)) {
        throw new ProjectActionError("INVALID_STATE", "This step can't be retried. Please edit your idea instead.", { jobState: job.state, retryable: job.error?.retryable ?? false });
      }
      if (project.planRequestCount >= limit) {
        throw new ProjectActionError("QUOTA_EXCEEDED", `This project has reached ${limit} storyboard requests. Start a new project to keep going.`, {
          quota: "plan_requests_per_project",
          limit,
          used: project.planRequestCount,
          resetsAt: null,
        });
      }
      const attempt = job.attempt + 1;
      const key = planJobKey(job.projectId, inputHash);
      const moved = await projects.updateOne(
        { _id: project._id, state: "plan_failed", activeJobId: null, stateVersion: project.stateVersion, planRequestCount: { $lt: limit } },
        { $set: { state: "planning", activeJobId: job._id, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      if (moved.matchedCount !== 1) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      const next: Partial<JobDocument> = {
        state: "queued",
        attempt,
        inputHash,
        idempotencyKey: key,
        stages: job.stages.map((s) => ({ name: s.name, status: "pending" as const, startedAt: null, endedAt: null, attempts: 0, error: null })),
        progress: { stage: "plan", percent: 0, message: JOB_MESSAGES.QUEUED },
        error: null,
        result: null,
        cancelRequestedAt: null,
        event: { id: retryEventId(job._id, attempt), sentAt: null, lastTriedAt: null },
        queuedAt: now,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      };
      const updated = await jobs.findOneAndUpdate({ _id: job._id, attempt: job.attempt, state: job.state }, { $set: next }, { session, returnDocument: "after" });
      if (!updated) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      if (input.idempotencyLock) {
        const answer = input.respond(updated);
        await finishIdempotencyInTransaction(db, input.idempotencyLock, answer.status, answer.body, session);
      }
      result = updated;
    });
  } finally {
    await session.endSession();
  }
  return result!;
}
