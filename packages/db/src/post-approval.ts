import { createHash } from "node:crypto";
import type { ClientSession, Db, Filter, ObjectId } from "mongodb";
import { insertNotifications, newNotification, POST_NOTIFICATIONS } from "./notifications";

// Approval #2 (F30; API.md §9, DATABASE.md §4.22 `posts`, §7.2; PRD §7): the post document and the
// rules that CANCEL an approval. Kept free of projects.ts / jobs.ts so every module that changes a
// project (D3, D4, D5, D7, F4, H1/H7, G3, G4, C5) can import it without an import cycle.
//
// The hard rule: any change the creator requests on the project, a caption change, and disconnecting
// or switching the Instagram account move a post that is `scheduled` or `publish_failed` to
// `approval_invalidated` AT THE MOMENT the change is requested, in the SAME transaction as the change,
// with an `approval_invalidated` notification. Archiving the project moves them to `cancelled`.
// The post's `state` is the real guard: the publish job and H6 only act on a post still in the state
// they expect (conditional updates), so a change made at the last second can never slip through.

export const POSTS_COLLECTION = "posts";
export const PUBLISH_ATTEMPTS_COLLECTION = "publishAttempts";
export const POST_SCHEMA_VERSION = 1;

export type PostMode = "now" | "scheduled";
export type PostState = "draft" | "scheduled" | "publishing" | "outcome_unknown" | "published" | "publish_failed" | "approval_invalidated" | "cancelled";

/** A post that is on its way (the one-live-post-per-project index covers exactly these). */
export const LIVE_POST_STATES: readonly PostState[] = ["scheduled", "publishing", "outcome_unknown"];
/** A post whose approval could still publish later (H6 retry, the scheduled time): a change cancels it. */
export const OPEN_POST_STATES: readonly PostState[] = ["scheduled", "publish_failed"];
/** A post being published right now: archive (C5), disconnect (G4) and account deletion (B3) wait. */
export const IN_FLIGHT_POST_STATES: readonly PostState[] = ["publishing", "outcome_unknown"];

/** Why an approval was cancelled (stored on the post; plain words come from the notification). */
export type InvalidationReason = "narration_edit" | "voice_switch" | "revision" | "restore" | "caption_fix" | "caption_edit" | "instagram_disconnected" | "instagram_account_changed";

export interface PostApproval {
  /** A NEW id for every approval (H2), part of `publishKey`. */
  id: ObjectId;
  renderId: ObjectId;
  mp4Sha256: string;
  connectionId: ObjectId;
  igUserId: string;
  /** `sha256:` + hex of the caption's NFC form (computed by the server). */
  captionHash: string;
  approvedBy: ObjectId;
  approvedAt: Date;
}

export interface PostDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  projectId: ObjectId;
  schemaVersion: number;
  renderId: ObjectId;
  connectionId: ObjectId;
  caption: string;
  mode: PostMode;
  scheduledAt: Date | null;
  approval: PostApproval;
  /** `pub:{projectId}:{renderId}:{connectionId}:{approvalId}` (unique): one approval publishes at most once. */
  publishKey: string;
  state: PostState;
  jobId: ObjectId | null;
  /** The Instagram account as the creator saw it when approving (shown on the Published screen). */
  destination: { username: string; profilePictureUrl: string | null };
  igContainerId: string | null;
  /** When the container was made (Instagram expires an unpublished one after 24 hours). */
  containerCreatedAt: Date | null;
  /** The container's last status we read (IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED). */
  containerStatus: string | null;
  igMediaId: string | null;
  permalink: string | null;
  /**
   * When `media_publish` was last SENT for this post. Set (conditionally, only while null) right
   * before the call; while it is set and there is no `igMediaId`, nothing publishes again until a
   * reconcile has checked Instagram (never twice).
   */
  publishAttemptedAt: Date | null;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: { code: string; message: string; at: Date } | null;
  publishedAt: Date | null;
  invalidatedAt?: Date | null;
  invalidatedReason?: InvalidationReason | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `sha256:` + hex of the NFC caption (API.md §9). The same text always gives the same hash. */
export function captionHash(caption: string): string {
  return `sha256:${createHash("sha256").update(caption.normalize("NFC"), "utf8").digest("hex")}`;
}

/** The unique publish key (API.md §6 "Second layer"). */
export function publishKeyOf(input: { projectId: ObjectId; renderId: ObjectId; connectionId: ObjectId; approvalId: ObjectId }): string {
  return `pub:${input.projectId.toHexString()}:${input.renderId.toHexString()}:${input.connectionId.toHexString()}:${input.approvalId.toHexString()}`;
}

const posts = (db: Db) => db.collection<PostDocument>(POSTS_COLLECTION);

/**
 * Inside the caller's transaction: every `scheduled` / `publish_failed` post that matches (one
 * project, or every post of the owner for G3/G4) → `approval_invalidated`, one notification each.
 * Returns how many posts changed. Cheap when there are none (one indexed read).
 */
export async function invalidateOpenPosts(
  db: Db,
  session: ClientSession,
  input: { ownerId: ObjectId; projectId?: ObjectId; reason: InvalidationReason; now: Date; extraFilter?: Filter<PostDocument> },
): Promise<number> {
  const filter: Filter<PostDocument> = { ownerId: input.ownerId, state: { $in: [...OPEN_POST_STATES] }, ...(input.projectId ? { projectId: input.projectId } : {}), ...input.extraFilter };
  const found = await posts(db).find(filter, { session, projection: { _id: 1, projectId: 1, state: 1 } }).toArray();
  if (found.length === 0) return 0;
  const titles = await projectTitles(db, session, input.ownerId, found.map((p) => p.projectId));
  let changed = 0;
  const notes = [];
  for (const post of found) {
    const moved = await posts(db).updateOne(
      { _id: post._id, ownerId: input.ownerId, state: post.state },
      { $set: { state: "approval_invalidated", invalidatedAt: input.now, invalidatedReason: input.reason, nextAttemptAt: null, updatedAt: input.now } },
      { session },
    );
    if (moved.modifiedCount !== 1) continue;
    changed++;
    const words = POST_NOTIFICATIONS.approval_invalidated(titles.get(post.projectId.toHexString()) ?? "Your video");
    notes.push(newNotification({ ownerId: input.ownerId, type: "approval_invalidated", projectId: post.projectId, postId: post._id, ...words, now: input.now }));
  }
  await insertNotifications(db, session, notes);
  return changed;
}

/** Inside the caller's transaction: the project's `scheduled` / `publish_failed` posts → `cancelled` (C5 archive). */
export async function cancelOpenPosts(db: Db, session: ClientSession, input: { ownerId: ObjectId; projectId: ObjectId; now: Date }): Promise<number> {
  const result = await posts(db).updateMany(
    { ownerId: input.ownerId, projectId: input.projectId, state: { $in: [...OPEN_POST_STATES] } },
    { $set: { state: "cancelled", nextAttemptAt: null, updatedAt: input.now } },
    { session },
  );
  return result.modifiedCount;
}

/** Is a post of this owner (or one project) being published right now? */
export async function hasPostInFlight(db: Db, input: { ownerId: ObjectId; projectId?: ObjectId }, session?: ClientSession): Promise<boolean> {
  const found = await posts(db).findOne(
    { ownerId: input.ownerId, state: { $in: [...IN_FLIGHT_POST_STATES] }, ...(input.projectId ? { projectId: input.projectId } : {}) },
    { ...(session ? { session } : {}), projection: { _id: 1 } },
  );
  return found !== null;
}

/** The project's newest post (any state), or null. */
export async function latestPostOf(db: Db, input: { ownerId: ObjectId; projectId: ObjectId }, session?: ClientSession): Promise<PostDocument | null> {
  return posts(db).findOne({ ownerId: input.ownerId, projectId: input.projectId }, { ...(session ? { session } : {}), sort: { createdAt: -1, _id: -1 } });
}

async function projectTitles(db: Db, session: ClientSession, ownerId: ObjectId, ids: readonly ObjectId[]): Promise<Map<string, string>> {
  const docs = await db
    .collection<{ _id: ObjectId; title: string }>("projects")
    .find({ _id: { $in: [...ids] }, ownerId }, { session, projection: { title: 1 } })
    .toArray();
  return new Map(docs.map((d) => [d._id.toHexString(), d.title]));
}

/** API.md §11.3 `PostSummary` (C3/C6 `latestPost`). */
export type PostSummaryResource = { id: string; state: PostState; mode: PostMode; scheduledAt: string | null; permalink: string | null };

export function toPostSummary(doc: Pick<PostDocument, "_id" | "state" | "mode" | "scheduledAt" | "permalink">): PostSummaryResource {
  return { id: doc._id.toHexString(), state: doc.state, mode: doc.mode, scheduledAt: doc.scheduledAt ? doc.scheduledAt.toISOString() : null, permalink: doc.permalink };
}
