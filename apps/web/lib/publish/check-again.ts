import type { CheckedPost, InstagramConnectionDocument, PostDocument, PublishAttemptLog } from "@bytereel/db";
import { InstagramPublishError, type InstagramPublisher, type RecentMedia } from "../instagram/publish-client";
import { findPublishedMedia, type PublisherSetup } from "./run-publish-job";

// "Check again" (H6 in its reconcile-only mode; F30 code review MUST 1). For a post whose media_publish
// was sent but never confirmed, and that can't simply be tried again (its approval was cancelled by a
// change, the project was archived, or the approval no longer matches), H6 ONLY reads Instagram:
//   - the container's status_code and the account's recent media (the same matcher as the job's
//     reconcile: the same caption, posted at or after the first media_publish minus ~60 s);
//   - found, or the container is PUBLISHED → the post is saved as published (project published);
//   - the recent media list was read and doesn't have it, AND the container is ERROR / EXPIRED (any
//     time), or FINISHED (or gone) with the latest send at least 30 minutes old (re-review MUST 2: right
//     after a send Instagram may still be publishing a FINISHED container) → proven NOT posted: the
//     unconfirmed flags are cleared, the creator may approve again;
//   - anything else (Instagram busy, no clear answer) → nothing changes, "check again later".
// It NEVER creates a container and NEVER calls media_publish. It uses any working token of the account
// the post was approved for (`approval.igUserId`). Kept free of the database and Inngest: the route
// passes them in, so the tests run it with fakes.

export type CheckAgainOutcome = "published" | "not_posted" | "unknown";

export const CHECK_AGAIN_MESSAGES = {
  published: "Your reel is live on Instagram.",
  not_posted: "Your reel wasn't posted. You can approve it and publish it again.",
  unknown: "Instagram hasn't confirmed yet. Please check again in a few minutes.",
} as const satisfies Record<CheckAgainOutcome, string>;

/** A FINISHED (never PUBLISHED) container proves "not posted" only this long after the latest send. */
export const FINISHED_PROOF_AFTER_MS = 30 * 60_000;

export interface CheckAgainDeps {
  /** A working connection for `approval.igUserId` (findReaderConnection), or null. */
  reader(post: PostDocument): Promise<InstagramConnectionDocument | null>;
  publisher(): PublisherSetup;
  /** The connection's token in plain text. Throws when it can't be read. */
  token(connection: InstagramConnectionDocument): string;
  /** Saves the post as published (confirmCheckedPost); null when it is no longer unconfirmed. */
  confirm(input: { mediaId: string | null; permalink: string | null }): Promise<CheckedPost | null>;
  /** Clears the unconfirmed flag (clearCheckedPost); null when it is no longer unconfirmed. */
  clear(): Promise<PostDocument | null>;
  log(entry: PublishAttemptLog): Promise<void>;
  logLine?(message: string): void;
  now?: () => Date;
}

export type CheckAgainResult =
  | { outcome: "published"; post: PostDocument }
  | { outcome: "not_posted"; post: PostDocument }
  | { outcome: "unknown"; post: PostDocument }
  /** No working token for the approved account: reconnect it first. */
  | { outcome: "not_connected" }
  /** Instagram isn't set up on the server (500). */
  | { outcome: "not_set_up" }
  /** The post was checked or published meanwhile. */
  | { outcome: "changed" };

/** Statuses that prove at once that Instagram never published this container. */
const NEVER_PUBLISHED = ["ERROR", "EXPIRED"];

export async function checkPostAgain(post: PostDocument, deps: CheckAgainDeps): Promise<CheckAgainResult> {
  const reader = await deps.reader(post);
  if (!reader) return { outcome: "not_connected" };
  const setup = deps.publisher();
  if (!setup.ok) {
    deps.logLine?.(`Check again for post ${post._id.toHexString()}: Instagram is not set up.`);
    return { outcome: "not_set_up" };
  }
  let token: string;
  try {
    token = deps.token(reader);
  } catch {
    return { outcome: "not_connected" };
  }
  const api: InstagramPublisher = setup.publisher;
  const errorFields = (error: InstagramPublishError) => ({ kind: error.kind, status: error.status, code: error.code, subcode: error.subcode });

  let statusCode: string | null = null;
  let statusRead = post.igContainerId === null;
  let statusError: Record<string, string | number | null> | null = null;
  if (post.igContainerId) {
    try {
      statusCode = (await api.containerStatus({ containerId: post.igContainerId, accessToken: token })).statusCode;
      statusRead = true;
    } catch (error) {
      if (!(error instanceof InstagramPublishError)) throw error;
      statusError = errorFields(error);
    }
  }
  let media: RecentMedia[] | null = null;
  try {
    media = await api.recentMedia({ igUserId: post.approval.igUserId, accessToken: token });
  } catch (error) {
    if (!(error instanceof InstagramPublishError)) throw error;
    statusError ??= errorFields(error);
  }

  const match = findPublishedMedia(post, media, statusCode);
  const live = match !== undefined || statusCode === "PUBLISHED";
  const latestSend = post.publishAttemptedAt ?? post.firstPublishAttemptedAt ?? post.updatedAt;
  const sendIsOld = (deps.now?.() ?? new Date()).getTime() - latestSend.getTime() >= FINISHED_PROOF_AFTER_MS;
  const notPosted = !live && media !== null && statusRead && ((statusCode !== null && NEVER_PUBLISHED.includes(statusCode)) || ((statusCode === null || statusCode === "FINISHED") && sendIsOld));
  const outcome: CheckAgainOutcome = live ? "published" : notPosted ? "not_posted" : "unknown";
  await deps
    .log({
      postId: post._id,
      ownerId: post.ownerId,
      jobAttempt: 0, // 0 = "Check again" (not a job attempt)
      step: "reconcile",
      request: { containerId: post.igContainerId, via: "check_again" },
      response: { statusCode, recentMedia: media?.length ?? null, matched: match !== undefined, ...(statusError ?? {}) },
      outcome,
    })
    .catch(() => deps.logLine?.(`Check again for post ${post._id.toHexString()}: couldn't log the attempt.`));

  if (outcome === "published") {
    const saved = await deps.confirm({ mediaId: match?.id ?? null, permalink: match?.permalink ?? null });
    return saved ? { outcome: "published", post: saved.post } : { outcome: "changed" };
  }
  if (outcome === "not_posted") {
    const cleared = await deps.clear();
    return cleared ? { outcome: "not_posted", post: cleared } : { outcome: "changed" };
  }
  return { outcome: "unknown", post };
}
