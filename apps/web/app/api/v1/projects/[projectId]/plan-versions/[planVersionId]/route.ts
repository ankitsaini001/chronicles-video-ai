import { API_RATE_LIMITS, getCurrentPlanVersion, getOwnedProject, getProjectPlanVersion, loadPlanVersionResource } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { ApiProblem } from "@/lib/api/v1";

// D2 GET /api/v1/projects/{projectId}/plan-versions/{planVersionId} (docs/API.md D2, F16): the full
// storyboard of one version (`current` = the project's current one) with its validation, approval
// and `changedSceneIds` (scenes that differ from the parent version, for the "Changed" tag).
// Owner only: someone else's project or version, a missing one and a malformed id all get 404.
// A project without a storyboard yet: 404 with `details.reason: "no_plan_yet"`.
// Rate: the shared 300 reads per minute.

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; planVersionId: string }> }): Promise<Response> {
  const { projectId, planVersionId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.readsPerUser,
    handle: async ({ db, user }) => {
      const project = await getOwnedProject(db, user.id, projectId);
      if (!project) throw new ApiProblem(404, "NOT_FOUND", "We couldn't find this project.");
      if (planVersionId === "current" && !project.currentPlanVersionId) {
        throw new ApiProblem(404, "NOT_FOUND", "The storyboard isn't ready yet.", { reason: "no_plan_yet" });
      }
      const version = planVersionId === "current" ? await getCurrentPlanVersion(db, project) : await getProjectPlanVersion(db, project, planVersionId);
      if (!version) throw new ApiProblem(404, "NOT_FOUND", "We couldn't find this storyboard version.");
      return loadPlanVersionResource(db, project, version);
    },
  })(request);
}
