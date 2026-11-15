import { API_RATE_LIMITS, cancelGenerateJob, toJobResource } from "@bytereel/db";
import { z } from "zod";
import { apiRoute } from "@/lib/api/server";
import { ApiResult } from "@/lib/api/v1";
import { toApiProblem } from "@/lib/plan/api";

// E3 POST /api/v1/jobs/{jobId}/cancel (docs/API.md E3; F23: video jobs). Body `{}`. Rate: 30 per hour
// (shared with E2). A video job still waiting for its turn is cancelled at once; a running one gets
// `cancelRequestedAt` and stops before its next step (or within seconds while rendering). The project
// goes back to the storyboard with its approval kept ("Generate video" starts the same job again).
// Calling it again is harmless. Answer: 202 Job (poll C6 / E1 until it is `cancelled`).
// Errors: 404 · 409 INVALID_STATE (already finished; storyboard jobs can't be cancelled yet).

const EmptyBody = z.strictObject({});

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.jobActionsPerUser,
    body: EmptyBody,
    handle: async ({ db, user }) => {
      try {
        return new ApiResult(202, toJobResource(await cancelGenerateJob(db, { ownerId: user.id, jobId })));
      } catch (error) {
        return toApiProblem(error);
      }
    },
  })(request);
}
