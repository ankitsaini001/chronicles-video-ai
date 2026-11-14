import { API_RATE_LIMITS, loadPlanVersionResource, NarrationEditBodySchema, saveUserEditVersion } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { toApiProblem } from "@/lib/plan/api";
import { buildPlanVersion, narrationChange } from "@/lib/storyboard/edit-plan";

// D3 POST /api/v1/projects/{projectId}/narration-edits (docs/API.md D3, F17): save one inline
// narration edit as a NEW `user_edit` storyboard version. No AI call; doesn't count toward the 20.
// Body (strict): basePlanVersionId (must be the current version), sceneId, narrationId, text
// (1–300 after cleaning), optional speech/display (omitted = keep, null = clear), expectedStateVersion.
// ONE transaction (packages/db/src/storyboard-edits.ts): the new version (checked by the same plan
// validator as the AI's plans; saved even when it fails, then it can't be approved), the project
// points at it, approval cleared, +1 stateVersion. Another tab changed it → 409 STALE_VERSION.
// Answer: 201 PlanVersion + Location. Rate: 60 per minute (shared with D4, D7 and C4).

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.editProjectPerUser,
    body: NarrationEditBodySchema,
    handle: async ({ db, user, body }) => {
      try {
        const { version, project } = await saveUserEditVersion(db, {
          ownerId: user.id,
          projectId,
          basePlanVersionId: body.basePlanVersionId,
          expectedStateVersion: body.expectedStateVersion,
          build: (base, ids) => buildPlanVersion(base, ids, narrationChange(body)),
        });
        const resource = await loadPlanVersionResource(db, project, version);
        return Response.json(resource, { status: 201, headers: { Location: `/api/v1/projects/${projectId}/plan-versions/${resource.id}` } });
      } catch (error) {
        return toApiProblem(error);
      }
    },
  })(request);
}
