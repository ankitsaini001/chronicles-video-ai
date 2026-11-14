import { API_RATE_LIMITS, archiveProject, editProjectIdea, getLatestPlanJob, parseIfMatch, renameProject, toProjectResource, UpdateProjectBodySchema } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem } from "@/lib/api/v1";
import { toApiProblem, toProjectResourceOf } from "@/lib/plan/api";
import { loadProjectWithJobs } from "@/lib/plan/jobs";

// C3 GET /api/v1/projects/{projectId} (docs/API.md C3, F16): the project with its active job
// (stuck-job rule applied first, like C6) and what the creator may do now (`allowedActions`).
// Header ETag: "<stateVersion>". Rate: the shared 300 reads per minute. Owner only (404 otherwise).
// Archived projects still answer (state `archived`, read-only: allowedActions []).
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

// C4 PATCH /api/v1/projects/{projectId} (docs/API.md C4). Body (strict), `expectedStateVersion`
// always required:
// - `title` alone = rename (F21): 1–120 characters after cleaning (one line). Any state except
//   archived, not while a job runs. Counts toward no limit.
// - `text` (optionally with `title`) = edit the idea after a failed storyboard (F15): only in
//   `plan_failed` with no job running. Doesn't count toward 5 projects/day; the Try again that
//   follows (E2) counts 1 toward the project's 20 storyboard requests when it asks Gemini.
// One conditional update each. Rate: 60 per minute (shared with D3, D4, D7, C5).
// Owner only: someone else's project, a missing one and a malformed id all get 404.
export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.editProjectPerUser,
    body: UpdateProjectBodySchema,
    handle: async ({ db, user, body }) => {
      try {
        const project =
          body.text !== undefined
            ? await editProjectIdea(db, { ownerId: user.id, projectId, body: { text: body.text, title: body.title, expectedStateVersion: body.expectedStateVersion } })
            : await renameProject(db, { ownerId: user.id, projectId, title: body.title!, expectedStateVersion: body.expectedStateVersion });
        return toProjectResource(project, { latestPlanJob: await getLatestPlanJob(db, project._id) });
      } catch (error) {
        return toApiProblem(error);
      }
    },
  })(request);
}

// C5 DELETE /api/v1/projects/{projectId} (docs/API.md C5, F21): archive (soft delete). Header
// `If-Match: "<stateVersion>"` required (no body). The project leaves My videos; nothing is deleted
// and its pages still open by direct link, read-only. Refused while a job runs (409
// JOB_ALREADY_RUNNING) or a post is publishing (409 INVALID_STATE); already archived → 409
// INVALID_STATE. Answer: the Project (state `archived`). Rate: 60 per minute (shared with C4).
export async function DELETE(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.editProjectPerUser,
    handle: async ({ db, user }) => {
      const expectedStateVersion = parseIfMatch(request.headers.get("if-match"));
      if (expectedStateVersion === null) {
        throw new ApiProblem(400, "INVALID_INPUT", API_MESSAGES.INVALID_REQUEST, { issues: [{ path: "headers.If-Match", message: 'must be "<stateVersion>", e.g. "9"' }] });
      }
      try {
        const project = await archiveProject(db, { ownerId: user.id, projectId, expectedStateVersion });
        return toProjectResource(project, { latestPlanJob: await getLatestPlanJob(db, project._id) });
      } catch (error) {
        return toApiProblem(error);
      }
    },
  })(request);
}
