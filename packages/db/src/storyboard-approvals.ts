import { type ClientSession, type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { finishIdempotencyInTransaction, type IdempotencyLock } from "./idempotency";
import { PLAN_VERSIONS_COLLECTION, type PlanVersionDocument } from "./plan-versions";
import { ProjectActionError, PROJECTS_COLLECTION, type ProjectDocument, type ProjectState } from "./projects";

// Approval #1, the storyboard (docs/DATABASE.md §4.12 `storyboardApprovals`, insert-only; API.md §9).
// Proof that the creator approved one EXACT storyboard version (its id + its plan hash). Created
// only by the signed-in creator through D8 (F20); background jobs, admins and the AI never create
// one. A new storyboard version has no approval, so any change needs a new approval.

export const STORYBOARD_APPROVALS_COLLECTION = "storyboardApprovals";
export const STORYBOARD_APPROVAL_SCHEMA_VERSION = 1;

export interface StoryboardApprovalDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  projectId: ObjectId;
  schemaVersion: number;
  planVersionId: ObjectId;
  planHash: string;
  approvedBy: ObjectId;
  approvedAt: Date;
}

/** The `StoryboardApproval` resource (API.md §11.3). */
export type StoryboardApprovalResource = {
  id: string;
  projectId: string;
  planVersionId: string;
  planHash: string;
  approvedBy: string;
  approvedAt: string;
};

export function toStoryboardApprovalResource(doc: StoryboardApprovalDocument): StoryboardApprovalResource {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    planVersionId: doc.planVersionId.toHexString(),
    planHash: doc.planHash,
    approvedBy: doc.approvedBy.toHexString(),
    approvedAt: doc.approvedAt.toISOString(),
  };
}

// ---------- D8: approve (F20) ----------

export const AUDIT_LOGS_COLLECTION = "auditLogs";

/** States in which a storyboard can be approved (API.md §9). */
export const APPROVABLE_STATES: readonly ProjectState[] = ["storyboard_ready", "generate_failed"];

/** D8 body (API.md D8). */
export const StoryboardApprovalBodySchema = z.strictObject({
  planVersionId: z.string({ error: "must be text" }).regex(/^[0-9a-f]{24}$/, { error: "is not a valid id" }),
  planHash: z.string({ error: "must be text" }).regex(/^sha256:[0-9a-f]{64}$/, { error: "must be sha256:<64 hex characters>" }),
  expectedStateVersion: z.number({ error: "must be a whole number" }).int({ error: "must be a whole number" }).min(1, { error: "must be at least 1" }),
});
export type StoryboardApprovalBody = z.output<typeof StoryboardApprovalBodySchema>;

/**
 * D8 approval #1 (API.md §9, D8; DATABASE.md §7.2 row 6), ONE transaction. The creator approves the
 * EXACT version on screen: it must be the current version (`APPROVAL_STALE` not_current), with the
 * same plan hash (`APPROVAL_STALE` plan_hash_mismatch), valid (`PLAN_INVALID` with the issues), no
 * job running, the stateVersion the browser saw, state storyboard_ready / generate_failed.
 * Effect: insert `storyboardApprovals` (or reuse the one this exact version already has, e.g. after
 * an undo; unique per version) + an `auditLogs` entry, project `approvedPlanVersionId` = the version,
 * +1 stateVersion, and the answer saved on the Idempotency-Key record.
 * F20 stops here: NO video job and NO videos/day count yet (F23 adds them). The project stays
 * `storyboard_ready` with `approvedPlanVersionId === currentPlanVersionId`, which is exactly what
 * F23's D8 finds for "this version is approved but has no generate job yet" (it then starts the job
 * without a second approval). Any later change makes a new version (or restores another one), so
 * `approvedPlanVersionId` no longer equals the current version: a new approval is needed.
 */
export async function approveStoryboard(
  db: Db,
  input: {
    ownerId: string;
    projectId: string;
    body: StoryboardApprovalBody;
    idempotencyLock?: IdempotencyLock | null;
    respond: (out: { approval: StoryboardApprovalDocument; project: ProjectDocument }) => { status: number; body: unknown };
    now?: Date;
  },
): Promise<{ approval: StoryboardApprovalDocument; project: ProjectDocument }> {
  const now = input.now ?? new Date();
  const { body } = input;
  const session = db.client.startSession();
  let result: { approval: StoryboardApprovalDocument; project: ProjectDocument } | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const project =
        /^[0-9a-f]{24}$/.test(input.projectId) && /^[0-9a-f]{24}$/.test(input.ownerId)
          ? await projects.findOne({ _id: new ObjectId(input.projectId), ownerId: new ObjectId(input.ownerId) }, { session })
          : null;
      if (!project) throw new ProjectActionError("NOT_FOUND", "We couldn't find this project.");
      if (project.state === "archived") throw new ProjectActionError("INVALID_STATE", "This project is archived.", { state: project.state });
      if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.", { activeJobId: project.activeJobId.toHexString() });
      if (project.stateVersion !== body.expectedStateVersion) {
        throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.", { expectedStateVersion: body.expectedStateVersion, currentStateVersion: project.stateVersion });
      }
      if (!APPROVABLE_STATES.includes(project.state) || !project.currentPlanVersionId) {
        throw new ProjectActionError("INVALID_STATE", "This storyboard can't be approved right now.", { state: project.state });
      }
      const current = project.currentPlanVersionId.toHexString();
      if (body.planVersionId !== current) {
        throw new ProjectActionError("APPROVAL_STALE", "Something changed since you reviewed it. Please review again.", { reason: "not_current", currentPlanVersionId: current });
      }
      const version = await db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: project.currentPlanVersionId, projectId: project._id, ownerId: project.ownerId }, { session });
      if (!version) throw new Error(`Project ${project._id.toHexString()} points to a missing plan version.`);
      if (version.planHash !== body.planHash) {
        throw new ProjectActionError("APPROVAL_STALE", "Something changed since you reviewed it. Please review again.", { reason: "plan_hash_mismatch", currentPlanVersionId: current });
      }
      if (!version.validation.valid) {
        throw new ProjectActionError("PLAN_INVALID", "Some scenes need fixing before you can approve.", { issues: version.validation.issues });
      }
      const approval = await findOrCreateApproval(db, session, project, version, now);
      let updated = project;
      if (!project.approvedPlanVersionId?.equals(version._id)) {
        const moved = await projects.findOneAndUpdate(
          { _id: project._id, stateVersion: project.stateVersion, activeJobId: null, currentPlanVersionId: version._id },
          { $set: { approvedPlanVersionId: version._id, updatedAt: now }, $inc: { stateVersion: 1 } },
          { session, returnDocument: "after" },
        );
        if (!moved) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
        updated = moved;
      }
      if (input.idempotencyLock) {
        const answer = input.respond({ approval, project: updated });
        await finishIdempotencyInTransaction(db, input.idempotencyLock, answer.status, answer.body, session);
      }
      result = { approval, project: updated };
    });
  } finally {
    await session.endSession();
  }
  return result!;
}

/** The version's approval (approvals are immutable, one per version), or a new one + its audit entry. */
async function findOrCreateApproval(db: Db, session: ClientSession, project: ProjectDocument, version: PlanVersionDocument, now: Date): Promise<StoryboardApprovalDocument> {
  const approvals = db.collection<StoryboardApprovalDocument>(STORYBOARD_APPROVALS_COLLECTION);
  const existing = await approvals.findOne({ planVersionId: version._id, ownerId: project.ownerId }, { session });
  if (existing) return existing;
  const approval: StoryboardApprovalDocument = {
    _id: new ObjectId(),
    ownerId: project.ownerId,
    projectId: project._id,
    schemaVersion: STORYBOARD_APPROVAL_SCHEMA_VERSION,
    planVersionId: version._id,
    planHash: version.planHash,
    approvedBy: project.ownerId,
    approvedAt: now,
  };
  await approvals.insertOne(approval, { session });
  await db.collection(AUDIT_LOGS_COLLECTION).insertOne(
    { schemaVersion: 1, actorId: project.ownerId, action: "storyboard.approved", subject: { type: "planVersion", id: version._id }, data: { projectId: project._id, approvalId: approval._id }, at: now },
    { session },
  );
  return approval;
}
