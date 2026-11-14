import { API_RATE_LIMITS, loadPlanVersionResource, saveUserEditVersion, VoiceSwitchBodySchema } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { toApiProblem } from "@/lib/plan/api";
import { buildPlanVersion, voiceChange } from "@/lib/storyboard/edit-plan";

// D4 POST /api/v1/projects/{projectId}/voice (docs/API.md D4, F19): Male ↔ Female on the storyboard.
// A NEW `user_edit` version whose only change is the voice preset (for the project's own language),
// and the project's voiceGender. No AI call; doesn't count toward the 20. Same checks and ONE
// transaction as D3 (packages/db/src/storyboard-edits.ts): the approval is cleared.
// Body (strict): basePlanVersionId, voiceGender (must differ: else 400), expectedStateVersion.
// Answer: 201 PlanVersion + Location. Rate: 60 per minute (shared with D3, D7 and C4).

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.editProjectPerUser,
    body: VoiceSwitchBodySchema,
    handle: async ({ db, user, body }) => {
      try {
        const { version, project } = await saveUserEditVersion(db, {
          ownerId: user.id,
          projectId,
          basePlanVersionId: body.basePlanVersionId,
          expectedStateVersion: body.expectedStateVersion,
          voiceGender: body.voiceGender,
          build: (base, ids) => buildPlanVersion(base, ids, voiceChange(body.voiceGender)),
        });
        const resource = await loadPlanVersionResource(db, project, version);
        return Response.json(resource, { status: 201, headers: { Location: `/api/v1/projects/${projectId}/plan-versions/${resource.id}` } });
      } catch (error) {
        return toApiProblem(error);
      }
    },
  })(request);
}
