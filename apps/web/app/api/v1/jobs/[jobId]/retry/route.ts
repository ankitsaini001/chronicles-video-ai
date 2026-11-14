import { API_RATE_LIMITS, getOwnedJob, IdempotencyLockLostError, retryPlanJob, retryReviseJob, toJobResource } from "@bytereel/db";
import { z } from "zod";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem, ApiResult } from "@/lib/api/v1";
import { assertPlanJobsReady, toApiProblem } from "@/lib/plan/api";
import { sendPlanEvent } from "@/lib/plan/jobs";

// E2 POST /api/v1/jobs/{jobId}/retry (docs/API.md E2): the "Try again" button after a failed
// storyboard. Idempotency-Key required; body `{}`. Rate: 30 per hour.
// Allowed for a failed plan job whose error is retryable, or whose idea was edited since (C4).
// ONE transaction (packages/db/src/plan-jobs.ts retryPlanJob): the same job back to `queued` with
// attempt + 1 (planning from the CURRENT idea), project → `planning`. Refused with 429
// QUOTA_EXCEEDED plan_requests_per_project when the project already used its 20 storyboard requests;
// the attempt counts 1 toward them only when it really sends a request to Gemini (a reused saved
// answer costs nothing). Never counts toward 5 projects/day.
// F18: a failed `revise` job (a storyboard change request) is retried the same way
// (packages/db/src/revisions.ts retryReviseJob): only while the storyboard is still the version the
// request was made on; the project keeps its state, only `activeJobId` is set.
// After the commit the event `{jobId}:retry:{attempt}` goes to Inngest. Answer: 202 Job.

const EmptyBody = z.strictObject({});

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.jobActionsPerUser,
    body: EmptyBody,
    idempotent: true,
    handle: async ({ db, user, idempotencyLock }) => {
      assertPlanJobsReady();
      let job;
      try {
        const respond = (j: Parameters<typeof toJobResource>[0]) => ({ status: 202, body: toJobResource(j) });
        const owned = await getOwnedJob(db, user.id, jobId);
        job =
          owned?.type === "revise"
            ? await retryReviseJob(db, { ownerId: user.id, jobId, idempotencyLock, respond })
            : await retryPlanJob(db, { ownerId: user.id, jobId, idempotencyLock, respond });
      } catch (error) {
        // Like C2: a repeat of the same click took the Idempotency-Key over; nothing was saved here.
        if (error instanceof IdempotencyLockLostError) throw new ApiProblem(409, "IDEMPOTENCY_IN_PROGRESS", API_MESSAGES.IDEMPOTENCY_IN_PROGRESS);
        return toApiProblem(error);
      }
      await sendPlanEvent(db, job);
      return new ApiResult(202, toJobResource(job));
    },
  })(request);
}
