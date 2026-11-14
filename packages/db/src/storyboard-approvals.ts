import type { ObjectId } from "mongodb";

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
