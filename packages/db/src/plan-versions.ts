import type { Db, ObjectId } from "mongodb";

// Storyboard versions (docs/DATABASE.md §4.10 `planVersions`, insert-only). The AI's first plan is
// version 1 (F15); edits, voice switches and revisions add new versions later (F17–F19). A version
// is never changed after it is saved, so an approval always points to one exact storyboard.
// The plan itself is the pipeline's plan contract (packages/pipeline/src/contracts/plan.ts); this
// package doesn't depend on the pipeline, so it is stored as a plain object here.

export const PLAN_VERSIONS_COLLECTION = "planVersions";
export const PLAN_VERSION_SCHEMA_VERSION = 1;

export type PlanVersionSource = "ai_plan" | "ai_revision" | "user_edit" | "caption_edit";

export interface PlanStatsDoc {
  sceneCount: number;
  wordCount: number;
  estimatedSeconds: number;
}

export interface ValidationIssueDoc {
  sceneId: string | null;
  path: string;
  message: string;
}

export interface PlanVersionDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  projectId: ObjectId;
  schemaVersion: number;
  versionNumber: number;
  parentVersionId: ObjectId | null;
  source: PlanVersionSource;
  /** The full plan (API.md §11.2). `ownerId`, `projectId`, `versionId` inside it are set by code. */
  plan: StoredPlan;
  planHash: string;
  validation: { valid: boolean; issues: ValidationIssueDoc[]; warnings: ValidationIssueDoc[] };
  stats: PlanStatsDoc;
  plannerUsage: { model: string; promptTokens: number; outputTokens: number; thinkingTokens: number; attempts: number } | null;
  createdAt: Date;
}

/** The parts of a stored plan the app reads directly (the rest is kept as it is). */
export interface StoredPlan {
  topic: string;
  scenes: { id: string; type: string; narration: { id: string; text: string }[]; objects: { id: string; kind: string; label: string }[] }[];
  [key: string]: unknown;
}

/** The project's current storyboard version, only for its owner. */
export async function getCurrentPlanVersion(db: Db, project: { ownerId: ObjectId; currentPlanVersionId: ObjectId | null }): Promise<PlanVersionDocument | null> {
  if (!project.currentPlanVersionId) return null;
  return db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: project.currentPlanVersionId, ownerId: project.ownerId });
}
