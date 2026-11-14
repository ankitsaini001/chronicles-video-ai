import { API_RATE_LIMITS, BrainstormBodySchema, countBrainstormWithinLimit, finishProviderUsage, reserveProviderUsage } from "@bytereel/db";
import type { ObjectId } from "mongodb";
import { apiRoute } from "@/lib/api/server";
import { runBrainstorm } from "@/lib/brainstorm/handler";
import { brainstormProviderFromEnv } from "@/lib/brainstorm/provider";

// C7 POST /api/v1/brainstorm (docs/API.md C7): ① "✨ Brainstorm with AI". A broad subject →
// exactly 5 focused video ideas from Gemini, answered directly (synchronous, 30 s overall limit,
// ARCHITECTURE §14). Nothing about the ideas is stored and no project is created; the creator picks
// one and C2 saves it as `inputType: "brainstorm"` + `brainstormChoice`.
// Pipeline (lib/api/v1.ts): Origin → session → 10 per hour per user → JSON body (strict) → the work
// in lib/brainstorm/handler.ts (30 per day, then Gemini).
// No Idempotency-Key: C7 starts no job and saves nothing (API.md §6); a repeat is a new brainstorm.

/** Well above the 30 s brainstorm limit, so the host never cuts the answer off. */
export const maxDuration = 60;

export const POST = apiRoute({
  rateLimit: API_RATE_LIMITS.brainstormPerUser,
  body: BrainstormBodySchema,
  handle: ({ db, user, body, requestId }) =>
    runBrainstorm(
      { user, body, requestId },
      {
        provider: () => brainstormProviderFromEnv(process.env),
        countToday: (u) => countBrainstormWithinLimit(db, { ownerId: u.id, timezone: u.timezone }),
        reserveUsage: (input) => reserveProviderUsage(db, { ...input, provider: "gemini", operation: "brainstorm" }),
        finishUsage: (handle, input) => finishProviderUsage(db, handle as ObjectId, input),
      },
    ),
});
