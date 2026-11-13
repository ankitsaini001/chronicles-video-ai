import { brainstormIdeas, BrainstormError, type BrainstormInput, type BrainstormUsageSink, type TokenUsage } from "@bytereel/pipeline/brainstorm";
import type { BrainstormBody, BrainstormCountResult } from "@bytereel/db/brainstorm";
import { API_MESSAGES, ApiProblem } from "../api/v1";
import type { SessionUser } from "../auth/session";
import type { BrainstormProviderResult } from "./provider";

// C7 POST /api/v1/brainstorm, the endpoint's own work (docs/API.md C7). Kept free of Next.js and
// of the real database (route.ts passes them in), so the tests run it with fakes.
// Order: provider set up? → 30 brainstorms/day (user timezone) → Gemini. A refused request never
// reaches Gemini. Each Gemini request is logged before it is sent and after it ends (providerUsage,
// operation "brainstorm"); the subject itself is never logged or stored.
// TODO(F27/F36): 503 SPEND_CEILING and 503 MAINTENANCE (from the `settings` document), checked
// before the daily count, like C2.

/** We pay nothing on Gemini's free tier; the token counts are kept, so a paid price can be applied later. */
export const GEMINI_FREE_TIER_COST_INR = 0;

export interface UsageFinish {
  status: "final" | "failed";
  outcome: string;
  model: string;
  units: { promptTokens: number; outputTokens: number };
  estCostInr: number;
  latencyMs: number;
}

export interface BrainstormDeps {
  provider: () => BrainstormProviderResult;
  countToday: (user: SessionUser) => Promise<BrainstormCountResult>;
  reserveUsage: (input: { ownerId: string; model: string; estCostInr: number }) => Promise<unknown>;
  finishUsage: (handle: unknown, input: UsageFinish) => Promise<void>;
  /** Server log (default console). */
  log?: (level: "warn" | "error", message: string) => void;
  /** Tests: shorter time limit, fake sleep. */
  run?: Pick<BrainstormInput, "timeoutMs" | "sleep" | "retry">;
}

export type BrainstormResponse = { subject: string; language: BrainstormBody["language"]; ideas: { id: string; title: string; hook: string; angle: string }[] };

/** Billed output = the answer + the model's thinking tokens. */
function unitsOf(usage: TokenUsage | null): UsageFinish["units"] {
  return { promptTokens: usage?.promptTokens ?? 0, outputTokens: (usage?.outputTokens ?? 0) + (usage?.thinkingTokens ?? 0) };
}

export async function runBrainstorm(
  context: { user: SessionUser; body: BrainstormBody; requestId: string },
  deps: BrainstormDeps,
): Promise<BrainstormResponse> {
  const { user, body, requestId } = context;
  const log = deps.log ?? ((level, message) => console[level](message));

  const ai = deps.provider();
  // Not set up (missing key/model, or the test switch where it isn't allowed): 500, reason logged.
  if (!ai.ok) throw new Error(`Brainstorm is not set up: ${ai.problem}`);

  const count = await deps.countToday(user);
  if (!count.ok) {
    throw new ApiProblem(429, "QUOTA_EXCEEDED", `You've used today's ${count.limit} brainstorms. Try again tomorrow.`, {
      quota: "brainstorms_per_day",
      limit: count.limit,
      used: count.used,
      resetsAt: count.resetsAt.toISOString(),
    });
  }

  const usage: BrainstormUsageSink = {
    begin: () => deps.reserveUsage({ ownerId: user.id, model: ai.provider.model, estCostInr: GEMINI_FREE_TIER_COST_INR }),
    end: (handle, report) =>
      deps.finishUsage(handle, {
        status: report.status,
        outcome: report.outcome,
        model: report.model,
        units: unitsOf(report.usage),
        estCostInr: GEMINI_FREE_TIER_COST_INR,
        latencyMs: report.latencyMs,
      }),
  };

  try {
    const result = await brainstormIdeas({
      ...deps.run,
      provider: ai.provider,
      subject: body.subject,
      language: body.language,
      usage,
      onUsageError: (error) => log("error", `Brainstorm usage log failed (request ${requestId}): ${error instanceof Error ? error.message : String(error)}`),
    });
    return { subject: body.subject, language: body.language, ideas: result.ideas };
  } catch (error) {
    if (!(error instanceof BrainstormError)) throw error;
    if (error.reason === "rejected") throw new ApiProblem(422, "PROVIDER_REJECTED", API_MESSAGES.BRAINSTORM_REJECTED);
    if (error.reason === "busy") {
      log("warn", `Brainstorm busy (request ${requestId}): ${error.detail}`);
      throw new ApiProblem(503, "PROVIDER_BUSY", API_MESSAGES.BRAINSTORM_BUSY, undefined, { "Retry-After": "60" });
    }
    // Key, model or request problem on our side: 500 INTERNAL, the reason goes to the server log.
    throw new Error(`Brainstorm provider problem (${error.detail}): ${error.message}`);
  }
}
