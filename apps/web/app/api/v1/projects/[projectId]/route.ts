import { API_RATE_LIMITS, EditIdeaBodySchema, editProjectIdea, getLatestPlanJob, toProjectResource } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { ApiProblem } from "@/lib/api/v1";
import { toApiProblem, toProjectResourceOf } from "@/lib/plan/api";
import { loadProjectWithJobs } from "@/lib/plan/jobs";

// C3 GET /api/v1/projects/{projectId} (docs/API.md C3, F16): the project with its active job
// (stuck-job rule applied first, like C6) and what the creator may do now (`allowedActions`).
// Header ETag: "<stateVersion>". Rate: the shared 300 reads per minute. Owner only (404 otherwise).
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.readsPerUser,
    handle: async ({ db, user }) => {
      const loaded = await loadProjectWithJobs(db, user.id, projectId);
      if (!loaded) throw new ApiProblem(404, "NOT_FOUND", "We couldn't find this project.");
      return Response.json(toProjectResourceOf(loaded), { headers: { ETag: `"${loaded.project.stateVersion}"` } });
    },
  })(request);
}

// C4 PATCH /api/v1/projects/{projectId} (docs/API.md C4), F15 part: "Edit idea" after a failed
// storyboard. Body (strict): `text` (same length rules as C2 for the project's input type), optional
// `title`, `expectedStateVersion`. Only in `plan_failed` with no job running; one conditional
// update (packages/db/src/projects.ts editProjectIdea). Doesn't count toward 5 projects/day; the Try
// again that follows (E2) counts 1 toward the project's 20 storyboard requests when it asks Gemini.
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
