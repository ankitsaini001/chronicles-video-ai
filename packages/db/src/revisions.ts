import { createHash } from "node:crypto";
import { type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { finishIdempotencyInTransaction, type IdempotencyLock } from "./idempotency";
import { cleanIdeaText } from "./idea-text";
import { getJob, JOB_SCHEMA_VERSION, JOBS_COLLECTION, PLAN_ERROR_RETRYABLE, PLAN_STAGES, retryEventId, type JobDocument, type PlanCheckpoint, type PlanJobErrorCode } from "./jobs";
import type { PlanJobContext, ValidPlanToSave } from "./plan-jobs";
import { decodeCursor, diffScenes, encodeCursor, InvalidCursorError, PLAN_VERSION_SCHEMA_VERSION, PLAN_VERSIONS_COLLECTION, type PlanVersionDocument, type SceneDiff } from "./plan-versions";
import { ProjectActionError, PROJECTS_COLLECTION, STORYBOARD_EDIT_STATES, type ProjectDocument } from "./projects";
import { assertStoryboardEditable, ObjectIdString } from "./storyboard-edits";
import { USAGE_LIMITS } from "./usage";

// The revision chat (F18; docs/API.md D5, D6; DATABASE.md §4.11 `revisions`, §7.2 rows 4 and 18).
// The creator asks for a change in plain words ("make it shorter", "scene 3: show a comparison");
// a background `revise` job (Inngest `revise-plan`) asks Gemini for the whole storyboard with that
// change and saves it as a NEW version (`ai_revision`). It reuses the F15 machinery:
// - the job's planner checkpoint (each Gemini request counted on the job before it is sent, each
//   answer saved as soon as it arrives, a retry reuses a saved answer), the ONE repair, the limits;
// - the project's 20 AI requests: D5 refuses at 20; the attempt counts 1 when it sends its FIRST
//   Gemini request (reservePlanRequest, the same rule as F15's Try again);
// - every background write is conditional on "still running this attempt" (fencing);
// - finishing is ONE short transaction (job + revision + project, + the new version).
// While the job runs, the project keeps its state and current version (only `activeJobId` is set),
// so a failed change leaves the storyboard as it was. A new version has no approval.
// An answer that changes nothing ends as `rejected` (job `needs_input`) with a short reply asking
// the creator to say exactly what to change: no new version.

export const REVISIONS_COLLECTION = "revisions";
export const REVISION_SCHEMA_VERSION = 1;
export const REVISION_MESSAGE_LIMITS = { min: 3, max: 500 } as const;

export type RevisionStage = "storyboard" | "video";
export type RevisionScope = "project" | "scene";
export type RevisionStatus = "pending" | "succeeded" | "failed" | "rejected";

export interface RevisionDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  projectId: ObjectId;
  schemaVersion: number;
  stage: RevisionStage;
  scope: RevisionScope;
  sceneId: string | null;
  message: string;
  basePlanVersionId: ObjectId;
  resultPlanVersionId: ObjectId | null;
  status: RevisionStatus;
  assistantReply: string | null;
  diff: SceneDiff | null;
  jobId: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/** What the creator reads while a change runs and when it ends (API.md §4.3). Shown as is. */
export const REVISE_MESSAGES = {
  WRITING: "Updating your storyboard…",
  RETRYING: "Our AI is busy, trying again…",
  REPAIRING: "Fixing a few details in your storyboard…",
  SAVING: "Checking the new storyboard…",
  DONE: "Your storyboard is updated.",
  NO_CHANGE: "I couldn't find anything to change for this request. Try saying exactly what to change, for example “scene 2: make it simpler”.",
  PROVIDER_BUSY: "Our AI is very busy right now. Your storyboard is saved; please try again in a few minutes.",
  PROVIDER_REJECTED: "We can't make this change. Please ask for something else.",
  PLAN_INVALID: "Our AI couldn't make a good storyboard with this change. Try saying it differently.",
  QUOTA_EXCEEDED: "This project has reached 20 changes. Start a new project to keep going.",
  INTERNAL: "Something went wrong on our side. Please try again.",
} as const;

/** The progress line while the AI works on a change ("Updating scene 3…" for one scene). */
export function reviseProgressMessage(sceneNumber: number | null): string {
  return sceneNumber ? `Updating scene ${sceneNumber}…` : REVISE_MESSAGES.WRITING;
}

const SafeId = z.string({ error: "must be text" }).regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { error: "is not a valid id" });

/** D5 body (API.md D5). Strict. `sceneId` exactly when `scope` is `scene`. */
export const RevisionBodySchema = z
  .strictObject({
    stage: z.enum(["storyboard", "video"], { error: "must be storyboard or video" }),
    scope: z.enum(["project", "scene"], { error: "must be project or scene" }),
    sceneId: SafeId.optional(),
    message: z
      .string({ error: "must be text" })
      .transform(cleanIdeaText)
      .pipe(
        z
          .string()
          .min(REVISION_MESSAGE_LIMITS.min, { error: `must be at least ${REVISION_MESSAGE_LIMITS.min} characters` })
          .max(REVISION_MESSAGE_LIMITS.max, { error: `must be at most ${REVISION_MESSAGE_LIMITS.max} characters` }),
      ),
    basePlanVersionId: ObjectIdString,
    expectedStateVersion: z.number({ error: "must be a whole number" }).int({ error: "must be a whole number" }).min(1, { error: "must be at least 1" }),
  })
  .superRefine((body, ctx) => {
    if (body.scope === "scene" && !body.sceneId) ctx.addIssue({ code: "custom", path: ["sceneId"], message: "is required when scope is scene" });
    if (body.scope === "project" && body.sceneId) ctx.addIssue({ code: "custom", path: ["sceneId"], message: "is only allowed when scope is scene" });
  });
export type RevisionBody = z.output<typeof RevisionBodySchema>;

/** The `Revision` resource (API.md §11.3). */
export type RevisionResource = {
  id: string;
  projectId: string;
  stage: RevisionStage;
  scope: RevisionScope;
  sceneId: string | null;
  message: string;
  basePlanVersionId: string;
  resultPlanVersionId: string | null;
  status: RevisionStatus;
  assistantReply: string | null;
  diff: SceneDiff | null;
  jobId: string;
  createdAt: string;
  updatedAt: string;
};

export function toRevisionResource(doc: RevisionDocument): RevisionResource {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    stage: doc.stage,
    scope: doc.scope,
    sceneId: doc.sceneId,
    message: doc.message,
    basePlanVersionId: doc.basePlanVersionId.toHexString(),
    resultPlanVersionId: doc.resultPlanVersionId ? doc.resultPlanVersionId.toHexString() : null,
    status: doc.status,
    assistantReply: doc.assistantReply,
    diff: doc.diff,
    jobId: doc.jobId.toHexString(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** sha256 of what the change is about (the job's `inputHash`; the planner checkpoint belongs to it). */
export function revisionInputHash(input: { basePlanVersionId: ObjectId; scope: RevisionScope; sceneId: string | null; message: string }): string {
  return createHash("sha256").update(JSON.stringify([input.basePlanVersionId.toHexString(), input.scope, input.sceneId, input.message]), "utf8").digest("hex");
}

export const reviseJobKey = (revisionId: ObjectId) => `rev:${revisionId.toHexString()}`;

const QUOTA = (used: number) =>
  new ProjectActionError("QUOTA_EXCEEDED", REVISE_MESSAGES.QUOTA_EXCEEDED, {
    quota: "plan_requests_per_project",
    limit: USAGE_LIMITS.planRequestsPerProject,
    used,
    resetsAt: null,
  });

/**
 * D5 (API.md D5, DATABASE.md §7.2 row 4), ONE transaction: the storyboard may be changed (no job
 * running, the stateVersion the browser saw, `basePlanVersionId` = the current version), the scene
 * exists, the project is under its 20 AI requests; then insert the revision (`pending`), insert its
 * queued `revise` job (key `rev:{revisionId}`), point the project's `activeJobId` at it, +1
 * stateVersion, and save the answer on the Idempotency-Key record. Not counted here: the job counts
 * 1 of the 20 when it really asks Gemini. The caller sends `revision.requested` AFTER this returns.
 */
export async function requestRevision(
  db: Db,
  input: {
    ownerId: string;
    projectId: string;
    body: RevisionBody;
    idempotencyLock?: IdempotencyLock | null;
    respond: (out: { revision: RevisionDocument; job: JobDocument }) => { status: number; body: unknown };
    now?: Date;
  },
): Promise<{ revision: RevisionDocument; job: JobDocument; project: ProjectDocument }> {
  const now = input.now ?? new Date();
  const { body } = input;
  const session = db.client.startSession();
  let result: { revision: RevisionDocument; job: JobDocument; project: ProjectDocument } | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const project =
        /^[0-9a-f]{24}$/.test(input.projectId) && /^[0-9a-f]{24}$/.test(input.ownerId)
          ? await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: new ObjectId(input.projectId), ownerId: new ObjectId(input.ownerId) }, { session })
          : null;
      if (!project) throw new ProjectActionError("NOT_FOUND", "We couldn't find this project.");
      assertStoryboardEditable(project, body.expectedStateVersion);
      if (!project.currentPlanVersionId!.equals(new ObjectId(body.basePlanVersionId))) {
        throw new ProjectActionError("STALE_VERSION", "This storyboard changed in another tab, refresh.", { expectedStateVersion: body.expectedStateVersion, currentStateVersion: project.stateVersion });
      }
      if (body.stage === "video" && !project.currentRenderId) throw new ProjectActionError("INVALID_STATE", "There is no video to change yet.", { state: project.state });
      const base = await db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: project.currentPlanVersionId!, projectId: project._id }, { session, projection: { "plan.scenes.id": 1 } });
      if (!base) throw new Error(`Project ${project._id.toHexString()} points to a missing plan version.`);
      const sceneIndex = body.sceneId ? base.plan.scenes.findIndex((s) => s.id === body.sceneId) : -1;
      if (body.sceneId && sceneIndex < 0) {
        throw new ProjectActionError("INVALID_INPUT", "Please reload the page and try again.", { issues: [{ path: "sceneId", message: "is not a scene of this storyboard" }] });
      }
      if (project.planRequestCount >= USAGE_LIMITS.planRequestsPerProject) throw QUOTA(project.planRequestCount);

      const revisionId = new ObjectId();
      const jobId = new ObjectId();
      const sceneId = body.sceneId ?? null;
      const revision: RevisionDocument = {
        _id: revisionId,
        ownerId: project.ownerId,
        projectId: project._id,
        schemaVersion: REVISION_SCHEMA_VERSION,
        stage: body.stage,
        scope: body.scope,
        sceneId,
        message: body.message,
        basePlanVersionId: base._id,
        resultPlanVersionId: null,
        status: "pending",
        assistantReply: null,
        diff: null,
        jobId,
        createdAt: now,
        updatedAt: now,
      };
      const key = reviseJobKey(revisionId);
      const job: JobDocument = {
        _id: jobId,
        ownerId: project.ownerId,
        projectId: project._id,
        schemaVersion: JOB_SCHEMA_VERSION,
        type: "revise",
        inputRef: { planVersionId: base._id, revisionId },
        inputHash: revisionInputHash({ basePlanVersionId: base._id, scope: body.scope, sceneId, message: body.message }),
        state: "queued",
        attempt: 1,
        stages: PLAN_STAGES.map((name) => ({ name, status: "pending" as const, startedAt: null, endedAt: null, attempts: 0, error: null })),
        progress: { stage: "plan", percent: 0, message: reviseProgressMessage(sceneIndex >= 0 ? sceneIndex + 1 : null) },
        error: null,
        needsInput: null,
        result: { revisionId },
        idempotencyKey: key,
        inngestRunId: null,
        cancelRequestedAt: null,
        event: { id: key, sentAt: null, lastTriedAt: null },
        planner: null,
        queuedAt: now,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      };
      await db.collection<RevisionDocument>(REVISIONS_COLLECTION).insertOne(revision, { session });
      await db.collection<JobDocument>(JOBS_COLLECTION).insertOne(job, { session });
      const updated = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOneAndUpdate(
        { _id: project._id, stateVersion: project.stateVersion, activeJobId: null, planRequestCount: { $lt: USAGE_LIMITS.planRequestsPerProject } },
        { $set: { activeJobId: jobId, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session, returnDocument: "after" },
      );
      if (!updated) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.", { expectedStateVersion: body.expectedStateVersion, currentStateVersion: project.stateVersion + 1 });
      if (input.idempotencyLock) {
        const answer = input.respond({ revision, job });
        await finishIdempotencyInTransaction(db, input.idempotencyLock, answer.status, answer.body, session);
      }
      result = { revision, job, project: updated };
    });
  } finally {
    await session.endSession();
  }
  return result!;
}

// ---------- the background job (Inngest `revise-plan`) ----------

/**
 * Step 1 of a run: the job becomes `running` for this attempt with its planner checkpoint. Null
 * (nothing to do, no AI call) when the job finished, a newer attempt exists, or the project no
 * longer waits for it. A valid answer an earlier attempt already saved for the same request is kept.
 */
export async function startReviseAttempt(db: Db, input: { jobId: string; attempt: number; runId?: string | null; now?: Date }): Promise<PlanJobContext | null> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.jobId)) return null;
  const job = await getJob(db, new ObjectId(input.jobId));
  if (!job || job.type !== "revise" || job.attempt !== input.attempt || (job.state !== "queued" && job.state !== "running")) return null;
  const project = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: job.projectId, ownerId: job.ownerId });
  if (!project || !project.activeJobId?.equals(job._id) || !STORYBOARD_EDIT_STATES.includes(project.state) || !job.inputRef.planVersionId || !project.currentPlanVersionId?.equals(job.inputRef.planVersionId)) return null;

  let planner: PlanCheckpoint;
  if (job.planner && job.planner.attempt === input.attempt) {
    planner = job.planner;
  } else {
    const reusable = job.planner && job.planner.inputHash === job.inputHash ? job.planner.answers.filter((a) => a.valid).slice(0, 1) : [];
    planner = { attempt: input.attempt, inputHash: job.inputHash, planVersionId: reusable.length && job.planner ? job.planner.planVersionId : new ObjectId(), requests: 0, answers: reusable };
  }
  const updated = await db.collection<JobDocument>(JOBS_COLLECTION).findOneAndUpdate(
    { _id: job._id, attempt: input.attempt, state: { $in: ["queued", "running"] } },
    {
      $set: {
        state: "running",
        startedAt: job.startedAt ?? now,
        "stages.0.status": "running",
        "stages.0.startedAt": job.stages[0]?.startedAt ?? now,
        progress: { stage: "plan", percent: 10, message: job.progress.message },
        planner,
        ...(input.runId ? { inngestRunId: input.runId } : {}),
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  return updated ? { job: updated, project } : null;
}

/** Read-only: the job, its project, the base version and the revision while the job runs this attempt. */
export async function loadReviseAttempt(db: Db, input: { jobId: string; attempt: number }): Promise<PlanJobContext | null> {
  if (!/^[0-9a-f]{24}$/.test(input.jobId)) return null;
  const job = await getJob(db, new ObjectId(input.jobId));
  if (!job || job.type !== "revise" || job.state !== "running" || job.attempt !== input.attempt || job.planner?.attempt !== input.attempt) return null;
  if (!job.inputRef.planVersionId || !job.inputRef.revisionId) return null;
  const [project, base, revision] = await Promise.all([
    db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: job.projectId, ownerId: job.ownerId, activeJobId: job._id }),
    db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: job.inputRef.planVersionId, projectId: job.projectId }),
    db.collection<RevisionDocument>(REVISIONS_COLLECTION).findOne({ _id: job.inputRef.revisionId, projectId: job.projectId }),
  ]);
  return project && base && revision ? { job, project, base, revision } : null;
}

/** The short reply shown in the chat after a change ("Done. I changed scenes 2 and 3. Now 6 scenes, about 70 seconds."). */
export function revisionReply(diff: SceneDiff, after: { scenes: { id: string }[] }, stats: { sceneCount: number; estimatedSeconds: number }): string {
  const numberOf = (id: string) => after.scenes.findIndex((s) => s.id === id) + 1;
  const list = (ids: string[]) => {
    const n = ids.map(numberOf).filter((x) => x > 0).sort((a, b) => a - b);
    return n.length <= 1 ? String(n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
  };
  const parts: string[] = [];
  if (diff.changedSceneIds.length) parts.push(`changed scene${diff.changedSceneIds.length > 1 ? "s" : ""} ${list(diff.changedSceneIds)}`);
  if (diff.addedSceneIds.length) parts.push(`added scene${diff.addedSceneIds.length > 1 ? "s" : ""} ${list(diff.addedSceneIds)}`);
  if (diff.removedSceneIds.length) parts.push(`removed ${diff.removedSceneIds.length} scene${diff.removedSceneIds.length > 1 ? "s" : ""}`);
  const what = parts.length ? `I ${parts.join(", ")}` : "I updated the storyboard";
  return `Done. ${what}. Now ${stats.sceneCount} scenes, about ${Math.round(stats.estimatedSeconds)} seconds.`;
}

/**
 * The job succeeded (DATABASE.md §7.2 row 18), ONE transaction. A changed storyboard: insert the
 * new `ai_revision` version (n+1, parent = the base), project → that version, no approval,
 * `storyboard_ready`, `activeJobId` cleared, +1 stateVersion; revision `succeeded` with the diff and
 * reply; job `succeeded`. An answer that changes no scene: revision `rejected` with a reply asking
 * what to change, job `needs_input`, project only loses its `activeJobId`. Returns false (nothing
 * written) when the job is no longer running this attempt.
 */
export async function completeReviseJob(db: Db, input: { jobId: ObjectId; attempt: number; result: ValidPlanToSave; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let saved = false;
  try {
    await session.withTransaction(async () => {
      saved = false;
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = await jobs.findOne({ _id: input.jobId, type: "revise", attempt: input.attempt, state: "running" }, { session });
      if (!job?.planner || !job.inputRef.planVersionId || !job.inputRef.revisionId) return;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const project = await projects.findOne({ _id: job.projectId, ownerId: job.ownerId, activeJobId: job._id }, { session });
      if (!project) return;
      const versions = db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION);
      const base = await versions.findOne({ _id: job.inputRef.planVersionId, projectId: job.projectId }, { session });
      const revisions = db.collection<RevisionDocument>(REVISIONS_COLLECTION);
      const revision = await revisions.findOne({ _id: job.inputRef.revisionId, status: "pending" }, { session });
      if (!base || !revision) return;
      const diff = diffScenes(base.plan, input.result.plan);
      const planStage = job.stages[0]!;
      const stages = [
        { ...planStage, status: "succeeded" as const, endedAt: now, error: null },
        { name: "validate", status: "succeeded" as const, startedAt: now, endedAt: now, attempts: 1, error: null },
      ];
      const nothingChanged = !diff.changedSceneIds.length && !diff.addedSceneIds.length && !diff.removedSceneIds.length;

      if (nothingChanged) {
        await revisions.updateOne({ _id: revision._id }, { $set: { status: "rejected", assistantReply: REVISE_MESSAGES.NO_CHANGE, diff, updatedAt: now } }, { session });
        await jobs.updateOne(
          { _id: job._id, attempt: input.attempt, state: "running" },
          {
            $set: {
              state: "needs_input",
              stages,
              progress: { stage: "validate", percent: 100, message: REVISE_MESSAGES.NO_CHANGE },
              needsInput: { reason: "clarification_needed", message: REVISE_MESSAGES.NO_CHANGE, sceneId: revision.sceneId },
              error: null,
              finishedAt: now,
              updatedAt: now,
            },
          },
          { session },
        );
        await projects.updateOne({ _id: project._id, activeJobId: job._id }, { $set: { activeJobId: null, updatedAt: now }, $inc: { stateVersion: 1 } }, { session });
        saved = true;
        return;
      }

      const last = await versions.findOne({ projectId: job.projectId }, { session, sort: { versionNumber: -1 }, projection: { versionNumber: 1 } });
      const versionId = job.planner.planVersionId;
      await versions.insertOne(
        {
          _id: versionId,
          ownerId: job.ownerId,
          projectId: job.projectId,
          schemaVersion: PLAN_VERSION_SCHEMA_VERSION,
          versionNumber: (last?.versionNumber ?? 0) + 1,
          parentVersionId: base._id,
          source: "ai_revision",
          plan: input.result.plan,
          planHash: input.result.planHash,
          validation: { valid: true, issues: [], warnings: input.result.warnings },
          stats: input.result.stats,
          plannerUsage: input.result.plannerUsage,
          createdAt: now,
        },
        { session },
      );
      await projects.updateOne(
        { _id: project._id, activeJobId: job._id },
        { $set: { state: "storyboard_ready", currentPlanVersionId: versionId, approvedPlanVersionId: null, activeJobId: null, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      await revisions.updateOne(
        { _id: revision._id },
        { $set: { status: "succeeded", resultPlanVersionId: versionId, diff, assistantReply: revisionReply(diff, input.result.plan, input.result.stats), updatedAt: now } },
        { session },
      );
      await jobs.updateOne(
        { _id: job._id, attempt: input.attempt, state: "running" },
        {
          $set: {
            state: "succeeded",
            stages,
            progress: { stage: "validate", percent: 100, message: REVISE_MESSAGES.DONE },
            error: null,
            result: { planVersionId: versionId, revisionId: revision._id },
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
 * The job failed, ONE transaction: job `failed` with the plain message (retryable per
 * PLAN_ERROR_RETRYABLE), revision `failed`, the project only loses its `activeJobId` (+1
 * stateVersion): its storyboard and state stay as they were (API.md §8.3). Only while the job is
 * queued/running (and this attempt / not updated since `staleBefore` / queued before `queuedBefore`).
 */
export async function failReviseJob(
  db: Db,
  input: { jobId: ObjectId; attempt?: number; code: PlanJobErrorCode; stage: "plan" | "validate"; detail?: string; staleBefore?: Date; queuedBefore?: Date; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const message = REVISE_MESSAGES[input.code];
  const session = db.client.startSession();
  let failed = false;
  try {
    await session.withTransaction(async () => {
      failed = false;
      const filter = {
        _id: input.jobId,
        type: "revise" as const,
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
        { $set: { state: "failed", stages, progress: { stage: input.stage, percent: job.progress.percent, message }, error: { code: input.code, message, retryable: PLAN_ERROR_RETRYABLE[input.code] }, finishedAt: now, updatedAt: now } },
        { session },
      );
      if (job.inputRef.revisionId) {
        await db.collection<RevisionDocument>(REVISIONS_COLLECTION).updateOne({ _id: job.inputRef.revisionId, status: "pending" }, { $set: { status: "failed", updatedAt: now } }, { session });
      }
      await db.collection<ProjectDocument>(PROJECTS_COLLECTION).updateOne({ _id: job.projectId, activeJobId: job._id }, { $set: { activeJobId: null, updatedAt: now }, $inc: { stateVersion: 1 } }, { session });
      failed = true;
    });
  } finally {
    await session.endSession();
  }
  return failed;
}

/** May this failed revise job be tried again as it is (E2)? A retryable error, or a cancelled job. */
export function canRetryReviseJob(job: JobDocument): boolean {
  if (job.type !== "revise") return false;
  if (job.state === "cancelled") return true;
  return job.state === "failed" && job.error?.retryable === true;
}

/**
 * E2 "Try again" on a failed change request (API.md E2), ONE transaction: no job running, the
 * storyboard is still the version the request was made on (else the request is out of date: ask
 * again), under the 20 AI requests; the same job back to `queued` with attempt + 1, the revision
 * back to `pending`, the project's `activeJobId` set, +1 stateVersion, and the answer saved on the
 * Idempotency-Key record. Counted when the new attempt really asks Gemini.
 */
export async function retryReviseJob(
  db: Db,
  input: { ownerId: string; jobId: string; idempotencyLock?: IdempotencyLock | null; respond: (job: JobDocument) => { status: number; body: unknown }; now?: Date },
): Promise<JobDocument> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.jobId) || !/^[0-9a-f]{24}$/.test(input.ownerId)) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
  const ownerId = new ObjectId(input.ownerId);
  const session = db.client.startSession();
  let result: JobDocument | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const job = await jobs.findOne({ _id: new ObjectId(input.jobId), ownerId }, { session });
      if (!job) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
      const project = await projects.findOne({ _id: job.projectId, ownerId }, { session });
      if (!project) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
      if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.");
      if (!canRetryReviseJob(job)) throw new ProjectActionError("INVALID_STATE", "This change can't be tried again. Please ask for it again.", { jobState: job.state, retryable: job.error?.retryable ?? false });
      if (!STORYBOARD_EDIT_STATES.includes(project.state) || !job.inputRef.planVersionId || !project.currentPlanVersionId?.equals(job.inputRef.planVersionId)) {
        throw new ProjectActionError("INVALID_STATE", "The storyboard changed since this request. Please ask again.", { reason: "storyboard_changed" });
      }
      if (project.planRequestCount >= USAGE_LIMITS.planRequestsPerProject) throw QUOTA(project.planRequestCount);
      const attempt = job.attempt + 1;
      const moved = await projects.updateOne(
        { _id: project._id, activeJobId: null, stateVersion: project.stateVersion, currentPlanVersionId: job.inputRef.planVersionId, planRequestCount: { $lt: USAGE_LIMITS.planRequestsPerProject } },
        { $set: { activeJobId: job._id, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      if (moved.matchedCount !== 1) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      const revision = job.inputRef.revisionId ? await db.collection<RevisionDocument>(REVISIONS_COLLECTION).findOne({ _id: job.inputRef.revisionId }, { session }) : null;
      const sceneIndex = revision?.sceneId ? ((await db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: job.inputRef.planVersionId }, { session, projection: { "plan.scenes.id": 1 } }))?.plan.scenes.findIndex((s) => s.id === revision.sceneId) ?? -1) : -1;
      const updated = await jobs.findOneAndUpdate(
        { _id: job._id, attempt: job.attempt, state: job.state },
        {
          $set: {
            state: "queued",
            attempt,
            stages: job.stages.map((s) => ({ name: s.name, status: "pending" as const, startedAt: null, endedAt: null, attempts: 0, error: null })),
            progress: { stage: "plan", percent: 0, message: reviseProgressMessage(sceneIndex >= 0 ? sceneIndex + 1 : null) },
            error: null,
            needsInput: null,
            result: job.inputRef.revisionId ? { revisionId: job.inputRef.revisionId } : null,
            cancelRequestedAt: null,
            event: { id: retryEventId(job._id, attempt), sentAt: null, lastTriedAt: null },
            queuedAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now,
          },
        },
        { session, returnDocument: "after" },
      );
      if (!updated) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      if (job.inputRef.revisionId) {
        await db.collection<RevisionDocument>(REVISIONS_COLLECTION).updateOne({ _id: job.inputRef.revisionId }, { $set: { status: "pending", updatedAt: now } }, { session });
      }
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

// ---------- D6 history ----------

/** D6: one page of the project's change requests, newest first (`createdAt` desc, `_id` desc). */
export async function listRevisions(
  db: Db,
  project: { _id: ObjectId; ownerId: ObjectId },
  page: { limit: number; cursor: string | null; stage: RevisionStage | null },
): Promise<{ items: RevisionResource[]; nextCursor: string | null }> {
  const filter: Record<string, unknown> = { projectId: project._id, ownerId: project.ownerId, ...(page.stage ? { stage: page.stage } : {}) };
  if (page.cursor) {
    const { c, i, s } = decodeCursor(page.cursor, ["c", "i", "s"]);
    if (typeof c !== "string" || typeof i !== "string" || !/^[0-9a-f]{24}$/.test(i) || Number.isNaN(Date.parse(c)) || s !== (page.stage ?? "")) throw new InvalidCursorError();
    const at = new Date(c);
    filter.$or = [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: new ObjectId(i) } }];
  }
  const docs = await db
    .collection<RevisionDocument>(REVISIONS_COLLECTION)
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(page.limit + 1)
    .toArray();
  const items = docs.slice(0, page.limit);
  const last = items[items.length - 1];
  return {
    items: items.map(toRevisionResource),
    nextCursor: docs.length > page.limit && last ? encodeCursor({ c: last.createdAt.toISOString(), i: last._id.toHexString(), s: page.stage ?? "" }) : null,
  };
}
