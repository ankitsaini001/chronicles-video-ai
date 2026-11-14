import {
  API_RATE_LIMITS,
  CREATE_PROJECT_STATUS,
  createProject,
  CreateProjectBodySchema,
  IdempotencyLockLostError,
  InvalidCursorError,
  isLibraryTab,
  LIBRARY_TAB_IDS,
  listProjects,
  ProjectQuotaExceededError,
} from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem, ApiResult } from "@/lib/api/v1";
import { assertPlanJobsReady } from "@/lib/plan/api";
import { refreshJob, sendPlanEvent } from "@/lib/plan/jobs";
import { pageQuery } from "@/lib/storyboard/api";

// C1 GET /api/v1/projects (docs/API.md C1, F21): "My videos". Only the signed-in user's projects,
// never archived ones, newest-updated first (`updatedAt` desc, `_id` desc). Query: `tab` optional
// (drafts | ready | scheduled | published; omitted = all), `limit` 1–50 (20), `cursor` (from
// `nextCursor`; made for one tab only). Answer: { items: ProjectSummary[], nextCursor }.
// Rate: the shared 300 reads per minute. The My videos page calls the same function directly.

export const GET = apiRoute({
  rateLimit: API_RATE_LIMITS.readsPerUser,
  handle: async ({ db, user, request }) => {
    const url = new URL(request.url);
    const page = pageQuery(url, ["tab"]);
    const rawTab = url.searchParams.get("tab");
    if (rawTab !== null && !isLibraryTab(rawTab)) {
      throw new ApiProblem(400, "INVALID_INPUT", API_MESSAGES.INVALID_INPUT, { issues: [{ path: "tab", message: `must be one of ${LIBRARY_TAB_IDS.join(", ")}` }] });
    }
    const tab = rawTab !== null && isLibraryTab(rawTab) ? rawTab : null;
    try {
      // The stuck-job rule on each card's active job, like C3 (writes only when a job is stuck).
      return await listProjects(db, user.id, { tab, limit: page.limit, cursor: page.cursor }, (job) => refreshJob(db, job));
    } catch (error) {
      if (error instanceof InvalidCursorError) throw new ApiProblem(400, "INVALID_INPUT", error.message, { issues: [{ path: "cursor", message: "invalid cursor" }] });
      throw error;
    }
  },
});

// C2 POST /api/v1/projects (docs/API.md §14.3): ① "Create storyboard".
// Pipeline (lib/api/v1.ts): Origin → session → 10 per hour per user → JSON body (64 KB, strict) →
// Idempotency-Key → here. Then (F15, full spec):
//   1. the AI planner and Inngest must be set up (else 500, nothing saved or counted);
//   2. ONE transaction: the projects/day quota (5, user timezone), the project in state `planning`
//      (planRequestCount 0: counted when the job really asks Gemini), its queued `plan` job, and the
//      saved answer for the Idempotency-Key;
//   3. AFTER the commit, the `plan.requested` event goes to Inngest (never inside the transaction).
//      If that send fails the answer is still 202: the job stays queued and is sent again by the
//      stuck-job rule when the page polls (lib/plan/jobs.ts).
// Answer: 202 { project, job }.

export const POST = apiRoute({
  rateLimit: API_RATE_LIMITS.createProjectPerUser,
  body: CreateProjectBodySchema,
  idempotent: true,
  handle: async ({ db, user, body, idempotencyLock }) => {
    assertPlanJobsReady();
    let created: Awaited<ReturnType<typeof createProject>>;
    try {
      created = await createProject(db, { ownerId: user.id, timezone: user.timezone, body, idempotencyLock });
    } catch (error) {
      if (error instanceof ProjectQuotaExceededError) {
        throw new ApiProblem(429, "QUOTA_EXCEEDED", `You've created ${error.limit} projects today. Try again tomorrow.`, {
          quota: "projects_per_day",
          limit: error.limit,
          used: error.used,
          resetsAt: error.resetsAt.toISOString(),
        });
      }
      if (error instanceof IdempotencyLockLostError) {
        // This request was so slow that a repeat of the same click took over; nothing was saved
        // here. The repeat's answer is what counts: the client tries again and gets it replayed.
        throw new ApiProblem(409, "IDEMPOTENCY_IN_PROGRESS", API_MESSAGES.IDEMPOTENCY_IN_PROGRESS);
      }
      throw error;
    }
    await sendPlanEvent(db, created.job);
    return new ApiResult(CREATE_PROJECT_STATUS, created.response);
  },
});
