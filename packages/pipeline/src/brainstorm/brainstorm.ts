import type { Language } from "../contracts";
import { ProviderError } from "../providers/errors";
import { GeminiPlanner } from "../providers/gemini";
import type { PlannerProvider, PlannerResponse, PlannerTurn, TokenUsage } from "../providers/planner";
import { withRetries } from "../providers/retry";
import { brainstormOutputJsonSchema, evaluateBrainstormOutput, type BrainstormEvaluation, type BrainstormIdea } from "./output";
import { buildBrainstormRepairPrompt, buildBrainstormSystemInstruction, buildBrainstormUserPrompt } from "./prompts";

/**
 * C7 brainstorm runner (API.md C7, ARCHITECTURE §14, §16.1): one synchronous AI call with a fixed
 * overall time limit (30 s), bounded retries for busy/network errors (providers/retry.ts, never
 * past the time limit) and at most ONE repair attempt when the answer is not 5 valid ideas.
 * Every request to the provider is reported to `usage` before it is sent and after it ends, so
 * failed calls are logged too (providerUsage, DATABASE.md §4.15).
 * The provider passed in must not retry by itself (GeminiPlanner with `retry.maxRetries: 0`):
 * the retries happen here, so each one is logged.
 */

export const BRAINSTORM_TIMEOUT_MS = 30_000;
/**
 * A retry or the repair starts only if at least this much of the 30 s is left: a request with less
 * time would just be cut off (and logged as a wasted call). The first request always starts.
 */
export const BRAINSTORM_MIN_ATTEMPT_MS = 5_000;
/** Initial answer + one repair. */
export const BRAINSTORM_MAX_ANSWERS = 2;
/** Retries per answer for busy/network errors, with short waits (the whole call has 30 s). */
export const BRAINSTORM_RETRY = { maxRetries: 2, backoffMs: [1_000, 2_500], maxWaitMs: 5_000 } as const;

/** How one request to the provider ended, for the usage log. */
export type BrainstormCallOutcome = "ok" | "invalid_output" | "unsuitable" | "rejected" | "busy" | "timeout" | "error";

export interface BrainstormCallReport {
  status: "final" | "failed";
  outcome: BrainstormCallOutcome;
  model: string;
  usage: TokenUsage | null;
  latencyMs: number;
}

/** Where each provider request is logged. `begin` runs BEFORE the request is sent. */
export interface BrainstormUsageSink {
  begin(): Promise<unknown>;
  end(handle: unknown, report: BrainstormCallReport): Promise<void>;
}

export type BrainstormFailure =
  /** Still busy (or too slow) after the allowed retries, or no valid answer after the repair. */
  | "busy"
  /** The provider blocked the subject for safety, or the model said it is not suitable. */
  | "rejected"
  /** Key, model or request problem on our side: retrying won't help. */
  | "unavailable";

export class BrainstormError extends Error {
  readonly reason: BrainstormFailure;
  /** "invalid_output" when the answers were never valid, else the provider error kind. */
  readonly detail: string;
  constructor(reason: BrainstormFailure, detail: string, message: string) {
    super(message);
    this.name = "BrainstormError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Per-request limit: the same 30 s, so one slow answer may use the whole time (the overall abort
 * stops it first). The first live call (2026-11-13) took over 25 s; a shorter per-request limit
 * would only cut slow answers off and waste a retry. Retries still happen for quick 429/503 answers.
 */
export const BRAINSTORM_REQUEST_TIMEOUT_MS = BRAINSTORM_TIMEOUT_MS;
/** 5 short ideas need ~600 tokens; the rest is room for the model's thinking. */
export const BRAINSTORM_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Brainstorm's own model (GEMINI_BRAINSTORM_MODEL, optional; the planner keeps GEMINI_MODEL).
 * gemini-3.6-flash took 55-57 s on the free tier even with low thinking (2026-11-13);
 * gemini-3.1-flash-lite with low thinking answered in about 8 s with 5 good ideas. A fixed model
 * id, never a moving "-latest" alias.
 */
export const DEFAULT_BRAINSTORM_MODEL = "gemini-3.1-flash-lite";

/** The Gemini adapter set up for brainstorming: low thinking, no retries of its own (they happen here, logged). */
export function createBrainstormProvider(options: { apiKey: string; model: string; fetch?: typeof fetch }): PlannerProvider {
  return new GeminiPlanner({
    apiKey: options.apiKey,
    model: options.model,
    retry: { maxRetries: 0 },
    requestTimeoutMs: BRAINSTORM_REQUEST_TIMEOUT_MS,
    maxOutputTokens: BRAINSTORM_MAX_OUTPUT_TOKENS,
    thinkingLevel: "low",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export interface BrainstormInput {
  provider: PlannerProvider;
  subject: string;
  language: Language;
  usage?: BrainstormUsageSink;
  timeoutMs?: number;
  retry?: { maxRetries?: number; backoffMs?: readonly number[]; maxWaitMs?: number };
  /** Least time left for a retry or the repair (default BRAINSTORM_MIN_ATTEMPT_MS). */
  minAttemptMs?: number;
  /** Tests: clock and sleep. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called when writing the usage log fails after a call (the answer is still returned). */
  onUsageError?: (error: unknown) => void;
}

export interface BrainstormResult {
  ideas: BrainstormIdea[];
  model: string;
  /** Provider requests made (retries and the repair included). */
  calls: number;
  repaired: boolean;
}

function outcomeOfError(error: unknown, timedOut: boolean): BrainstormCallOutcome {
  if (timedOut) return "timeout";
  if (!(error instanceof ProviderError)) return "error";
  if (error.kind === "safety") return "rejected";
  if (error.kind === "transient" || error.kind === "quota") return "busy";
  return "error";
}

export async function brainstormIdeas(input: BrainstormInput): Promise<BrainstormResult> {
  const { provider, subject, language, usage } = input;
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? BRAINSTORM_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const minAttemptMs = input.minAttemptMs ?? BRAINSTORM_MIN_ATTEMPT_MS;
  /** True once the time is up, or too little is left for another request. */
  const outOfTime = () => controller.signal.aborted || deadline - now() < minAttemptMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const systemInstruction = buildBrainstormSystemInstruction(language);
  const responseJsonSchema = brainstormOutputJsonSchema();
  const turns: PlannerTurn[] = [{ role: "user", text: buildBrainstormUserPrompt(subject, language) }];
  let calls = 0;

  const logEnd = async (handle: unknown, report: BrainstormCallReport) => {
    if (!usage) return;
    try {
      await usage.end(handle, report);
    } catch (error) {
      input.onUsageError?.(error);
    }
  };

  /** One request to the provider, logged before and after. */
  const callOnce = async (): Promise<{ response: PlannerResponse; evaluation: BrainstormEvaluation }> => {
    // The first request always starts; a retry or the repair only with enough time left.
    if (controller.signal.aborted || (calls > 0 && outOfTime())) {
      throw new ProviderError({ provider: provider.name, kind: "transient", message: "brainstorm time limit reached (or too little time left for another request)" });
    }
    const handle = usage ? await usage.begin() : null;
    calls++;
    const started = now();
    try {
      const response = await provider.generate({ systemInstruction, turns: [...turns], responseJsonSchema, abortSignal: controller.signal });
      const evaluation = evaluateBrainstormOutput(response.text, language);
      const outcome: BrainstormCallOutcome = evaluation.kind === "ok" ? "ok" : evaluation.kind === "unsuitable" ? "unsuitable" : "invalid_output";
      await logEnd(handle, { status: "final", outcome, model: response.model, usage: response.usage, latencyMs: now() - started });
      return { response, evaluation };
    } catch (error) {
      await logEnd(handle, { status: "failed", outcome: outcomeOfError(error, controller.signal.aborted), model: provider.model, usage: null, latencyMs: now() - started });
      throw error;
    }
  };

  try {
    for (let answer = 1; answer <= BRAINSTORM_MAX_ANSWERS; answer++) {
      let result: { response: PlannerResponse; evaluation: BrainstormEvaluation };
      try {
        result = await withRetries(callOnce, {
          maxRetries: input.retry?.maxRetries ?? BRAINSTORM_RETRY.maxRetries,
          backoffMs: input.retry?.backoffMs ?? BRAINSTORM_RETRY.backoffMs,
          maxWaitMs: input.retry?.maxWaitMs ?? BRAINSTORM_RETRY.maxWaitMs,
          deadline,
          minAttemptMs,
          now,
          ...(input.sleep ? { sleep: input.sleep } : {}),
        });
      } catch (error) {
        throw toBrainstormError(error, outOfTime());
      }
      const { response, evaluation } = result;
      if (evaluation.kind === "ok") return { ideas: evaluation.ideas, model: response.model, calls, repaired: answer > 1 };
      if (evaluation.kind === "unsuitable") throw new BrainstormError("rejected", "unsuitable", "The model found no safe educational video for this subject.");
      if (answer === BRAINSTORM_MAX_ANSWERS) break;
      if (outOfTime()) throw new BrainstormError("busy", "timeout", "Too little time left for the repair request.");
      turns.push({ role: "model", text: response.text.trim() || "(empty answer)" }, { role: "user", text: buildBrainstormRepairPrompt(evaluation.problems, language) });
    }
    throw new BrainstormError("busy", "invalid_output", "No valid brainstorm answer after the repair attempt.");
  } finally {
    clearTimeout(timer);
  }
}

function toBrainstormError(error: unknown, timedOut: boolean): Error {
  if (error instanceof ProviderError) {
    if (error.kind === "safety") return new BrainstormError("rejected", error.kind, error.message);
    if (error.kind === "transient" || error.kind === "quota") return new BrainstormError("busy", timedOut ? "timeout" : error.kind, error.message);
    if (error.kind === "bad-response") return new BrainstormError("busy", error.kind, error.message);
    return new BrainstormError("unavailable", error.kind, error.message);
  }
  if (timedOut) return new BrainstormError("busy", "timeout", "The brainstorm time limit was reached.");
  return error instanceof Error ? error : new Error(String(error));
}
