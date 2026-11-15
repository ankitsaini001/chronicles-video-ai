import type { ClientSession, Db, ObjectId } from "mongodb";

// Finished videos (docs/DATABASE.md §4.19 `renders`, F23). The MP4, thumbnail and timing files are in
// R2 (users/{ownerId}/projects/{projectId}/renders/{renderId}/…); this document holds their keys, the
// storyboard version and recordings used, the machine checks and the MP4's SHA-256 (approval #2 is
// bound to it). As built in F23 a render document is written only when the video is READY (in the
// same transaction that makes it the project's video): an attempt in progress lives on its job
// (`jobs.render.renderId`), so a failed attempt never takes a video number. Never deleted.

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
