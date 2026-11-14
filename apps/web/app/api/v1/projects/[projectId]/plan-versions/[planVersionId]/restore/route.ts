import { API_RATE_LIMITS, restorePlanVersion, RestoreBodySchema, toProjectResource } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { toApiProblem } from "@/lib/plan/api";

// D7 POST /api/v1/projects/{projectId}/plan-versions/{planVersionId}/restore (docs/API.md D7, F17):
// Undo (the UI passes the current version's parent) or restore any older version. No new version,
// nothing deleted, no AI call. ONE transaction (packages/db/src/storyboard-edits.ts): that version
// becomes current; if that exact version was approved before, its approval counts again, else the
// project needs a new approval; the project's voice follows the restored plan; +1 stateVersion.
// Body (strict): expectedStateVersion. Errors: 404 · 409 STALE_VERSION · 409 INVALID_STATE
// (already current) · 409 JOB_ALREADY_RUNNING. Answer: 200 Project. Rate: 60 per minute (shared).

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; planVersionId: string }> }): Promise<Response> {
  const { projectId, planVersionId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.editProjectPerUser,
    body: RestoreBodySchema,
    handle: async ({ db, user, body }) => {
      try {
        const project = await restorePlanVersion(db, { ownerId: user.id, projectId, planVersionId, expectedStateVersion: body.expectedStateVersion });
        return toProjectResource(project);
      } catch (error) {
        return toApiProblem(error);
      }
    },
  })(request);
}
