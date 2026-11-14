import { API_RATE_LIMITS, EditIdeaBodySchema, editProjectIdea, getLatestPlanJob, toProjectResource } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { toApiProblem } from "@/lib/plan/api";

// C4 PATCH /api/v1/projects/{projectId} (docs/API.md C4), F15 part: "Edit idea" after a failed
// storyboard. Body (strict): `text` (same length rules as C2 for the project's input type), optional
// `title`, `expectedStateVersion`. Only in `plan_failed` with no job running; one conditional
// update (packages/db/src/projects.ts editProjectIdea). Doesn't count toward 5 projects/day; the Try
// again that follows (E2) counts 1 toward the project's 20 storyboard requests.
// Rename alone (`title` without `text`) arrives with F21; until then `text` is required.
// Owner only: someone else's project, a missing one and a malformed id all get 404.

export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.editProjectPerUser,
    body: EditIdeaBodySchema,
    handle: async ({ db, user, body }) => {
      try {
        const project = await editProjectIdea(db, { ownerId: user.id, projectId, body });
        return toProjectResource(project, { latestPlanJob: await getLatestPlanJob(db, project._id) });
      } catch (error) {
        return toApiProblem(error);
      }
    },
  })(request);
}
