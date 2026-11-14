import { type Db, ObjectId } from "mongodb";
import { STORYBOARD_APPROVALS_COLLECTION, type StoryboardApprovalDocument } from "./storyboard-approvals";

// Storyboard versions (docs/DATABASE.md §4.10 `planVersions`, insert-only). The AI's first plan is
// version 1 (F15); narration edits and voice switches (F17, F19) and AI revisions (F18) add new
// versions. A version is never changed after it is saved, so an approval always points to one
// exact storyboard.
// The plan itself is the pipeline's plan contract (packages/pipeline/src/contracts/plan.ts); this
// package doesn't depend on the pipeline, so it is stored as a plain object here.
// F16: the API shapes `PlanVersionSummary` (D1) and `PlanVersion` (D2), API.md §11.3.

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

export interface StoredNarration {
  id: string;
  text: string;
  speech?: string | null;
  display?: string | null;
}

export interface StoredObject {
  id: string;
  kind: string;
  label: string;
  icon?: string;
  value?: number | null;
}

export interface StoredScene {
  id: string;
  type: string;
  narration: StoredNarration[];
  objects: StoredObject[];
  events?: unknown[];
}

/** The parts of a stored plan the app reads directly (the rest is kept as it is). */
export interface StoredPlan {
  topic: string;
  language?: string;
  voicePreset?: string;
  scenes: StoredScene[];
  warnings?: { sceneId: string | null; message: string }[];
  [key: string]: unknown;
}

const isHexId = (id: string) => /^[0-9a-f]{24}$/.test(id);

/** The project's current storyboard version, only for its owner. */
export async function getCurrentPlanVersion(db: Db, project: { ownerId: ObjectId; currentPlanVersionId: ObjectId | null }): Promise<PlanVersionDocument | null> {
  if (!project.currentPlanVersionId) return null;
  return db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: project.currentPlanVersionId, ownerId: project.ownerId });
}

/** One version of this project (owner-scoped), or null for a malformed id, another project's version or a missing one. */
export async function getProjectPlanVersion(db: Db, project: { _id: ObjectId; ownerId: ObjectId }, planVersionId: string): Promise<PlanVersionDocument | null> {
  if (!isHexId(planVersionId)) return null;
  return db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: new ObjectId(planVersionId), projectId: project._id, ownerId: project.ownerId });
}

// ---------- what changed between two versions ----------

/** JSON with object keys sorted at every level, so two equal scenes always give the same text. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

export interface SceneDiff {
  /** Scenes in both versions whose content differs. */
  changedSceneIds: string[];
  /** Scenes only in the newer version. */
  addedSceneIds: string[];
  /** Scenes only in the older version. */
  removedSceneIds: string[];
  /** True when any narration text (what is spoken) differs. */
  narrationChanged: boolean;
}

/** Scene by scene comparison (by scene id), as stored on a revision (DATABASE.md §4.11 `diff`). */
export function diffScenes(before: Pick<StoredPlan, "scenes"> | null, after: Pick<StoredPlan, "scenes">): SceneDiff {
  const old = new Map((before?.scenes ?? []).map((s) => [s.id, s]));
  const next = new Map(after.scenes.map((s) => [s.id, s]));
  const changedSceneIds: string[] = [];
  const addedSceneIds: string[] = [];
  for (const scene of after.scenes) {
    const previous = old.get(scene.id);
    if (!previous) addedSceneIds.push(scene.id);
    else if (stableJson(previous) !== stableJson(scene)) changedSceneIds.push(scene.id);
  }
  const removedSceneIds = [...old.keys()].filter((id) => !next.has(id));
  const spoken = (plan: Pick<StoredPlan, "scenes"> | null) => stableJson((plan?.scenes ?? []).map((s) => s.narration.map((n) => [n.text, n.speech ?? null])));
  return { changedSceneIds, addedSceneIds, removedSceneIds, narrationChanged: spoken(before) !== spoken(after) };
}

// ---------- API resources (API.md §11.3) ----------

export type PlanVersionSummaryResource = {
  id: string;
  projectId: string;
  versionNumber: number;
  parentVersionId: string | null;
  source: PlanVersionSource;
  planHash: string;
  isCurrent: boolean;
  isApproved: boolean;
  valid: boolean;
  stats: PlanStatsDoc;
  createdAt: string;
};

export type PlanVersionResource = PlanVersionSummaryResource & {
  plan: StoredPlan;
  validation: PlanVersionDocument["validation"];
  approval: { id: string; approvedBy: string; approvedAt: string } | null;
  /** Scenes that differ from the parent version (changed or new), for the "Changed" tag. */
  changedSceneIds: string[];
};

/**
 * `isApproved`: this exact version has a storyboard approval (approval #1). Whether the project is
 * approved NOW is `project.approvedPlanVersionId === project.currentPlanVersionId`.
 */
export function toPlanVersionSummary(doc: PlanVersionDocument, project: { currentPlanVersionId: ObjectId | null }, approval: StoryboardApprovalDocument | null): PlanVersionSummaryResource {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    versionNumber: doc.versionNumber,
    parentVersionId: doc.parentVersionId ? doc.parentVersionId.toHexString() : null,
    source: doc.source,
    planHash: doc.planHash,
    isCurrent: project.currentPlanVersionId?.equals(doc._id) ?? false,
    isApproved: approval !== null,
    valid: doc.validation.valid,
    stats: doc.stats,
    createdAt: doc.createdAt.toISOString(),
  };
}

export function toPlanVersionResource(
  doc: PlanVersionDocument,
  project: { currentPlanVersionId: ObjectId | null },
  approval: StoryboardApprovalDocument | null,
  parent: Pick<PlanVersionDocument, "plan"> | null,
): PlanVersionResource {
  const diff = parent ? diffScenes(parent.plan, doc.plan) : null;
  return {
    ...toPlanVersionSummary(doc, project, approval),
    plan: doc.plan,
    validation: doc.validation,
    approval: approval ? { id: approval._id.toHexString(), approvedBy: approval.approvedBy.toHexString(), approvedAt: approval.approvedAt.toISOString() } : null,
    changedSceneIds: diff ? [...diff.changedSceneIds, ...diff.addedSceneIds] : [],
  };
}

/** D2: one version with its approval and its parent (for `changedSceneIds`), as the API resource. */
export async function loadPlanVersionResource(db: Db, project: { _id: ObjectId; ownerId: ObjectId; currentPlanVersionId: ObjectId | null }, doc: PlanVersionDocument): Promise<PlanVersionResource> {
  const [approval, parent] = await Promise.all([
    db.collection<StoryboardApprovalDocument>(STORYBOARD_APPROVALS_COLLECTION).findOne({ planVersionId: doc._id, ownerId: project.ownerId }),
    doc.parentVersionId
      ? db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: doc.parentVersionId, projectId: project._id }, { projection: { plan: 1 } })
      : Promise.resolve(null),
  ]);
  return toPlanVersionResource(doc, project, approval, parent);
}

// ---------- D1 version history (newest first, cursor pages, API.md §5) ----------

export const PAGE_LIMITS = { default: 20, max: 50 } as const;

/** A cursor the client got from us. Anything else (tampered, wrong list) is refused. */
export class InvalidCursorError extends Error {
  constructor() {
    super("The list cursor is invalid. Reload the list.");
    this.name = "InvalidCursorError";
  }
}

export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, keys: readonly string[]): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw new InvalidCursorError();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidCursorError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== [...keys].sort().join()) throw new InvalidCursorError();
  return record;
}

/** D1: one page of the project's versions, newest first (`versionNumber` desc; unique per project). */
export async function listPlanVersions(
  db: Db,
  project: { _id: ObjectId; ownerId: ObjectId; currentPlanVersionId: ObjectId | null },
  page: { limit: number; cursor: string | null },
): Promise<{ items: PlanVersionSummaryResource[]; nextCursor: string | null }> {
  let before: number | null = null;
  if (page.cursor) {
    const { v } = decodeCursor(page.cursor, ["v"]);
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new InvalidCursorError();
    before = v;
  }
  const docs = await db
    .collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION)
    .find({ projectId: project._id, ownerId: project.ownerId, ...(before !== null ? { versionNumber: { $lt: before } } : {}) }, { projection: { plan: 0 } })
    .sort({ versionNumber: -1 })
    .limit(page.limit + 1)
    .toArray();
  const items = docs.slice(0, page.limit);
  const approvals = items.length
    ? await db
        .collection<StoryboardApprovalDocument>(STORYBOARD_APPROVALS_COLLECTION)
        .find({ planVersionId: { $in: items.map((d) => d._id) }, ownerId: project.ownerId })
        .toArray()
    : [];
  const approvalOf = (id: ObjectId) => approvals.find((a) => a.planVersionId.equals(id)) ?? null;
  return {
    items: items.map((d) => toPlanVersionSummary(d, project, approvalOf(d._id))),
    nextCursor: docs.length > page.limit ? encodeCursor({ v: items[items.length - 1]!.versionNumber }) : null,
  };
}
