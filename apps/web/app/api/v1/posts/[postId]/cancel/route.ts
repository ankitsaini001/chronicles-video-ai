import { API_RATE_LIMITS, cancelScheduledPost, toPostResource, type CancelPostResult } from "@bytereel/db";
import { z } from "zod";
import { apiRoute } from "@/lib/api/server";
import { toApiProblem } from "@/lib/plan/api";
import { sendJobCancelled } from "@/lib/plan/jobs";

// H5 POST /api/v1/posts/{postId}/cancel (docs/API.md H5; F31): "Cancel schedule". Body `{}` (strict).
// Origin + session + owner checks (another user's post, a missing one and a bad id → 404). Rate: 10 per
// hour (`publish`, shared with H2 and H6). ONE transaction (packages/db/src/scheduled-posts.ts
// cancelScheduledPost): a `scheduled` or `approval_invalidated` post → `cancelled`, its waiting job →
// `cancelled`, the project → `video_ready`, audit `post.cancelled`. Already cancelled → 200 with the post
// (nothing changes). Being published (`publishing` / `outcome_unknown`) or done → 409 INVALID_STATE.
// AFTER the commit: `job.cancelled`, which stops the job's sleeping run (only tidiness: the wake step
// never posts a post that isn't `scheduled`). "Change time" on the page is this cancel + a new approval.
// Answer 200 → Post.

const EmptyBody = z.strictObject({});

export async function POST(request: Request, { params }: { params: Promise<{ postId: string }> }): Promise<Response> {
  const { postId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.publishPerUser,
    body: EmptyBody,
    handle: async ({ db, user }) => {
      let out: CancelPostResult;
      try {
        out = await cancelScheduledPost(db, { ownerId: user.id, postId });
      } catch (error) {
        return toApiProblem(error);
      }
      if (out.cancelledJobId) await sendJobCancelled(out.cancelledJobId.toHexString());
      return toPostResource(out.post);
    },
  })(request);
}
