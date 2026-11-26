import { type ClientSession, type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { AUDIT_LOGS_COLLECTION } from "./collections";
import { finishIdempotencyInTransaction, type IdempotencyLock } from "./idempotency";
import { INSTAGRAM_CONNECTIONS_COLLECTION, type InstagramConnectionDocument } from "./instagram-connections";
import { JOB_SCHEMA_VERSION, JOBS_COLLECTION, retryEventId, type JobDocument, type JobStage } from "./jobs";
import { USER_COLLECTION } from "./login-guard";
import { insertNotifications, newNotification, POST_NOTIFICATIONS } from "./notifications";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./plan-versions";
import {
  captionHash,
  CHECKABLE_POST_STATES,
  findUnconfirmedPost,
  isCheckablePost,
  LIVE_POST_STATES,
  latestPostOf,
  POST_SCHEMA_VERSION,
  POSTS_COLLECTION,
  PUBLISH_ATTEMPTS_COLLECTION,
  publishKeyOf,
  type PostDocument,
  type PostMode,
  type PostState,
} from "./post-approval";
import { cleanPostCaptionText, POST_CAPTION_LIMITS, postCaptionLength } from "./post-caption";
import { istDateTimeLabel, parseScheduledAt, SCHEDULE_MESSAGES, scheduleProblem, SCHEDULE_LIMITS } from "./post-schedule";
import { ProjectActionError, PROJECTS_COLLECTION, type ProjectDocument } from "./projects";
import { RENDERS_COLLECTION, type RenderDocument } from "./renders";

// F30 "Publish now (approval #2)" (docs/API.md H2, H3, H4, H6, §9; DATABASE.md §4.22–4.24, §7.2 rows
// 9 and 11; ARCHITECTURE §17.3–17.4, §18).
// - H2 (approvePost), ONE transaction: every check (the video is the project's current, ready video
//   made from the approved storyboard, the same MP4 fingerprint, the creator's active Instagram
//   connection), then the post with its approval snapshot (a NEW approval id → a new `publishKey`),
//   its queued `publish` job (key `pubjob:{postId}`), project → `publishing`, audit `post.approved`,
//   the answer saved on the Idempotency-Key record. The Inngest event is sent AFTER the commit.
// - H6 (retryPost): a `publish_failed` post on its OWN approval, after the full re-check (§9).
// - The worker functions the publish job calls (apps/web/lib/publish/run-publish-job.ts). Every
//   write is conditional on "this job, this attempt, still running" and on the post's state, so a
//   late write of an older run changes nothing. The approval is re-checked (recheckPublishApproval)
//   right before the container is created and right before `media_publish`.
// - Never twice: `media_publish` is "claimed" (publishAttemptedAt, set only while null) before it is
//   sent; once claimed, nothing publishes again until a reconcile has looked at Instagram.

export const PUBLISH_STAGES = ["approve", "create_container", "poll", "publish"] as const;
export type PublishStage = (typeof PUBLISH_STAGES)[number] | "reconcile";
const STAGE_ORDER: readonly PublishStage[] = ["approve", "create_container", "poll", "publish", "reconcile"];

/** Instagram hiccups are retried automatically for about this long, then the post fails (decision 2). */
export const PUBLISH_RETRY_WINDOW_MS = 10 * 60_000;
/** Instagram expires an unpublished container after 24 hours; we reuse one only while it is younger than this. */
export const CONTAINER_REUSE_MS = 23 * 60 * 60_000;

/** Progress lines (shown as is; API.md §8.2 `progress.message`). */
export const PUBLISH_MESSAGES = {
  QUEUED: "Getting ready…",
  APPROVE: "Checking your approval…",
  SENDING: "Sending your video to Instagram…",
  PROCESSING: "Instagram is processing it…",
  PUBLISHING: "Publishing…",
  CHECKING: "Checking whether your post went live…",
  RETRYING: "Instagram is busy, trying again…",
  DONE: "Your reel is live!",
} as const;

export type PublishErrorCode = "APPROVAL_STALE" | "INSTAGRAM_NOT_CONNECTED" | "INSTAGRAM_TOKEN_EXPIRED" | "PUBLISH_LIMIT_REACHED" | "PUBLISH_FAILED" | "SCHEDULE_MISSED" | "INTERNAL";

/** Why a post failed, in plain words (post.lastError / job.error). `retryable` → Try again (H6). */
export const PUBLISH_FAILURES = {
  approval_stale: { code: "APPROVAL_STALE", message: "Something changed since you approved this post. Please check it and approve it again.", retryable: false },
  not_connected: { code: "INSTAGRAM_NOT_CONNECTED", message: "Your Instagram isn't connected any more. Please connect it again, then try again.", retryable: true },
  token_expired: { code: "INSTAGRAM_TOKEN_EXPIRED", message: "Instagram needs reconnecting. Please connect again, then try again.", retryable: true },
  limit: { code: "PUBLISH_LIMIT_REACHED", message: "Instagram's daily posting limit for your account was reached. Please try again in a few hours.", retryable: true },
  processing_error: { code: "PUBLISH_FAILED", message: "Instagram couldn't process this video. Please try again in a few minutes.", retryable: true },
  too_slow: { code: "PUBLISH_FAILED", message: "Instagram is busy or taking too long right now. Please try again in a few minutes.", retryable: true },
  rejected: { code: "PUBLISH_FAILED", message: "Instagram didn't accept this post. Please try again in a few minutes.", retryable: true },
  video_unreachable: { code: "PUBLISH_FAILED", message: "Instagram couldn't fetch your video. Please try again in a few minutes.", retryable: true },
  unconfirmed: {
    code: "PUBLISH_FAILED",
    message: "We couldn't confirm whether your reel went live. Try again checks Instagram first, so it is never posted twice.",
    retryable: true,
  },
  internal: { code: "INTERNAL", message: "Something went wrong on our side. Please try again.", retryable: true },
  // F31 (founder decision 3): a scheduled post that hadn't started publishing 1 hour after its time is
  // never posted late. Not retryable: Publish now or Schedule again is a NEW approval (H2).
  missed: { code: "SCHEDULE_MISSED", message: "This post missed its scheduled time, so it wasn't posted. Publish now or pick a new time.", retryable: false },
} as const satisfies Record<string, { code: PublishErrorCode; message: string; retryable: boolean }>;
export type PublishFailure = keyof typeof PUBLISH_FAILURES;

/** H2/H6 refusals (API.md H2, H6, §4.3). */
export const POST_MESSAGES = {
  POST_NOT_FOUND: "We couldn't find this post.",
  PROJECT_NOT_FOUND: "We couldn't find this project.",
  NOT_READY: "This video can't be published right now. Please go back to your video.",
  ALREADY_PUBLISHED: "This video is already on Instagram.",
  PUBLISHING: "This video is being published right now.",
  LIVE_POST: "This video already has a post on its way.",
  RETRY_INSTEAD: "We're still checking whether your last post went live. Tap Check again first.",
  CHECK_NOT_NEEDED: "This post doesn't need checking.",
  CHECK_RECONNECT: "Please connect the Instagram account you approved this post for, then tap Check again.",
  VIDEO_CHANGED: "The video changed after you approved it. Please review and approve again.",
  ACCOUNT_CHANGED: "Your Instagram account changed. Please review and approve again.",
  NOT_CONNECTED: "Please connect your Instagram first.",
  TOKEN_EXPIRED: "Instagram needs reconnecting. Please connect again, then approve.",
  APPROVE_AGAIN: "Something changed since you approved this post. Please check it and approve it again.",
  NOT_RETRYABLE: "This post can't be tried again. Please approve it again.",
  SCHEDULE_MISSED: SCHEDULE_MESSAGES.MISSED_REFUSED,
  CANCEL_PUBLISHING: "This post is being published right now and can't be cancelled.",
  CANCEL_NOT_ALLOWED: "This post can't be cancelled.",
  ARCHIVED: "This project is archived.",
} as const;

// ---------- H2 body ----------

const ObjectIdString = z.string({ error: "must be text" }).regex(/^[0-9a-f]{24}$/, { error: "is not a valid id" });
const HASHTAG = /#[\p{L}\p{M}\p{N}_]+/gu;

/** Hashtags in a caption (Instagram allows at most 30). */
export function hashtagCount(caption: string): number {
  return caption.match(HASHTAG)?.length ?? 0;
}

/**
 * H2 body (API.md H2), strict. `caption` is cleaned like the caption box (H7: control and invisible
 * characters, NFC; not trimmed), then 1–2,200 characters (code points, not only spaces), ≤ 30
 * hashtags. F31: `mode: "scheduled"` needs `scheduledAt` (ISO-8601 with an offset); its window (now +
 * 10 min to now + 7 days) and 5-minute step are checked by approvePost (they depend on "now").
 */
export const CreatePostBodySchema = z
  .strictObject({
    mode: z.enum(["now", "scheduled"], { error: "must be now or scheduled" }),
    renderId: ObjectIdString,
    mp4Sha256: z.string({ error: "must be text" }).regex(/^sha256:[0-9a-f]{64}$/, { error: "must be sha256: and 64 hex characters" }),
    connectionId: ObjectIdString,
    caption: z.string({ error: "must be text" }).transform(cleanPostCaptionText),
    scheduledAt: z.string({ error: "must be a date and time" }).optional(),
    expectedStateVersion: z.number({ error: "must be a whole number" }).int({ error: "must be a whole number" }).min(1, { error: "must be at least 1" }),
  })
  .superRefine((body, ctx) => {
    if (body.mode === "scheduled" && body.scheduledAt === undefined) ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "is required for scheduled posts" });
    if (body.mode === "scheduled" && body.scheduledAt !== undefined && parseScheduledAt(body.scheduledAt) === null) {
      ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "must be a date and time with an offset, like 2026-11-28T19:00:00+05:30" });
    }
    if (body.mode === "now" && body.scheduledAt !== undefined) ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "is only for scheduled posts" });
    if (body.caption.trim() === "") ctx.addIssue({ code: "custom", path: ["caption"], message: "can't be empty" });
    if (postCaptionLength(body.caption) > POST_CAPTION_LIMITS.textMax) ctx.addIssue({ code: "custom", path: ["caption"], message: `must be at most ${POST_CAPTION_LIMITS.textMax.toLocaleString("en-IN")} characters` });
    if (hashtagCount(body.caption) > POST_CAPTION_LIMITS.instagramHashtagsMax) ctx.addIssue({ code: "custom", path: ["caption"], message: `must have at most ${POST_CAPTION_LIMITS.instagramHashtagsMax} hashtags` });
  });
export type CreatePostBody = z.output<typeof CreatePostBodySchema>;

// ---------- resources ----------

/** API.md §11.3 `Post` (+ `pollAfterMs`, additive: 2000 while it is being published). */
export type PostResource = {
  id: string;
  state: PostState;
  mode: PostMode;
  scheduledAt: string | null;
  permalink: string | null;
  projectId: string;
  renderId: string;
  connectionId: string;
  caption: string;
  jobId: string | null;
  approval: { id: string; renderId: string; mp4Sha256: string; connectionId: string; igUserId: string; captionHash: string; approvedBy: string; approvedAt: string };
  destination: { username: string; profilePictureUrl: string | null };
  igMediaId: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  pollAfterMs: number | null;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toPostResource(doc: PostDocument): PostResource {
  const a = doc.approval;
  return {
    id: doc._id.toHexString(),
    state: doc.state,
    mode: doc.mode,
    scheduledAt: iso(doc.scheduledAt),
    permalink: doc.permalink,
    projectId: doc.projectId.toHexString(),
    renderId: doc.renderId.toHexString(),
    connectionId: doc.connectionId.toHexString(),
    caption: doc.caption,
    jobId: doc.jobId ? doc.jobId.toHexString() : null,
    approval: {
      id: a.id.toHexString(),
      renderId: a.renderId.toHexString(),
      mp4Sha256: a.mp4Sha256,
      connectionId: a.connectionId.toHexString(),
      igUserId: a.igUserId,
      captionHash: a.captionHash,
      approvedBy: a.approvedBy.toHexString(),
      approvedAt: a.approvedAt.toISOString(),
    },
    destination: doc.destination,
    igMediaId: doc.igMediaId,
    attempts: doc.attempts,
    nextAttemptAt: iso(doc.nextAttemptAt),
    lastError: doc.lastError ? { code: doc.lastError.code, message: doc.lastError.message, at: doc.lastError.at.toISOString() } : null,
    publishedAt: iso(doc.publishedAt),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    pollAfterMs: doc.state === "publishing" || doc.state === "outcome_unknown" ? 2000 : null,
  };
}

const posts = (db: Db) => db.collection<PostDocument>(POSTS_COLLECTION);
const isHex = (id: string) => /^[0-9a-f]{24}$/.test(id);

/** H4: one post of this owner, or null (a malformed id, someone else's post and a missing one look the same). */
export async function getOwnedPost(db: Db, ownerId: string, postId: string): Promise<PostDocument | null> {
  if (!isHex(postId) || !isHex(ownerId)) return null;
  return posts(db).findOne({ _id: new ObjectId(postId), ownerId: new ObjectId(ownerId) });
}

/** H3: one page of a project's posts, newest first (`createdAt` desc, `_id` desc). Throws InvalidCursorError. */
export async function listProjectPosts(db: Db, project: Pick<ProjectDocument, "_id" | "ownerId">, page: { limit: number; cursor: string | null }): Promise<{ items: PostDocument[]; nextCursor: string | null }> {
  const filter: Record<string, unknown> = { ownerId: project.ownerId, projectId: project._id };
  if (page.cursor) {
    const { c, i } = decodeCursor(page.cursor, ["c", "i"]);
    const after = typeof c === "string" ? new Date(c) : null;
    if (!after || Number.isNaN(after.getTime()) || after.toISOString() !== c || typeof i !== "string" || !isHex(i)) throw new InvalidCursorError();
    filter.$or = [{ createdAt: { $lt: after } }, { createdAt: after, _id: { $lt: new ObjectId(i) } }];
  }
  const docs = await posts(db).find(filter).sort({ createdAt: -1, _id: -1 }).limit(page.limit + 1).toArray();
  const items = docs.slice(0, page.limit);
  const last = items[items.length - 1];
  return { items, nextCursor: docs.length > page.limit && last ? encodeCursor({ c: last.createdAt.toISOString(), i: last._id.toHexString() }) : null };
}

// ---------- the full re-check (API.md §9; also H6 and the job) ----------

export type RecheckResult =
  | { ok: true; project: ProjectDocument; render: RenderDocument; connection: InstagramConnectionDocument }
  | { ok: false; failure: "approval_stale" | "not_connected" | "token_expired"; reason: string };

/**
 * Is this post's approval still exactly what is on the project? The project is not archived, the
 * owner is `active`, the project's current render is the approved one (ready, same MP4 hash), its
 * current AND approved storyboard version are the ones that render was made from, the caption is
 * the approved one, and the connection is the approved one, `active`, token not expired, same
 * `igUserId`. The post's own state is checked by the caller (it is the real guard).
 */
export async function recheckPublishApproval(db: Db, post: PostDocument, now: Date, session?: ClientSession): Promise<RecheckResult> {
  const opts = session ? { session } : {};
  const stale = (reason: string): RecheckResult => ({ ok: false, failure: "approval_stale", reason });
  const project = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: post.projectId, ownerId: post.ownerId }, opts);
  if (!project || project.state === "archived") return stale("project_archived");
  const user = await db.collection<{ _id: ObjectId; status?: string }>(USER_COLLECTION).findOne({ _id: post.ownerId }, { ...opts, projection: { status: 1 } });
  if (!user || user.status !== "active") return stale("user_not_active");
  if (!project.currentRenderId?.equals(post.approval.renderId)) return stale("render_not_current");
  const render = await db.collection<RenderDocument>(RENDERS_COLLECTION).findOne({ _id: post.approval.renderId, ownerId: post.ownerId, projectId: post.projectId }, opts);
  if (!render || render.status !== "ready") return stale("render_not_current");
  if (render.mp4Sha256 !== post.approval.mp4Sha256) return stale("mp4_hash_mismatch");
  if (!project.currentPlanVersionId?.equals(render.planVersionId) || !project.approvedPlanVersionId?.equals(render.planVersionId)) return stale("storyboard_changed");
  if (captionHash(post.caption) !== post.approval.captionHash) return stale("caption_changed");
  const connection = await db.collection<InstagramConnectionDocument>(INSTAGRAM_CONNECTIONS_COLLECTION).findOne({ _id: post.approval.connectionId, ownerId: post.ownerId }, opts);
  if (!connection || connection.status === "revoked" || !connection.accessToken) return { ok: false, failure: "not_connected", reason: "not_connected" };
  if (connection.igUserId !== post.approval.igUserId) return stale("connection_changed");
  if (connection.status !== "active" || connection.tokenExpiresAt.getTime() <= now.getTime()) return { ok: false, failure: "token_expired", reason: "token_expired" };
  return { ok: true, project, render, connection };
}

/** A failed re-check as the H6 answer (API.md H6). */
function recheckRefusal(result: Extract<RecheckResult, { ok: false }>): ProjectActionError {
  if (result.failure === "not_connected") return new ProjectActionError("INSTAGRAM_NOT_CONNECTED", POST_MESSAGES.NOT_CONNECTED);
  if (result.failure === "token_expired") return new ProjectActionError("INSTAGRAM_TOKEN_EXPIRED", POST_MESSAGES.TOKEN_EXPIRED);
  return new ProjectActionError("APPROVAL_STALE", POST_MESSAGES.APPROVE_AGAIN, { reason: result.reason });
}

// ---------- the publish job ----------

export function publishJobKey(postId: ObjectId): string {
  return `pubjob:${postId.toHexString()}`;
}

function pendingStages(): JobStage[] {
  return PUBLISH_STAGES.map((name) => ({ name, status: "pending" as const, startedAt: null, endedAt: null, attempts: 0, error: null }));
}

const QUEUED_PROGRESS = { stage: "approve", percent: 0, message: PUBLISH_MESSAGES.QUEUED };

export function newPublishJob(input: { ownerId: ObjectId; projectId: ObjectId; postId: ObjectId; renderId: ObjectId; now: Date; scheduledAt?: Date | null }): JobDocument {
  const key = publishJobKey(input.postId);
  return {
    _id: new ObjectId(),
    ownerId: input.ownerId,
    projectId: input.projectId,
    schemaVersion: JOB_SCHEMA_VERSION,
    type: "publish",
    inputRef: { postId: input.postId, renderId: input.renderId },
    inputHash: input.postId.toHexString(),
    state: "queued",
    attempt: 1,
    stages: pendingStages(),
    // F31: a scheduled post's job waits (queued) until its time; the line says when.
    progress: input.scheduledAt ? { ...QUEUED_PROGRESS, message: `Scheduled for ${istDateTimeLabel(input.scheduledAt)}` } : QUEUED_PROGRESS,
    error: null,
    needsInput: null,
    result: { postId: input.postId },
    idempotencyKey: key,
    inngestRunId: null,
    cancelRequestedAt: null,
    event: { id: key, sentAt: null, lastTriedAt: null },
    planner: null,
    publish: null,
    queuedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
    startedAt: null,
    finishedAt: null,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

async function audit(db: Db, session: ClientSession, input: { actorId: ObjectId; action: string; postId: ObjectId; data: Record<string, unknown>; now: Date }): Promise<void> {
  await db.collection(AUDIT_LOGS_COLLECTION).insertOne({ schemaVersion: 1, actorId: input.actorId, action: input.action, subject: { type: "post", id: input.postId }, data: input.data, at: input.now }, { session });
}

// ---------- H2 ----------

export type ApprovePostResult = { post: PostDocument; job: JobDocument; project: ProjectDocument };

/**
 * H2 "Publish now" or "Schedule post" (approval #2; API.md H2, §9; DATABASE.md §7.2 row 9), ONE
 * transaction. F31: `mode: "scheduled"` first checks the time (now + 10 min to now + 7 days, on a
 * 5-minute step; 400 INVALID_INPUT at `scheduledAt`, nothing saved). Refusals,
 * in order: 404 · archived / published / publishing (409 INVALID_STATE) · a job running (409
 * JOB_ALREADY_RUNNING) · ANY post of the project whose publish may have gone out and isn't confirmed
 * (409 INVALID_STATE `retry_instead`: Check again first, whatever that post's state) · another tab
 * (409 STALE_VERSION) · not on the publish step (409) · a post already on its way (409) ·
 * the video isn't the current, ready one made from the approved storyboard (409 APPROVAL_STALE
 * render_not_current) · another MP4 (mp4_hash_mismatch) · no active Instagram connection (409
 * INSTAGRAM_NOT_CONNECTED) · another connection (APPROVAL_STALE connection_changed) · an expired
 * token (409 INSTAGRAM_TOKEN_EXPIRED). Then: the post (`publishing`, approval snapshot with a new id,
 * `publishKey`), its queued job, project → `publishing` (+1 stateVersion; the approved caption
 * becomes the caption box's text), a replaced failed post → `cancelled`, audit `post.approved`.
 * Scheduled (F31): the post is `scheduled` (attempts 0, `scheduledAt` in UTC), its job is queued and
 * sleeps until the time (the event is still sent at once), and the project → `scheduled` with NO
 * `activeJobId`: a change (D3/D4/D5/D7/F4/H7/G3/G4) stays allowed and cancels the approval at once.
 */
export async function approvePost(
  db: Db,
  input: {
    ownerId: string;
    projectId: string;
    body: CreatePostBody;
    idempotencyLock?: IdempotencyLock | null;
    respond: (out: ApprovePostResult) => { status: number; body: unknown };
    now?: Date;
  },
): Promise<ApprovePostResult> {
  const now = input.now ?? new Date();
  const { body } = input;
  if (!isHex(input.projectId) || !isHex(input.ownerId)) throw new ProjectActionError("NOT_FOUND", POST_MESSAGES.PROJECT_NOT_FOUND);
  const ownerId = new ObjectId(input.ownerId);
  const scheduled = body.mode === "scheduled";
  const scheduledAt = scheduled && body.scheduledAt !== undefined ? parseScheduledAt(body.scheduledAt) : null;
  if (scheduled) {
    // F31: the window and the 5-minute step (refused, never rounded: the creator approves exactly this time).
    const problem = scheduledAt ? scheduleProblem(scheduledAt, now) : SCHEDULE_MESSAGES.BAD_TIME;
    if (problem) {
      const from = new Date(now.getTime() + SCHEDULE_LIMITS.minLeadMs).toISOString();
      const to = new Date(now.getTime() + SCHEDULE_LIMITS.maxLeadMs).toISOString();
      throw new ProjectActionError("INVALID_INPUT", problem, { issues: [{ path: "scheduledAt", message: `must be between ${from} and ${to}, on a ${SCHEDULE_LIMITS.stepMinutes}-minute step` }] });
    }
  }
  const session = db.client.startSession();
  let result: ApprovePostResult | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const project = await projects.findOne({ _id: new ObjectId(input.projectId), ownerId }, { session });
      if (!project) throw new ProjectActionError("NOT_FOUND", POST_MESSAGES.PROJECT_NOT_FOUND);
      if (project.state === "archived") throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.ARCHIVED, { state: project.state });
      if (project.state === "published") throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.ALREADY_PUBLISHED, { state: project.state, reason: "already_published" });
      if (project.state === "publishing") throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.PUBLISHING, { state: project.state });
      if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.", { activeJobId: project.activeJobId.toHexString() });
      // Code review MUST 1: an earlier publish that may be live blocks EVERY new approval, whatever
      // that post's state (publish_failed, approval_invalidated, cancelled): "Check again" (H6) first.
      const unconfirmed = await findUnconfirmedPost(db, { ownerId, projectId: project._id }, session);
      if (unconfirmed && !LIVE_POST_STATES.includes(unconfirmed.state)) {
        throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.RETRY_INSTEAD, { reason: "retry_instead", postId: unconfirmed._id.toHexString() });
      }
      if (project.stateVersion !== body.expectedStateVersion) {
        throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.", { expectedStateVersion: body.expectedStateVersion, currentStateVersion: project.stateVersion });
      }
      if (project.state !== "video_ready" && project.state !== "publish_failed" && project.state !== "scheduled") {
        throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.NOT_READY, { state: project.state, reason: "video_not_ready" });
      }
      const latest = await latestPostOf(db, { ownerId, projectId: project._id }, session);
      if (latest && LIVE_POST_STATES.includes(latest.state)) throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.LIVE_POST, { postState: latest.state });

      const renderId = new ObjectId(body.renderId);
      const render = await db.collection<RenderDocument>(RENDERS_COLLECTION).findOne({ _id: renderId, ownerId, projectId: project._id }, { session });
      const current =
        render !== null &&
        project.currentRenderId?.equals(render._id) === true &&
        render.status === "ready" &&
        project.currentPlanVersionId?.equals(render.planVersionId) === true &&
        project.approvedPlanVersionId?.equals(render.planVersionId) === true;
      if (!current || !render) throw new ProjectActionError("APPROVAL_STALE", POST_MESSAGES.VIDEO_CHANGED, { reason: "render_not_current" });
      if (render.mp4Sha256 !== body.mp4Sha256) throw new ProjectActionError("APPROVAL_STALE", POST_MESSAGES.VIDEO_CHANGED, { reason: "mp4_hash_mismatch" });

      const connection = await db.collection<InstagramConnectionDocument>(INSTAGRAM_CONNECTIONS_COLLECTION).findOne({ ownerId }, { session });
      if (!connection || connection.status === "revoked" || !connection.accessToken) throw new ProjectActionError("INSTAGRAM_NOT_CONNECTED", POST_MESSAGES.NOT_CONNECTED);
      if (!connection._id.equals(new ObjectId(body.connectionId))) throw new ProjectActionError("APPROVAL_STALE", POST_MESSAGES.ACCOUNT_CHANGED, { reason: "connection_changed" });
      if (connection.status !== "active" || connection.tokenExpiresAt.getTime() <= now.getTime()) throw new ProjectActionError("INSTAGRAM_TOKEN_EXPIRED", POST_MESSAGES.TOKEN_EXPIRED);

      const postId = new ObjectId();
      const approvalId = new ObjectId();
      const job = newPublishJob({ ownerId, projectId: project._id, postId, renderId: render._id, now, scheduledAt });
      const post: PostDocument = {
        _id: postId,
        ownerId,
        projectId: project._id,
        schemaVersion: POST_SCHEMA_VERSION,
        renderId: render._id,
        connectionId: connection._id,
        caption: body.caption,
        mode: scheduled ? "scheduled" : "now",
        scheduledAt,
        approval: {
          id: approvalId,
          renderId: render._id,
          mp4Sha256: render.mp4Sha256,
          connectionId: connection._id,
          igUserId: connection.igUserId,
          captionHash: captionHash(body.caption),
          approvedBy: ownerId,
          approvedAt: now,
        },
        publishKey: publishKeyOf({ projectId: project._id, renderId: render._id, connectionId: connection._id, approvalId }),
        state: scheduled ? "scheduled" : "publishing",
        jobId: job._id,
        destination: { username: connection.username, profilePictureUrl: connection.profilePictureUrl },
        igContainerId: null,
        containerCreatedAt: null,
        containerStatus: null,
        igMediaId: null,
        permalink: null,
        publishAttemptedAt: null,
        // A scheduled post's first attempt starts when it wakes up (wakeScheduledPost adds it).
        attempts: scheduled ? 0 : 1,
        nextAttemptAt: null,
        lastError: null,
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      // A failed post that never sent `media_publish` is replaced by this new approval.
      if (latest && (latest.state === "publish_failed" || latest.state === "approval_invalidated")) {
        await posts(db).updateOne({ _id: latest._id, ownerId, state: latest.state }, { $set: { state: "cancelled", updatedAt: now } }, { session });
      }
      await posts(db).insertOne(post, { session });
      await db.collection<JobDocument>(JOBS_COLLECTION).insertOne(job, { session });
      const sameCaption = project.captionDraft?.text === body.caption;
      const moved = await projects.findOneAndUpdate(
        { _id: project._id, ownerId, stateVersion: project.stateVersion, activeJobId: null, state: project.state },
        {
          $set: {
            state: scheduled ? "scheduled" : "publishing",
            // F31: a sleeping scheduled job is NOT the project's active job (changes stay allowed).
            activeJobId: scheduled ? null : job._id,
            lastError: null,
            updatedAt: now,
            ...(sameCaption ? {} : { captionDraft: { text: body.caption, updatedAt: now, source: project.captionDraft?.source ?? "edited" } }),
          },
          $inc: { stateVersion: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!moved) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.", { expectedStateVersion: body.expectedStateVersion, currentStateVersion: project.stateVersion + 1 });
      await audit(db, session, { actorId: ownerId, action: "post.approved", postId, data: { projectId: project._id, renderId: render._id, igUserId: connection.igUserId, approvalId, mode: body.mode, scheduledAt }, now });
      result = { post, job, project: moved };
      if (input.idempotencyLock) {
        const answer = input.respond(result);
        await finishIdempotencyInTransaction(db, input.idempotencyLock, answer.status, answer.body, session);
      }
    });
  } catch (error) {
    // Two separate approvals at the same moment: the one-live-post index stops the second (the publish
    // key only keeps one post document per approval).
    if (isDuplicateKey(error)) throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.LIVE_POST, { reason: "live_post" });
    throw error;
  } finally {
    await session.endSession();
  }
  return result!;
}

// ---------- H6 ----------

export type RetryPostResult = { post: PostDocument; job: JobDocument; project: ProjectDocument };

/**
 * H6 "Try again" on a `publish_failed` post, ON ITS OWN APPROVAL (API.md H6; DATABASE.md §7.2 row
 * 11), ONE transaction: the post is still `publish_failed` (an `approval_invalidated` one → 409
 * APPROVAL_STALE: approve again with H2), no job running, the full re-check (§9). Then the same job
 * → `queued` (attempt + 1), post → `publishing` (attempts + 1; a container Instagram refused or that
 * is too old is dropped, a good one is reused), project → `publishing`, audit `post.retried`.
 * A post whose `media_publish` may have gone out keeps `publishAttemptedAt`: the job checks
 * Instagram first (reconcile), so Try again can never post twice.
 */
export async function retryPost(
  db: Db,
  input: { ownerId: string; postId: string; idempotencyLock?: IdempotencyLock | null; respond: (out: RetryPostResult) => { status: number; body: unknown }; now?: Date },
): Promise<RetryPostResult> {
  const now = input.now ?? new Date();
  if (!isHex(input.postId) || !isHex(input.ownerId)) throw new ProjectActionError("NOT_FOUND", POST_MESSAGES.POST_NOT_FOUND);
  const ownerId = new ObjectId(input.ownerId);
  const session = db.client.startSession();
  let result: RetryPostResult | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const post = await posts(db).findOne({ _id: new ObjectId(input.postId), ownerId }, { session });
      if (!post) throw new ProjectActionError("NOT_FOUND", POST_MESSAGES.POST_NOT_FOUND);
      if (post.state === "approval_invalidated") throw new ProjectActionError("APPROVAL_STALE", POST_MESSAGES.APPROVE_AGAIN, { reason: "approval_invalidated" });
      // F31: a missed schedule is never tried again on its old approval: Publish now or Schedule again (H2).
      if (post.state === "publish_failed" && post.lastError?.code === PUBLISH_FAILURES.missed.code) throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.SCHEDULE_MISSED, { reason: "schedule_missed" });
      if (post.state !== "publish_failed") throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.NOT_RETRYABLE, { postState: post.state });
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const project = await projects.findOne({ _id: post.projectId, ownerId }, { session });
      if (!project) throw new ProjectActionError("NOT_FOUND", POST_MESSAGES.POST_NOT_FOUND);
      if (project.state === "archived") throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.ARCHIVED, { state: project.state });
      if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.");
      if (project.state !== "publish_failed") throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.NOT_RETRYABLE, { state: project.state });
      const check = await recheckPublishApproval(db, post, now, session);
      if (!check.ok) throw recheckRefusal(check);
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = post.jobId ? await jobs.findOne({ _id: post.jobId, ownerId, type: "publish" }, { session }) : null;
      if (!job || (job.state !== "failed" && job.state !== "cancelled")) throw new ProjectActionError("INVALID_STATE", POST_MESSAGES.NOT_RETRYABLE, { jobState: job?.state ?? null });
      const attempt = job.attempt + 1;
      const updatedJob = await jobs.findOneAndUpdate(
        { _id: job._id, attempt: job.attempt, state: job.state },
        {
          $set: {
            state: "queued",
            attempt,
            stages: pendingStages(),
            progress: QUEUED_PROGRESS,
            error: null,
            needsInput: null,
            result: { postId: post._id },
            cancelRequestedAt: null,
            event: { id: retryEventId(job._id, attempt), sentAt: null, lastTriedAt: null },
            publish: null,
            queuedAt: now,
            startedAt: null,
            finishedAt: null,
            updatedAt: now,
          },
        },
        { session, returnDocument: "after" },
      );
      if (!updatedJob) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      const containerUsable =
        post.igContainerId !== null && post.containerStatus !== "ERROR" && post.containerStatus !== "EXPIRED" && post.containerCreatedAt !== null && now.getTime() - post.containerCreatedAt.getTime() < CONTAINER_REUSE_MS;
      const updatedPost = await posts(db).findOneAndUpdate(
        { _id: post._id, ownerId, state: "publish_failed" },
        {
          $set: {
            state: "publishing",
            lastError: null,
            nextAttemptAt: null,
            updatedAt: now,
            // A publish that may have gone out keeps its container: reconcile looks it up first.
            ...(containerUsable || post.publishAttemptedAt ? {} : { igContainerId: null, containerCreatedAt: null, containerStatus: null }),
          },
          $inc: { attempts: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!updatedPost) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      const moved = await projects.findOneAndUpdate(
        { _id: project._id, ownerId, stateVersion: project.stateVersion, activeJobId: null, state: "publish_failed" },
        { $set: { state: "publishing", activeJobId: job._id, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session, returnDocument: "after" },
      );
      if (!moved) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      await audit(db, session, { actorId: ownerId, action: "post.retried", postId: post._id, data: { projectId: project._id, attempt }, now });
      result = { post: updatedPost, job: updatedJob, project: moved };
      if (input.idempotencyLock) {
        const answer = input.respond(result);
        await finishIdempotencyInTransaction(db, input.idempotencyLock, answer.status, answer.body, session);
      }
    });
  } finally {
    await session.endSession();
  }
  return result!;
}

// ---------- the worker ----------

/** What the job's first step hands on (plain JSON: Inngest stores step results; no token, no link). */
export type PublishStart = { postId: string; deadline: string; publishSent: boolean };

/**
 * The run's first step: the job becomes `running` for this attempt, with its retry deadline (now +
 * ~10 min, kept for this attempt when the step runs again). Null when there is nothing to do: the job
 * finished, a newer attempt exists, or the post / project no longer wait for this job.
 */
export async function startPublishAttempt(db: Db, input: { jobId: string; attempt: number; runId?: string | null; now?: Date }): Promise<PublishStart | null> {
  const now = input.now ?? new Date();
  if (!isHex(input.jobId)) return null;
  const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
  const job = await jobs.findOne({ _id: new ObjectId(input.jobId), type: "publish" });
  if (!job || job.attempt !== input.attempt || (job.state !== "queued" && job.state !== "running") || !job.inputRef.postId) return null;
  const post = await posts(db).findOne({ _id: job.inputRef.postId, ownerId: job.ownerId, jobId: job._id, state: { $in: ["publishing", "outcome_unknown"] } });
  const project = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: job.projectId, ownerId: job.ownerId, activeJobId: job._id, state: "publishing" });
  if (!post || !project) return null;
  const deadline = job.publish?.attempt === input.attempt ? job.publish.deadline : new Date(now.getTime() + PUBLISH_RETRY_WINDOW_MS);
  const updated = await jobs.findOneAndUpdate(
    { _id: job._id, attempt: input.attempt, state: { $in: ["queued", "running"] } },
    {
      $set: {
        state: "running",
        startedAt: job.startedAt ?? now,
        publish: { attempt: input.attempt, deadline },
        stages: stagesFor(job.stages, "approve", now),
        progress: { stage: "approve", percent: 5, message: PUBLISH_MESSAGES.APPROVE },
        ...(input.runId ? { inngestRunId: input.runId } : {}),
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  return updated ? { postId: post._id.toHexString(), deadline: deadline.toISOString(), publishSent: post.publishAttemptedAt !== null && post.igMediaId === null } : null;
}

/** The stages with `stage` running and every stage before it succeeded (a `reconcile` stage is added when needed). */
function stagesFor(current: readonly JobStage[], stage: PublishStage, now: Date): JobStage[] {
  const list = current.some((s) => s.name === stage) ? [...current] : [...current, { name: stage, status: "pending" as const, startedAt: null, endedAt: null, attempts: 0, error: null }];
  const index = STAGE_ORDER.indexOf(stage);
  return list.map((s) => {
    const i = STAGE_ORDER.indexOf(s.name as PublishStage);
    if (s.name === stage) return s.status === "running" ? s : { ...s, status: "running" as const, startedAt: s.startedAt ?? now, attempts: s.attempts + 1, error: null };
    if (i < index && s.status !== "succeeded") return { ...s, status: "succeeded" as const, startedAt: s.startedAt ?? now, endedAt: now, attempts: Math.max(1, s.attempts) };
    return s;
  });
}

export type PublishContext = { job: JobDocument; post: PostDocument };

/** Read-only: the job (running THIS attempt) and its post (still being published), else null. */
export async function loadPublishContext(db: Db, input: { jobId: string; attempt: number }): Promise<PublishContext | null> {
  if (!isHex(input.jobId)) return null;
  const job = await db.collection<JobDocument>(JOBS_COLLECTION).findOne({ _id: new ObjectId(input.jobId), type: "publish", attempt: input.attempt, state: "running" });
  if (!job?.inputRef.postId) return null;
  const post = await posts(db).findOne({ _id: job.inputRef.postId, ownerId: job.ownerId, jobId: job._id, state: { $in: ["publishing", "outcome_unknown"] } });
  return post ? { job, post } : null;
}

/** Progress (also the stuck-job rule's heartbeat). False when the job no longer runs this attempt. */
export async function setPublishProgress(db: Db, input: { jobId: ObjectId; attempt: number; stage: PublishStage; percent: number; message: string; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
  const job = await jobs.findOne({ _id: input.jobId, attempt: input.attempt, state: "running" }, { projection: { stages: 1 } });
  if (!job) return false;
  const updated = await jobs.updateOne(
    { _id: input.jobId, attempt: input.attempt, state: "running" },
    { $set: { stages: stagesFor(job.stages, input.stage, now), progress: { stage: input.stage, percent: Math.max(0, Math.min(100, Math.round(input.percent))), message: input.message }, updatedAt: now } },
  );
  return updated.matchedCount === 1;
}

/** Saves the container Instagram made (or its new status), only while this post is still being published by this job. */
export async function savePublishContainer(
  db: Db,
  input: { postId: ObjectId; jobId: ObjectId; containerId?: string | null; status?: string | null; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const set: Record<string, unknown> = { updatedAt: now };
  if (input.containerId !== undefined) {
    set.igContainerId = input.containerId;
    set.containerCreatedAt = input.containerId ? now : null;
    set.containerStatus = null;
  }
  if (input.status !== undefined) set.containerStatus = input.status;
  const result = await posts(db).updateOne({ _id: input.postId, jobId: input.jobId, state: { $in: ["publishing", "outcome_unknown"] } }, { $set: set });
  return result.matchedCount === 1;
}

/**
 * Claim the ONE `media_publish` call, right before it is sent: only while this job runs this attempt
 * and the post is `publishing` with no earlier claim. False → don't send (another run sent it, or a
 * reconcile must look first).
 */
export async function claimPublishCall(db: Db, input: { postId: ObjectId; jobId: ObjectId; attempt: number; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let claimed = false;
  try {
    await session.withTransaction(async () => {
      claimed = false;
      const job = await db.collection<JobDocument>(JOBS_COLLECTION).findOne({ _id: input.jobId, attempt: input.attempt, state: "running" }, { session, projection: { _id: 1 } });
      if (!job) return;
      const result = await posts(db).updateOne(
        { _id: input.postId, jobId: input.jobId, state: "publishing", publishAttemptedAt: null, igMediaId: null },
        // `firstPublishAttemptedAt` keeps the FIRST send (reconcile's time window starts there). An
        // update PIPELINE with $ifNull: it fills the field when it is missing OR null (final review MUST
        // 1: `$min` leaves an explicit null as it is, because null ranks below every date).
        // `lastPublishSentAt`: every send (Check again's 30-minute rule), kept when the claim is released.
        [{ $set: { publishAttemptedAt: now, lastPublishSentAt: now, updatedAt: now, firstPublishAttemptedAt: { $ifNull: ["$firstPublishAttemptedAt", now] } } }],
        { session },
      );
      claimed = result.modifiedCount === 1;
    });
  } finally {
    await session.endSession();
  }
  return claimed;
}

/** `media_publish` got no clear answer: the post is `outcome_unknown` until a reconcile has looked. */
export async function markOutcomeUnknown(db: Db, input: { postId: ObjectId; jobId: ObjectId; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await posts(db).updateOne({ _id: input.postId, jobId: input.jobId, state: { $in: ["publishing", "outcome_unknown"] } }, { $set: { state: "outcome_unknown", updatedAt: now } });
  return result.matchedCount === 1;
}

/**
 * The claim is released, so the same container may be published again (Instagram publishes a
 * container only once): reconcile proved the reel is not live yet, or Instagram clearly refused the send.
 * `firstPublishAttemptedAt` is KEPT (an earlier send whose answer was lost may still go live), except
 * when `refused` and this was the FIRST send (`publishAttemptedAt` = `firstPublishAttemptedAt`): then
 * nothing ever went out and the post is no longer "unconfirmed" (re-review MUST 1).
 */
export async function releasePublishClaim(db: Db, input: { postId: ObjectId; jobId: ObjectId; refused?: boolean; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const filter = { _id: input.postId, jobId: input.jobId, state: { $in: ["publishing", "outcome_unknown"] as PostState[] }, igMediaId: null };
  if (input.refused) {
    const current = await posts(db).findOne(filter, { projection: { publishAttemptedAt: 1, firstPublishAttemptedAt: 1 } });
    const sent = current?.publishAttemptedAt ?? null;
    if (sent && current?.firstPublishAttemptedAt && sent.getTime() === current.firstPublishAttemptedAt.getTime()) {
      // Conditional on both times still being this send: a concurrent new claim can't be cleared.
      const first = await posts(db).updateOne(
        { ...filter, publishAttemptedAt: sent, firstPublishAttemptedAt: sent },
        // $unset (not null): the "ever sent" marks are gone, and the next claim sets them again.
        { $set: { state: "publishing", publishAttemptedAt: null, updatedAt: now }, $unset: { firstPublishAttemptedAt: "", lastPublishSentAt: "" } },
      );
      if (first.matchedCount === 1) return true;
    }
  }
  const result = await posts(db).updateOne(filter, { $set: { state: "publishing", publishAttemptedAt: null, updatedAt: now } });
  return result.matchedCount === 1;
}

/** One line in `publishAttempts` (DATABASE.md §4.23): never a token, a link or Instagram's own text. */
export type PublishAttemptLog = {
  postId: ObjectId;
  ownerId: ObjectId;
  jobAttempt: number;
  step: "create_container" | "poll" | "publish" | "reconcile" | "permalink";
  request: Record<string, string | number | boolean | null>;
  response: Record<string, string | number | boolean | null>;
  outcome: string;
};

export async function logPublishAttempt(db: Db, entry: PublishAttemptLog, now: Date = new Date()): Promise<void> {
  await db.collection(PUBLISH_ATTEMPTS_COLLECTION).insertOne({ schemaVersion: 1, ...entry, at: now });
}

/**
 * The reel is live, ONE transaction (DATABASE.md §7.2 row 18): post → `published` (media id,
 * permalink, publishedAt; both null only when a reconcile saw the container PUBLISHED but couldn't
 * find the media in the account's list), job → `succeeded`, project → `published` (activeJobId cleared, +1
 * stateVersion), notification `post_published`, audit `post.published`. False when the job no
 * longer runs this attempt.
 */
export async function completePublishJob(db: Db, input: { jobId: ObjectId; attempt: number; mediaId: string | null; permalink: string | null; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let saved = false;
  try {
    await session.withTransaction(async () => {
      saved = false;
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = await jobs.findOne({ _id: input.jobId, attempt: input.attempt, state: "running", type: "publish" }, { session });
      if (!job?.inputRef.postId) return;
      const post = await posts(db).findOneAndUpdate(
        { _id: job.inputRef.postId, jobId: job._id, state: { $in: ["publishing", "outcome_unknown"] } },
        { $set: { state: "published", igMediaId: input.mediaId, permalink: input.permalink, publishedAt: now, lastError: null, nextAttemptAt: null, updatedAt: now } },
        { session, returnDocument: "after" },
      );
      if (!post) return;
      const project = await db
        .collection<ProjectDocument>(PROJECTS_COLLECTION)
        .findOneAndUpdate({ _id: job.projectId, activeJobId: job._id }, { $set: { state: "published", activeJobId: null, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } }, { session, returnDocument: "after" });
      await jobs.updateOne(
        { _id: job._id, attempt: input.attempt, state: "running" },
        {
          $set: {
            state: "succeeded",
            stages: job.stages.map((s) => (s.status === "pending" && s.name === "reconcile" ? s : { ...s, status: "succeeded" as const, startedAt: s.startedAt ?? now, endedAt: s.endedAt ?? now, attempts: Math.max(1, s.attempts), error: null })),
            progress: { stage: "publish", percent: 100, message: PUBLISH_MESSAGES.DONE },
            error: null,
            result: { postId: post._id },
            finishedAt: now,
            updatedAt: now,
          },
        },
        { session },
      );
      const words = POST_NOTIFICATIONS.post_published(project?.title ?? "Your video", post.destination.username);
      await insertNotifications(db, session, [newNotification({ ownerId: job.ownerId, type: "post_published", projectId: job.projectId, postId: post._id, ...words, now })]);
      await audit(db, session, { actorId: job.ownerId, action: "post.published", postId: post._id, data: { projectId: job.projectId, igMediaId: input.mediaId, igUserId: post.approval.igUserId }, now });
      saved = true;
    });
  } finally {
    await session.endSession();
  }
  return saved;
}

/**
 * The publish job fails, ONE transaction: job `failed` (the plain reason; `retryable` → Try again),
 * post → `publish_failed` with `lastError` (kept `publishAttemptedAt` means: reconcile before any new
 * publish), project → `publish_failed` (activeJobId cleared, +1 stateVersion), notification
 * `post_failed`. Only while the job is queued/running (this attempt; for the stuck-job rule: not
 * updated since `staleBefore` / queued since `queuedBefore`). `stage`: where it stopped.
 */
export async function endPublishJob(
  db: Db,
  input: { jobId: ObjectId; attempt?: number; failure: PublishFailure; stage?: PublishStage; staleBefore?: Date; queuedBefore?: Date; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const { code, message, retryable } = PUBLISH_FAILURES[input.failure];
  const session = db.client.startSession();
  let ended = false;
  try {
    await session.withTransaction(async () => {
      ended = false;
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = await jobs.findOne(
        {
          _id: input.jobId,
          type: "publish",
          state: { $in: ["queued", "running"] },
          ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
          ...(input.staleBefore ? { updatedAt: { $lt: input.staleBefore } } : {}),
          ...(input.queuedBefore ? { state: "queued" as const, queuedAt: { $lt: input.queuedBefore } } : {}),
        },
        { session },
      );
      if (!job) return;
      const stageName = input.stage ?? (job.stages.find((s) => s.status === "running")?.name as PublishStage | undefined) ?? "approve";
      // Code review SHOULD 3: the stage error and lastError are the fixed plain line. Technical detail
      // goes only to the server log and publishAttempts (never env names, never Meta's own text).
      const stageError = { code, message };
      await jobs.updateOne(
        { _id: job._id, attempt: job.attempt, state: job.state },
        {
          $set: {
            state: "failed",
            stages: job.stages.map((s) => (s.name === stageName ? { ...s, status: "failed" as const, startedAt: s.startedAt ?? now, endedAt: now, error: stageError } : s)),
            progress: { ...job.progress, message },
            error: { code, message, retryable },
            finishedAt: now,
            updatedAt: now,
          },
        },
        { session },
      );
      const post = job.inputRef.postId
        ? await posts(db).findOneAndUpdate(
            { _id: job.inputRef.postId, jobId: job._id, state: { $in: ["publishing", "outcome_unknown"] } },
            { $set: { state: "publish_failed", lastError: { code, message, at: now }, updatedAt: now } },
            { session, returnDocument: "after" },
          )
        : null;
      const project = await db
        .collection<ProjectDocument>(PROJECTS_COLLECTION)
        .findOneAndUpdate({ _id: job.projectId, activeJobId: job._id }, { $set: { state: "publish_failed", activeJobId: null, lastError: { code, message, at: now }, updatedAt: now }, $inc: { stateVersion: 1 } }, { session, returnDocument: "after" });
      if (post) {
        const words = POST_NOTIFICATIONS.post_failed(project?.title ?? "Your video");
        await insertNotifications(db, session, [newNotification({ ownerId: job.ownerId, type: "post_failed", projectId: job.projectId, postId: post._id, ...words, now })]);
      }
      ended = true;
    });
  } finally {
    await session.endSession();
  }
  return ended;
}

// ---------- reading Instagram for an unconfirmed post (reconcile and "Check again") ----------

/**
 * Code review SHOULD 4: reconcile only READS Instagram, so it needs a working token for the account
 * the post was approved for (`approval.igUserId`), not the full approval re-check (which still guards
 * create_container and media_publish). Null when there is none (disconnected, expired, another account).
 */
export async function findReaderConnection(db: Db, post: Pick<PostDocument, "ownerId" | "approval">, now: Date = new Date()): Promise<InstagramConnectionDocument | null> {
  return db.collection<InstagramConnectionDocument>(INSTAGRAM_CONNECTIONS_COLLECTION).findOne({
    ownerId: post.ownerId,
    igUserId: post.approval.igUserId,
    status: "active",
    accessToken: { $exists: true },
    tokenExpiresAt: { $gt: now },
  });
}

/**
 * H6's mode for this post (code review MUST 1). `check`: the post is unconfirmed (its publish may be
 * live) and can't simply be tried again — it is `approval_invalidated` / `cancelled`, or `publish_failed`
 * with an approval that no longer matches — so H6 ONLY looks at Instagram ("Check again"): it never
 * creates a container or calls media_publish. `retry`: the normal Try again (a valid `publish_failed`
 * post; its job reconciles first when a publish may have gone out).
 */
export async function postRetryMode(db: Db, post: PostDocument, now: Date = new Date()): Promise<"check" | "retry"> {
  if (!isCheckablePost(post)) return "retry";
  if (post.state !== "publish_failed") return "check";
  const recheck = await recheckPublishApproval(db, post, now);
  return !recheck.ok && recheck.failure === "approval_stale" ? "check" : "retry";
}

const CHECKABLE_FILTER = (post: { _id: ObjectId; ownerId: ObjectId }) => ({
  _id: post._id,
  ownerId: post.ownerId,
  firstPublishAttemptedAt: { $ne: null },
  igMediaId: null,
  state: { $in: [...CHECKABLE_POST_STATES] },
});

/** Who settled an unconfirmed post: the creator's "Check again" (H6) or the founder's ops command. */
export type CheckVia = "check_again" | "ops_cli";

export type CheckedPost = { post: PostDocument; project: ProjectDocument | null };

/**
 * "Check again" found the reel live, ONE transaction: post → `published` (media id and permalink,
 * both null when Instagram said PUBLISHED but the media wasn't in the list), notification
 * `post_published`, audit `post.published` (`via`). The project → `published` (+1 stateVersion) only
 * while its current video is still the one approved (`currentRenderId` = `approval.renderId`) and it
 * isn't archived; otherwise only the post is saved (re-review SHOULD 5: a newer video stays publishable).
 * Refused (409 JOB_ALREADY_RUNNING, nothing saved) while another job runs on the project: the flag stays
 * and blocks new approvals until it is saved. Null when the post is no longer unconfirmed.
 */
export async function confirmCheckedPost(
  db: Db,
  input: { ownerId: string; postId: string; mediaId: string | null; permalink: string | null; via?: CheckVia; now?: Date },
): Promise<CheckedPost | null> {
  const now = input.now ?? new Date();
  if (!isHex(input.ownerId) || !isHex(input.postId)) return null;
  const ids = { _id: new ObjectId(input.postId), ownerId: new ObjectId(input.ownerId) };
  const session = db.client.startSession();
  let result: CheckedPost | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const current = await posts(db).findOne(CHECKABLE_FILTER(ids), { session });
      if (!current) return;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const project = await projects.findOne({ _id: current.projectId, ownerId: ids.ownerId }, { session });
      if (project?.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step. Please tap Check again in a minute.");
      const post = await posts(db).findOneAndUpdate(
        CHECKABLE_FILTER(ids),
        { $set: { state: "published", igMediaId: input.mediaId, permalink: input.permalink, publishedAt: now, lastError: null, nextAttemptAt: null, updatedAt: now } },
        { session, returnDocument: "after" },
      );
      if (!post) return;
      const sameVideo = project !== null && project.state !== "archived" && project.currentRenderId?.equals(post.approval.renderId) === true;
      const moved = sameVideo && project
        ? await projects.findOneAndUpdate(
            { _id: project._id, ownerId: ids.ownerId, activeJobId: null, stateVersion: project.stateVersion, currentRenderId: post.approval.renderId },
            { $set: { state: "published", lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
            { session, returnDocument: "after" },
          )
        : project;
      if (sameVideo && !moved) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      const words = POST_NOTIFICATIONS.post_published(project?.title ?? "Your video", post.destination.username);
      await insertNotifications(db, session, [newNotification({ ownerId: ids.ownerId, type: "post_published", projectId: post.projectId, postId: post._id, ...words, now })]);
      await audit(db, session, {
        actorId: ids.ownerId,
        action: "post.published",
        postId: post._id,
        data: { projectId: post.projectId, igMediaId: input.mediaId, igUserId: post.approval.igUserId, via: input.via ?? "check_again", projectPublished: sameVideo },
        now,
      });
      result = { post, project: moved };
    });
  } finally {
    await session.endSession();
  }
  return result;
}

/**
 * "Check again" proved the reel was NOT posted (the container never reached PUBLISHED and the media is
 * not in the account's recent list): the unconfirmed flags (`publishAttemptedAt`,
 * `firstPublishAttemptedAt`) are cleared, ONE transaction with audit `post.not_posted` (`via`). The post
 * keeps its state: a valid `publish_failed` post can be tried again, any other lets the creator approve
 * again (H2). Null when the post is no longer unconfirmed.
 */
export async function clearCheckedPost(db: Db, input: { ownerId: string; postId: string; via?: CheckVia; now?: Date }): Promise<PostDocument | null> {
  const now = input.now ?? new Date();
  if (!isHex(input.ownerId) || !isHex(input.postId)) return null;
  const ids = { _id: new ObjectId(input.postId), ownerId: new ObjectId(input.ownerId) };
  const session = db.client.startSession();
  let result: PostDocument | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      // $unset (not null), so a later Try again's claim sets the "ever sent" marks again (final review MUST 1).
      const post = await posts(db).findOneAndUpdate(
        CHECKABLE_FILTER(ids),
        { $set: { publishAttemptedAt: null, updatedAt: now }, $unset: { firstPublishAttemptedAt: "", lastPublishSentAt: "" } },
        { session, returnDocument: "after" },
      );
      if (!post) return;
      await audit(db, session, { actorId: ids.ownerId, action: "post.not_posted", postId: post._id, data: { projectId: post.projectId, igUserId: post.approval.igUserId, via: input.via ?? "check_again" }, now });
      result = post;
    });
  } finally {
    await session.endSession();
  }
  return result;
}
