import { API_RATE_LIMITS } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { ApiProblem } from "@/lib/api/v1";
import { toProjectStatus } from "@/lib/plan/api";
import { loadProjectWithJobs } from "@/lib/plan/jobs";

// C6 GET /api/v1/projects/{projectId}/status (docs/API.md C6): the one call the project page polls
// every 2 s while `pollAfterMs` is not null. Applies the stuck-job rule on the way (a job that died
// or never started becomes failed and retryable; a lost start event is sent again).
// Rate: 120 per minute (shared with E1). Header ETag: "<stateVersion>". If-None-Match/304 is not
// supported yet: every poll gets the full (small) answer.

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.pollPerUser,
    handle: async ({ db, user }) => {
      const loaded = await loadProjectWithJobs(db, user.id, projectId);
      if (!loaded) throw new ApiProblem(404, "NOT_FOUND", "We couldn't find this project.");
      return Response.json(toProjectStatus(loaded), { headers: { ETag: `"${loaded.project.stateVersion}"` } });
    },
  })(request);
}
