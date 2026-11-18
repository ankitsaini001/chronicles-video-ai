import type { Language, Source, VoicePreset } from "../contracts";
import { ProviderError } from "../providers/errors";
import { GeminiPlanner } from "../providers/gemini";
import type { PlannerProvider } from "../providers/planner";
import { buildCreatorIdeaPrompt, type CreatorIdea } from "./prompts";

/**
 * Building blocks for the web app's background storyboard job (F15, `plan-video`): the SAME
 * planner as the prototype (system instruction, response schema, plan validation, ONE repair),
 * but each Gemini request runs as its own durable step, so a request that already succeeded is
 * never paid for twice and every request is logged (providerUsage) on its own.
 *
 * Limits (ARCHITECTURE §16.1, §20.2): 240 s per request (180 s until F26); at most 4 requests per job attempt
 * (the first answer + up to 2 retries for busy/network errors, plus the one repair); waits of 20 s
 * then 60 s (2 s / 5 s until after F26), or a longer Retry-After up to 60 s (more than that counts
 * as "busy"). No automatic model fallback.
 */

/**
 * Per-request time limit. 180 s (the prototype planner's) until F26: on a slow evening (2026-11-17)
 * a storyboard took 113 s and every change request ran past 180 s (a change sends AND gets back the
 * whole storyboard). 240 s gives a third more room and still fits one step under the 300 s a
 * Vercel function may run (apps/web/app/api/inngest/route.ts `maxDuration`), with time to spare
 * for the database writes around the request.
 */
export const PLAN_REQUEST_TIMEOUT_MS = 240_000;
/** Most Gemini requests one job attempt may make: 3 (first answer + 2 retries) + 1 repair. */
export const PLAN_JOB_MAX_REQUESTS = 4;
/** Retries for one answer after a busy/network error (the prototype's DEFAULT_RETRY). */
export const PLAN_STEP_RETRIES = 2;
/**
 * Waits before retry 1 and retry 2 (ms), and the longest wait we accept. 2 s / 5 s until after F26:
 * on 2026-11-17 Gemini answered 503 "high demand" three times within seconds, so every retry landed
 * in the same spike. 20 s / 60 s spread the tries over about 1.5 minutes. The wait is an Inngest
 * retry (RetryAfterError): no server is kept busy and nothing is paid while waiting; the job's
 * progress is written before each wait, far inside the 10-minute stuck-job rule.
 */
export const PLAN_RETRY_BACKOFF_MS = [20_000, 60_000] as const;
export const PLAN_RETRY_MAX_WAIT_MS = 60_000;

/**
 * The Gemini adapter for the plan job: no retries of its own (each retry is a new, logged step),
 * PLAN_REQUEST_TIMEOUT_MS per request, the full output budget of the prototype planner.
 */
export function createPlanJobProvider(options: { apiKey: string; model: string; fetch?: typeof fetch }): PlannerProvider {
  return new GeminiPlanner({
    apiKey: options.apiKey,
    model: options.model,
    retry: { maxRetries: 0 },
    requestTimeoutMs: PLAN_REQUEST_TIMEOUT_MS,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/** The first message of the conversation for a creator's idea (all creator text as data). */
export function planJobPrompt(idea: CreatorIdea, language: Language, voicePreset: VoicePreset): string {
  return buildCreatorIdeaPrompt({ idea, language, voicePreset });
}

/** API.md C2: pasted notes become the plan's single source (`creator-notes`); a topic has none. */
export function ideaSources(idea: CreatorIdea): Source[] {
  return idea.type === "notes" ? [{ id: "creator-notes", title: "Creator notes", notes: idea.text }] : [];
}

/** How a failed request should be treated by the job. */
export type PlanRequestFailure =
  /** Busy, rate-limited, timed out or a network error: retry (within the limits), then PROVIDER_BUSY. */
  | { kind: "busy"; retryAfterMs: number | null }
  /** Gemini refused the content (safety): no retry, PROVIDER_REJECTED. */
  | { kind: "rejected" }
  /** Key, model or request problem on our side: no retry, INTERNAL (admin must fix the setup). */
  | { kind: "setup" };

/**
 * A short, fixed code for why a Gemini request failed, saved on its `providerUsage` row (F26 founder
 * test: "busy" alone couldn't tell an overloaded model from a quota limit or an empty answer).
 * Built only from the HTTP status, Google's status word and fixed labels: never Gemini's free text,
 * which could quote the storyboard. Examples: "transient 503 UNAVAILABLE", "quota 429
 * RESOURCE_EXHAUSTED", "bad-response no-candidates", "transient timeout", "other".
 */
export function planErrorCode(error: unknown): string {
  if (!(error instanceof ProviderError)) return "other";
  const message = error.message;
  if (error.status !== null) {
    // Google's status word: right after the number, or inside the quoted error body
    // ("Gemini API error 503 Service Unavailable: { … "status": "UNAVAILABLE" }", seen 2026-11-17).
    const word = /^Gemini API error \d{3} ([A-Z_]{3,40})\b/.exec(message)?.[1] ?? /"status":\s*"([A-Z_]{3,40})"/.exec(message)?.[1];
    return `${error.kind} ${error.status}${word ? ` ${word}` : ""}`;
  }
  const label = /abort|timeout|timed out/i.test(message)
    ? "timeout"
    : /no candidates/i.test(message)
      ? "no-candidates"
      : /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(message)
        ? "network"
        : /json|unexpected token|parse/i.test(message)
          ? "bad-json"
          : "other";
  return `${error.kind} ${label}`;
}

export function classifyPlanRequestError(error: unknown): PlanRequestFailure {
  if (!(error instanceof ProviderError)) return { kind: "busy", retryAfterMs: null };
  if (error.kind === "safety") return { kind: "rejected" };
  if (error.kind === "transient" || error.kind === "bad-response") return { kind: "busy", retryAfterMs: error.retryAfterMs };
  // A quota answer with a short Retry-After is just "busy"; the retry logic decides if the wait is too long.
  if (error.kind === "quota") return { kind: "busy", retryAfterMs: error.retryAfterMs };
  return { kind: "setup" };
}

/**
 * The wait before retry number `retry` (1-based), or null when Gemini asks for more than we accept.
 * Our own backoff is the minimum: a Retry-After shorter than it doesn't shorten the wait (a short
 * hint during a demand spike just lands in the same spike), a longer one is honoured up to 60 s.
 */
export function planRetryWaitMs(retry: number, retryAfterMs: number | null): number | null {
  if (retryAfterMs !== null && retryAfterMs > PLAN_RETRY_MAX_WAIT_MS) return null;
  const backoff = PLAN_RETRY_BACKOFF_MS[Math.min(retry - 1, PLAN_RETRY_BACKOFF_MS.length - 1)]!;
  return Math.max(backoff, retryAfterMs ?? 0);
}
