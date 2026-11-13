import { API_RATE_LIMITS, CREATE_PROJECT_STATUS, createProject, CreateProjectBodySchema, IdempotencyLockLostError, ProjectQuotaExceededError } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem, ApiResult } from "@/lib/api/v1";

// C2 POST /api/v1/projects (docs/API.md §14.3): ① "Create storyboard".
// F12 (no AI yet): saves the project in state `draft` and answers 201 { project, job: null }.
// F15 adds the queued `plan` job in the same transaction and the 202 answer (API.md C2 "Until F15").
// Pipeline (lib/api/v1.ts): Origin → session → 10 per hour per user → JSON body (64 KB, strict) →
// Idempotency-Key → here. The projects/day quota (5, user timezone) is checked inside the
// transaction that saves the project, so two clicks at the same moment can't get past it.

export const POST = apiRoute({
  rateLimit: API_RATE_LIMITS.createProjectPerUser,
  body: CreateProjectBodySchema,
  idempotent: true,
  handle: async ({ db, user, body, idempotencyLock }) => {
    try {
      const created = await createProject(db, { ownerId: user.id, timezone: user.timezone, body, idempotencyLock });
      return new ApiResult(CREATE_PROJECT_STATUS, created);
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
  },
});
