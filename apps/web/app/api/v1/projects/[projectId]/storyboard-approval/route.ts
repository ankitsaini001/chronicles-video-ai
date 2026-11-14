import { API_RATE_LIMITS, approveStoryboard, IdempotencyLockLostError, StoryboardApprovalBodySchema, toProjectResource, toStoryboardApprovalResource } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem, ApiResult } from "@/lib/api/v1";
import { toApiProblem } from "@/lib/plan/api";

// D8 POST /api/v1/projects/{projectId}/storyboard-approval (docs/API.md D8, §9; F20): approval #1,
// "Approve & generate video". The creator approves the EXACT version on screen: body (strict)
// `planVersionId`, `planHash` (both from the version shown), `expectedStateVersion`.
// Idempotency-Key required. Rate: 10 per hour. ONE transaction
// (packages/db/src/storyboard-approvals.ts approveStoryboard): the checks (current version, same
// hash, valid, no job, stateVersion), the approval (+ audit entry) and the project's
// `approvedPlanVersionId`.
// AS BUILT IN F20: no video job and no videos/day count yet; they arrive with F23. The answer is
// 200 { approval, job: null, project } (project still `storyboard_ready`). F23 turns this into the
// documented 202 with the queued generate job.
// Errors: 404 · 409 STALE_VERSION · 409 APPROVAL_STALE · 422 PLAN_INVALID · 409 INVALID_STATE ·
// 409 JOB_ALREADY_RUNNING.

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.approvePerUser,
    body: StoryboardApprovalBodySchema,
    idempotent: true,
    handle: async ({ db, user, body, idempotencyLock }) => {
      const answer = (out: Awaited<ReturnType<typeof approveStoryboard>>) => ({
        approval: toStoryboardApprovalResource(out.approval),
        job: null,
        project: toProjectResource(out.project),
      });
      try {
        const out = await approveStoryboard(db, { ownerId: user.id, projectId, body, idempotencyLock, respond: (o) => ({ status: 200, body: answer(o) }) });
        return new ApiResult(200, answer(out));
      } catch (error) {
        if (error instanceof IdempotencyLockLostError) throw new ApiProblem(409, "IDEMPOTENCY_IN_PROGRESS", API_MESSAGES.IDEMPOTENCY_IN_PROGRESS);
        return toApiProblem(error);
      }
    },
  })(request);
}
