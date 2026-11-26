import { API_RATE_LIMITS, getJob, getOwnedPost, isTerminal, toPostResource } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { ApiProblem } from "@/lib/api/v1";
import { refreshJob, refreshScheduledPost } from "@/lib/plan/jobs";

// H4 GET /api/v1/posts/{postId} (docs/API.md H4; F30): one post's status for polling while it is
// being published (`pollAfterMs` 2000 while `publishing` / `outcome_unknown`, else null). Owner only:
// someone else's post, a missing one and a malformed id all get 404. While the post is on its way its
// publish job gets the stuck-job rule first (like C6). F31: a scheduled post's waiting job too (more than
// 1 hour past its time → missed). Rate: 120 per minute (shared with C6, E1).

export async function GET(request: Request, { params }: { params: Promise<{ postId: string }> }): Promise<Response> {
  const { postId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.pollPerUser,
    handle: async ({ db, user }) => {
      let post = await getOwnedPost(db, user.id, postId);
      if (!post) throw new ApiProblem(404, "NOT_FOUND", "We couldn't find this post.");
      if ((post.state === "publishing" || post.state === "outcome_unknown") && post.jobId) {
        const job = await getJob(db, post.jobId);
        if (job && !isTerminal(job.state)) {
          const fresh = await refreshJob(db, job);
          if (fresh.state !== job.state) post = (await getOwnedPost(db, user.id, postId)) ?? post;
        }
      }
      if (post.state === "scheduled" && (await refreshScheduledPost(db, post))) post = (await getOwnedPost(db, user.id, postId)) ?? post;
      return toPostResource(post);
    },
  })(request);
}
