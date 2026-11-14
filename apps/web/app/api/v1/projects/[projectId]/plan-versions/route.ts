import { API_RATE_LIMITS, getOwnedProject, InvalidCursorError, listPlanVersions } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { ApiProblem } from "@/lib/api/v1";
import { pageQuery } from "@/lib/storyboard/api";

// D1 GET /api/v1/projects/{projectId}/plan-versions (docs/API.md D1, F17): the version history for
// the "Version N ▾" menu and Undo, newest first (`versionNumber` desc). Query: `limit` 1–50 (20),
// `cursor` (from `nextCursor`). Owner only (404). Rate: the shared 300 reads per minute.

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.readsPerUser,
    handle: async ({ db, user }) => {
      const page = pageQuery(new URL(request.url));
      const project = await getOwnedProject(db, user.id, projectId);
      if (!project) throw new ApiProblem(404, "NOT_FOUND", "We couldn't find this project.");
      try {
        return await listPlanVersions(db, project, page);
      } catch (error) {
        if (error instanceof InvalidCursorError) throw new ApiProblem(400, "INVALID_INPUT", error.message, { issues: [{ path: "cursor", message: "invalid cursor" }] });
        throw error;
      }
    },
  })(request);
}
