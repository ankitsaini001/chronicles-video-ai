import { API_RATE_LIMITS, IdempotencyLockLostError, retryPost, toJobResource, toPostResource, type RetryPostResult } from "@bytereel/db";
import { z } from "zod";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem, ApiResult } from "@/lib/api/v1";
import { toApiProblem } from "@/lib/plan/api";
import { sendPlanEvent } from "@/lib/plan/jobs";
import { assertPublishReady } from "@/lib/publish/api";

// H6 POST /api/v1/posts/{postId}/retry (docs/API.md H6; F30): "Try again" on a `publish_failed` post,
// on its OWN approval. Idempotency-Key required. Body `{}`. Rate: 10 per hour (`publish`, shared with
// H2). The full approval re-check (API.md §9) runs in the transaction: anything changed → 409
// APPROVAL_STALE (approve again with H2); an `approval_invalidated` post → 409 APPROVAL_STALE too;
// no active connection → 409 INSTAGRAM_NOT_CONNECTED; expired token → 409 INSTAGRAM_TOKEN_EXPIRED.
// Effect (packages/db/src/posts.ts retryPost): the same publish job back to `queued` (attempt + 1),
// post and project → `publishing`. A publish that may already have gone out is looked up on Instagram
// first (reconcile), so Try again never posts twice. AFTER the commit the event
// `{jobId}:retry:{attempt}`. Answer 202 { post, job }.

const EmptyBody = z.strictObject({});

export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }): Promise<Response> {
  const { postId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.publishPerUser,
    body: EmptyBody,
    idempotent: true,
    handle: async ({ db, user, idempotencyLock }) => {
      assertPublishReady();
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
