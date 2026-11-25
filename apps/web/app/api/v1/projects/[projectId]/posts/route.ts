import {
  API_RATE_LIMITS,
  approvePost,
  CreatePostBodySchema,
  getOwnedProject,
  IdempotencyLockLostError,
  InvalidCursorError,
  listProjectPosts,
  toJobResource,
  toPostResource,
  toProjectResource,
  type ApprovePostResult,
} from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem, ApiResult } from "@/lib/api/v1";
import { toApiProblem } from "@/lib/plan/api";
import { sendPlanEvent } from "@/lib/plan/jobs";
import { assertPublishReady } from "@/lib/publish/api";
import { pageQuery } from "@/lib/storyboard/api";

// H2 POST /api/v1/projects/{projectId}/posts (docs/API.md H2, §9; F30): "Publish now", approval #2.
// The creator approves the EXACT video (renderId + mp4Sha256), the Instagram account (connectionId)
// and the caption they see. Idempotency-Key required (a double click replays the first answer).
// Rate: 10 per hour (`publish`, shared with H6). Body (strict): mode "now" ("scheduled" → 400 until
// F31), renderId, mp4Sha256, connectionId, caption (1–2,200 characters, ≤ 30 hashtags),
// expectedStateVersion. Order: Inngest, token keys and R2 set up (else 500, nothing saved) → ONE
// transaction (packages/db/src/posts.ts approvePost: every check, the post with its approval
// snapshot and publishKey, the queued publish job, project → publishing, audit post.approved, the
// answer on the Idempotency-Key record) → AFTER the commit `post.publish.requested`.
// Answer 202 { post, job, project }.
//
// H3 GET /api/v1/projects/{projectId}/posts: the project's posts, newest first (`limit`, `cursor`).
// Owner only (404). Rate: the shared 300 reads per minute.

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.publishPerUser,
    body: CreatePostBodySchema,
    idempotent: true,
    handle: async ({ db, user, body, idempotencyLock }) => {
      assertPublishReady();
      const answer = (out: ApprovePostResult) => ({
        post: toPostResource(out.post),
        job: toJobResource(out.job),
        // `activeJob` stays null in `project`: the full job is returned next to it (like D8).
        project: toProjectResource(out.project, { activeJob: out.job, embedActiveJob: false, latestPost: out.post }),
      });
      let out: ApprovePostResult;
      try {
        out = await approvePost(db, { ownerId: user.id, projectId, body, idempotencyLock, respond: (o) => ({ status: 202, body: answer(o) }) });
      } catch (error) {
        if (error instanceof IdempotencyLockLostError) throw new ApiProblem(409, "IDEMPOTENCY_IN_PROGRESS", API_MESSAGES.IDEMPOTENCY_IN_PROGRESS);
        return toApiProblem(error);
      }
      // After the commit (never inside the transaction). A lost send is sent again by the stuck-job rule.
      await sendPlanEvent(db, out.job);
      return new ApiResult(202, answer(out));
    },
  })(request);
}

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.readsPerUser,
    handle: async ({ db, user }) => {
      const page = pageQuery(new URL(request.url));
      const project = await getOwnedProject(db, user.id, projectId);
      if (!project) throw new ApiProblem(404, "NOT_FOUND", "We couldn't find this project.");
      try {
        const { items, nextCursor } = await listProjectPosts(db, project, page);
        return { items: items.map(toPostResource), nextCursor };
      } catch (error) {
        if (error instanceof InvalidCursorError) throw new ApiProblem(400, "INVALID_INPUT", "The list cursor is invalid. Reload the list.", { issues: [{ path: "cursor", message: "invalid cursor" }] });
        throw error;
      }
    },
  })(request);
}
