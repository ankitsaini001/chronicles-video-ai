import { ObjectId, type ClientSession, type Db } from "mongodb";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./plan-versions";

// Finished videos (docs/DATABASE.md §4.19 `renders`, F23). The MP4, thumbnail and timing files are in
// R2 (users/{ownerId}/projects/{projectId}/renders/{renderId}/…); this document holds their keys, the
// storyboard version and recordings used, the machine checks and the MP4's SHA-256 (approval #2 is
// bound to it). As built in F23 a render document is written only when the video is READY (in the
// same transaction that makes it the project's video): an attempt in progress lives on its job
// (`jobs.render.renderId`), so a failed attempt never takes a video number. Never deleted
// (PRD §6.0: earlier successful versions stay playable and downloadable, F24).

export const RENDERS_COLLECTION = "renders";
export const RENDER_SCHEMA_VERSION = 1;

export interface RenderDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  projectId: ObjectId;
  schemaVersion: number;
  planVersionId: ObjectId;
  planHash: string;
  /** Video 1, 2, 3… per project (successful videos only). */
  renderNumber: number;
  speech: { sceneId: string; speechArtifactId: ObjectId }[];
  captionOverrideSetId: ObjectId | null;
  timelineKey: string;
  captionsKey: string;
  mp4Key: string;
  thumbnailKey: string;
  qaKey: string;
  previewFrameKeys: string[];
  /** sha256 of the plan hash + recordings + music switch (identical input → same hash; reuse comes later). */
  renderInputHash: string;
  /** "sha256:<hex>" of output.mp4 (also saved on the R2 object). */
  mp4Sha256: string;
  qa: Record<string, unknown>;
  status: "pending" | "rendering" | "validating" | "ready" | "failed";
  metrics: { renderMs: number; bundleMs: number; bytes: number; durationMs: number; frames: number };
  error: { code: string; message: string } | null;
  createdAt: Date;
  readyAt: Date | null;
}

export type RenderStatus = RenderDocument["status"];

/** The project's current video (owner-scoped), or null. */
export async function getRender(db: Db, ownerId: ObjectId, renderId: ObjectId, session?: ClientSession): Promise<RenderDocument | null> {
  return db.collection<RenderDocument>(RENDERS_COLLECTION).findOne({ _id: renderId, ownerId }, session ? { session } : {});
}

/** The newest ready video of one storyboard version (D8 re-approval reuses it). */
export async function latestReadyRenderOf(db: Db, input: { ownerId: ObjectId; projectId: ObjectId; planVersionId: ObjectId }, session?: ClientSession): Promise<RenderDocument | null> {
  return db
    .collection<RenderDocument>(RENDERS_COLLECTION)
    .findOne({ ownerId: input.ownerId, projectId: input.projectId, planVersionId: input.planVersionId, status: "ready" }, { sort: { renderNumber: -1 }, ...(session ? { session } : {}) });
}

/** The current videos of these projects, for the My videos cards (owner-scoped: never another user's). */
export async function rendersForCards(db: Db, ownerId: ObjectId, renderIds: readonly ObjectId[]): Promise<Pick<RenderDocument, "_id" | "projectId" | "planVersionId" | "thumbnailKey">[]> {
  if (renderIds.length === 0) return [];
  return db
    .collection<RenderDocument>(RENDERS_COLLECTION)
    .find({ _id: { $in: [...renderIds] }, ownerId, status: "ready" }, { projection: { _id: 1, projectId: 1, planVersionId: 1, thumbnailKey: 1 } })
    .toArray();
}

// ---------- F24: video versions (F1) and one video of a project (F3) ----------

/** The project fields the video endpoints need (already loaded with the owner check). */
export type RenderProject = { _id: ObjectId; ownerId: ObjectId; currentRenderId: ObjectId | null };

/**
 * One video of this project (owner AND project scoped): `renderId` is 24 lowercase hex or the
 * literal "current" (the project's video). Anything else, another project's video and another
 * owner's video are all null (the route answers 404, never 403).
 */
export async function findProjectRender(db: Db, project: RenderProject, renderId: string): Promise<RenderDocument | null> {
  const id = renderId === "current" ? project.currentRenderId : /^[0-9a-f]{24}$/.test(renderId) ? new ObjectId(renderId) : null;
  if (!id) return null;
  return db.collection<RenderDocument>(RENDERS_COLLECTION).findOne({ _id: id, ownerId: project.ownerId, projectId: project._id });
}

/**
 * F1: one page of the project's videos, newest first (`renderNumber` desc; unique per project, so it
 * is its own tie-breaker). The cursor is the last `renderNumber` shown (like D1's `versionNumber`).
 * Uses the F23 index `projectId_renderNumber_unique`. Throws InvalidCursorError for a bad cursor.
 */
export async function listProjectRenders(db: Db, project: RenderProject, page: { limit: number; cursor: string | null }): Promise<{ items: RenderDocument[]; nextCursor: string | null }> {
  let before: number | null = null;
  if (page.cursor) {
    const { n } = decodeCursor(page.cursor, ["n"]);
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new InvalidCursorError();
    before = n;
  }
  const docs = await db
    .collection<RenderDocument>(RENDERS_COLLECTION)
    .find({ projectId: project._id, ownerId: project.ownerId, ...(before !== null ? { renderNumber: { $lt: before } } : {}) }, { projection: { qa: 0, speech: 0 } })
    .sort({ renderNumber: -1 })
    .limit(page.limit + 1)
    .toArray();
  const items = docs.slice(0, page.limit);
  return { items, nextCursor: docs.length > page.limit ? encodeCursor({ n: items[items.length - 1]!.renderNumber }) : null };
}

/** API.md §11.3 RenderSummary. Every video is 1080×1920 at 30 fps (the MP4 checks refuse anything else). */
export interface RenderSummaryResource {
  id: string;
  projectId: string;
  renderNumber: number;
  planVersionId: string;
  planHash: string;
  status: RenderStatus;
  /** This is the project's video (`projects.currentRenderId`). */
  isCurrent: boolean;
  durationMs: number | null;
  mp4Sha256: string | null;
  bytes: number | null;
  width: 1080;
  height: 1920;
  fps: 30;
  captionOverrideSetId: string | null;
  /** A 15-minute private link, made only after the owner check (null when storage isn't set up). */
  thumbnailUrl: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  readyAt: string | null;
}

export function toRenderSummary(doc: RenderDocument, project: Pick<RenderProject, "currentRenderId">, thumbnailUrl: string | null): RenderSummaryResource {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    renderNumber: doc.renderNumber,
    planVersionId: doc.planVersionId.toHexString(),
    planHash: doc.planHash,
    status: doc.status,
    isCurrent: project.currentRenderId !== null && project.currentRenderId.equals(doc._id),
    durationMs: doc.metrics?.durationMs ?? null,
    mp4Sha256: doc.mp4Sha256 ?? null,
    bytes: doc.metrics?.bytes ?? null,
    width: 1080,
    height: 1920,
    fps: 30,
    captionOverrideSetId: doc.captionOverrideSetId ? doc.captionOverrideSetId.toHexString() : null,
    thumbnailUrl,
    error: doc.error ? { code: doc.error.code, message: doc.error.message } : null,
    createdAt: doc.createdAt.toISOString(),
    readyAt: doc.readyAt ? doc.readyAt.toISOString() : null,
  };
}
