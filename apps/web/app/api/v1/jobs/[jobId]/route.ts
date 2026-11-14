import { API_RATE_LIMITS, getOwnedJob, isTerminal, toJobResource } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { ApiProblem } from "@/lib/api/v1";
import { refreshJob } from "@/lib/plan/jobs";

// E1 GET /api/v1/jobs/{jobId} (docs/API.md E1): one job's status (API.md §8.2). Owner only: someone
// else's job, a missing one and a malformed id all get 404. An active job gets the stuck-job rule
// first (like C6). Rate: 120 per minute (shared with C6).

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.pollPerUser,
    handle: async ({ db, user }) => {
      const job = await getOwnedJob(db, user.id, jobId);
      if (!job) throw new ApiProblem(404, "NOT_FOUND", "We couldn't find this job.");
      return toJobResource(isTerminal(job.state) ? job : await refreshJob(db, job));
    },
  })(request);
}
