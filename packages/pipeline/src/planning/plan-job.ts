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
 * Limits (ARCHITECTURE §16.1, §20.2): 180 s per request; at most 4 requests per job attempt
 * (the first answer + up to 2 retries for busy/network errors, plus the one repair); waits honour
 * Retry-After up to 60 s (a longer wait counts as "busy"). No automatic model fallback.
 */

/** Per-request time limit (the prototype planner's). */
export const PLAN_REQUEST_TIMEOUT_MS = 180_000;
/** Most Gemini requests one job attempt may make: 3 (first answer + 2 retries) + 1 repair. */
export const PLAN_JOB_MAX_REQUESTS = 4;
/** Retries for one answer after a busy/network error (the prototype's DEFAULT_RETRY). */
export const PLAN_STEP_RETRIES = 2;
/** Waits between retries when Gemini gives no Retry-After (ms), and the longest wait we accept. */
export const PLAN_RETRY_BACKOFF_MS = [2_000, 5_000] as const;
export const PLAN_RETRY_MAX_WAIT_MS = 60_000;

/**
 * The Gemini adapter for the plan job: no retries of its own (each retry is a new, logged step),
 * 180 s per request, the full output budget of the prototype planner.
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

export function classifyPlanRequestError(error: unknown): PlanRequestFailure {
  if (!(error instanceof ProviderError)) return { kind: "busy", retryAfterMs: null };
  if (error.kind === "safety") return { kind: "rejected" };
  if (error.kind === "transient" || error.kind === "bad-response") return { kind: "busy", retryAfterMs: error.retryAfterMs };
  // A quota answer with a short Retry-After is just "busy"; the retry logic decides if the wait is too long.
  if (error.kind === "quota") return { kind: "busy", retryAfterMs: error.retryAfterMs };
  return { kind: "setup" };
}

/** The wait before retry number `retry` (1-based), or null when the wait would be too long. */
export function planRetryWaitMs(retry: number, retryAfterMs: number | null): number | null {
  const wait = retryAfterMs ?? PLAN_RETRY_BACKOFF_MS[Math.min(retry - 1, PLAN_RETRY_BACKOFF_MS.length - 1)]!;
  return wait > PLAN_RETRY_MAX_WAIT_MS ? null : wait;
}
