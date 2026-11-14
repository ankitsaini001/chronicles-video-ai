import { API_RATE_LIMITS, restorePlanVersion, RestoreBodySchema, toProjectResource } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { toApiProblem, toProjectResourceOf } from "@/lib/plan/api";
import { loadProjectWithJobs } from "@/lib/plan/jobs";

// D7 POST /api/v1/projects/{projectId}/plan-versions/{planVersionId}/restore (docs/API.md D7, F17):
// Undo (the UI passes the current version's parent) or restore any older version. No new version,
// nothing deleted, no AI call. ONE transaction (packages/db/src/storyboard-edits.ts): that version
// becomes current; if that exact version was approved before, its approval counts again, else the
// project needs a new approval; the project's voice follows the restored plan; +1 stateVersion.
// Body (strict): expectedStateVersion. Errors: 404 · 409 STALE_VERSION · 409 INVALID_STATE
// (already current) · 409 JOB_ALREADY_RUNNING. Answer: 200 Project (as C3, with its jobs). Rate: 60 per minute (shared).

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; planVersionId: string }> }): Promise<Response> {
  const { projectId, planVersionId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.editProjectPerUser,
    body: RestoreBodySchema,
    handle: async ({ db, user, body }) => {
      try {
        const project = await restorePlanVersion(db, { ownerId: user.id, projectId, planVersionId, expectedStateVersion: body.expectedStateVersion });
        // The same Project as C3 (with its jobs), so `allowedActions` match (e.g. retry_job).
        const loaded = await loadProjectWithJobs(db, user.id, projectId);
        return loaded ? toProjectResourceOf(loaded) : toProjectResource(project);
      } catch (error) {
        return toApiProblem(error);
      }
    },
  })(request);
}
