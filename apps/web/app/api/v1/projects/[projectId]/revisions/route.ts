import {
  API_RATE_LIMITS,
  getOwnedProject,
  IdempotencyLockLostError,
  InvalidCursorError,
  listRevisions,
  requestRevision,
  RevisionBodySchema,
  toJobResource,
  toRevisionResource,
} from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem, ApiResult } from "@/lib/api/v1";
import { assertPlanJobsReady, toApiProblem } from "@/lib/plan/api";
import { sendPlanEvent } from "@/lib/plan/jobs";
import { pageQuery } from "@/lib/storyboard/api";

// D5 POST /api/v1/projects/{projectId}/revisions (docs/API.md D5, F18): "Ask for changes" on the
// storyboard, for the whole storyboard or one scene (message 3–500 characters).
// Pipeline: Origin → session → 20 per hour → strict body → Idempotency-Key → here. Then:
//   1. the AI planner and Inngest must be set up (else 500, nothing saved);
//   2. ONE transaction (packages/db/src/revisions.ts requestRevision): checks (no job running, the
//      stateVersion and base version the browser saw, the scene exists, under the 20 AI requests:
//      else 429 QUOTA_EXCEEDED), the revision (`pending`), its queued `revise` job, the project's
//      activeJobId, and the saved answer for the Idempotency-Key;
//   3. AFTER the commit, `revision.requested` goes to Inngest (lost → sent again by the stuck-job rule).
// The request counts 1 of the 20 when its job really asks Gemini (like F15's Try again).
// Answer: 202 { revision, job }. The page polls C6 every 2 s.
//
// D6 GET (docs/API.md D6): the change history, newest first. Query: `stage`, `limit`, `cursor`.

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.revisionPerUser,
    body: RevisionBodySchema,
    idempotent: true,
    handle: async ({ db, user, body, idempotencyLock }) => {
      assertPlanJobsReady();
      let created;
      try {
        created = await requestRevision(db, {
          ownerId: user.id,
          projectId,
          body,
          idempotencyLock,
          respond: ({ revision, job }) => ({ status: 202, body: { revision: toRevisionResource(revision), job: toJobResource(job) } }),
        });
      } catch (error) {
        if (error instanceof IdempotencyLockLostError) throw new ApiProblem(409, "IDEMPOTENCY_IN_PROGRESS", API_MESSAGES.IDEMPOTENCY_IN_PROGRESS);
        return toApiProblem(error);
      }
      await sendPlanEvent(db, created.job);
      return new ApiResult(202, { revision: toRevisionResource(created.revision), job: toJobResource(created.job) });
    },
  })(request);
}

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.readsPerUser,
    handle: async ({ db, user }) => {
      const url = new URL(request.url);
      const page = pageQuery(url, ["stage"]);
      const stage = url.searchParams.get("stage");
      if (stage !== null && stage !== "storyboard" && stage !== "video") {
        throw new ApiProblem(400, "INVALID_INPUT", API_MESSAGES.INVALID_INPUT, { issues: [{ path: "stage", message: "must be one of storyboard, video" }] });
      }
      const project = await getOwnedProject(db, user.id, projectId);
      if (!project) throw new ApiProblem(404, "NOT_FOUND", "We couldn't find this project.");
      try {
        return await listRevisions(db, project, { ...page, stage });
      } catch (error) {
        if (error instanceof InvalidCursorError) throw new ApiProblem(400, "INVALID_INPUT", error.message, { issues: [{ path: "cursor", message: "invalid cursor" }] });
        throw error;
      }
    },
  })(request);
}
