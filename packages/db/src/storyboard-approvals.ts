import { type ClientSession, type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { AUDIT_LOGS_COLLECTION, STORYBOARD_APPROVALS_COLLECTION } from "./collections";
import type { PlanVersionDocument } from "./plan-versions";
import type { ProjectDocument, ProjectState } from "./projects";

// Approval #1, the storyboard (docs/DATABASE.md §4.12 `storyboardApprovals`, insert-only; API.md §9).
// Proof that the creator approved one EXACT storyboard version (its id + its plan hash). Created
// only by the signed-in creator through D8 (F20); background jobs, admins and the AI never create
// one. A new storyboard version has no approval, so any change needs a new approval.
// Since F23, D8 approves AND starts the video job in one transaction (generate-jobs.ts).

export { AUDIT_LOGS_COLLECTION, STORYBOARD_APPROVALS_COLLECTION };
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

// ---------- D8 (F20 approval; F23 adds the video job: generate-jobs.ts approveAndGenerate) ----------

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
 * The version's approval (approvals are immutable, one per version), or a new one + its audit entry.
 * Inside the caller's transaction (D8). An approval made in F20 (no video job yet) is reused, never a second row.
 */
export async function findOrCreateApproval(db: Db, session: ClientSession, project: ProjectDocument, version: PlanVersionDocument, now: Date): Promise<StoryboardApprovalDocument> {
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
