import {
  API_RATE_LIMITS,
  clearCheckedPost,
  confirmCheckedPost,
  findReaderConnection,
  getOwnedPost,
  IdempotencyLockLostError,
  logPublishAttempt,
  POST_MESSAGES,
  postRetryMode,
  retryPost,
  toJobResource,
  toPostResource,
  type RetryPostResult,
} from "@bytereel/db";
import { z } from "zod";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem, ApiResult } from "@/lib/api/v1";
import { instagramPublisherFromEnv } from "@/lib/instagram/provider";
import { toApiProblem } from "@/lib/plan/api";
import { sendPlanEvent } from "@/lib/plan/jobs";
import { assertPublishReady } from "@/lib/publish/api";
import { CHECK_AGAIN_MESSAGES, checkPostAgain } from "@/lib/publish/check-again";
import { connectionToken } from "@/lib/publish/token";

// H6 POST /api/v1/posts/{postId}/retry (docs/API.md H6; F30): "Try again" on a failed post, and
// "Check again" on a post whose publish may have gone out. Idempotency-Key required. Body `{}`.
// Rate: 10 per hour (`publish`, shared with H2).
// Two modes (packages/db/src/posts.ts postRetryMode; F30 code review MUST 1):
// - Try again (a `publish_failed` post whose approval still matches): the full approval re-check
//   (API.md §9) in the transaction: anything changed → 409 APPROVAL_STALE; no active connection → 409
//   INSTAGRAM_NOT_CONNECTED; expired token → 409 INSTAGRAM_TOKEN_EXPIRED. The same publish job
//   → `queued` (attempt + 1), post and project → `publishing`; a publish that may already have gone
//   out is looked up on Instagram first (reconcile). AFTER the commit the event
//   `{jobId}:retry:{attempt}`. Answer 202 { post, job }.
// - Check again (an unconfirmed post that is `approval_invalidated` / `cancelled`, or `publish_failed`
//   with an approval that no longer matches): ONLY reads Instagram (lib/publish/check-again.ts) with a
//   working token of the approved account; NEVER a container or media_publish. Answer 200
//   { outcome: published | not_posted | unknown, message, post }. No working token for that account →
//   409 INSTAGRAM_NOT_CONNECTED (reconnect it, then Check again).

const EmptyBody = z.strictObject({});

export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }): Promise<Response> {
  const { postId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.publishPerUser,
    body: EmptyBody,
    idempotent: true,
    handle: async ({ db, user, idempotencyLock }) => {
      assertPublishReady();
      const owned = await getOwnedPost(db, user.id, postId);
      if (owned && (await postRetryMode(db, owned)) === "check") {
        let checked;
        try {
          checked = await checkPostAgain(owned, {
            reader: (post) => findReaderConnection(db, post),
            publisher: () => {
              const setup = instagramPublisherFromEnv(db, process.env);
              return setup.ok ? { ok: true, publisher: setup.publisher } : { ok: false, problems: setup.problems };
            },
            token: connectionToken,
            confirm: (input) => confirmCheckedPost(db, { ownerId: user.id, postId, ...input }),
            clear: () => clearCheckedPost(db, { ownerId: user.id, postId }),
            log: (entry) => logPublishAttempt(db, entry),
            logLine: (message) => console.warn(message),
          });
        } catch (error) {
          return toApiProblem(error);
        }
        if (checked.outcome === "not_connected") throw new ApiProblem(409, "INSTAGRAM_NOT_CONNECTED", POST_MESSAGES.CHECK_RECONNECT, { reason: "check_needs_account" });
        if (checked.outcome === "not_set_up") throw new Error("Instagram publishing is not set up on the server.");
        if (checked.outcome === "changed") throw new ApiProblem(409, "INVALID_STATE", POST_MESSAGES.CHECK_NOT_NEEDED, { reason: "already_checked" });
        return new ApiResult(200, { outcome: checked.outcome, message: CHECK_AGAIN_MESSAGES[checked.outcome], post: toPostResource(checked.post) });
      }
      const answer = (out: RetryPostResult) => ({ post: toPostResource(out.post), job: toJobResource(out.job) });
      let out: RetryPostResult;
      try {
        out = await retryPost(db, { ownerId: user.id, postId, idempotencyLock, respond: (o) => ({ status: 202, body: answer(o) }) });
      } catch (error) {
        if (error instanceof IdempotencyLockLostError) throw new ApiProblem(409, "IDEMPOTENCY_IN_PROGRESS", API_MESSAGES.IDEMPOTENCY_IN_PROGRESS);
        return toApiProblem(error);
      }
      await sendPlanEvent(db, out.job);
      return new ApiResult(202, answer(out));
    },
  })(request);
}
