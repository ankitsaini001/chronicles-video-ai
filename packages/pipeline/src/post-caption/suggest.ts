import type { Language } from "../contracts";
import { planErrorCode } from "../planning/plan-job";
import { ProviderError } from "../providers/errors";
import { GeminiPlanner } from "../providers/gemini";
import type { PlannerProvider, PlannerResponse, PlannerTurn, TokenUsage } from "../providers/planner";
import { withRetries } from "../providers/retry";
import { evaluatePostCaptionOutput, postCaptionOutputJsonSchema, type PostCaptionEvaluation, type PostCaptionSuggestion } from "./output";
import { buildPostCaptionRepairPrompt, buildPostCaptionSystemInstruction, buildPostCaptionUserPrompt, type PostCaptionScript } from "./prompts";

/**
 * H1 caption runner (F29; API.md H1, ARCHITECTURE §14, §16.1): one synchronous AI call with a fixed
 * overall time limit (30 s), bounded retries for busy/network errors (never past the time limit) and
 * at most ONE repair attempt when the answer breaks the rules. The same pattern as the C7 brainstorm
 * runner (brainstorm/brainstorm.ts); every request is reported to `usage` before it is sent and after
 * it ends, a failed one with the short `errorCode` the storyboard jobs use (planErrorCode, F26).
 * The provider passed in must not retry by itself (createPostCaptionProvider: `retry.maxRetries: 0`).
 */

export const POST_CAPTION_TIMEOUT_MS = 30_000;
/** A retry or the repair starts only with at least this much of the 30 s left. */
export const POST_CAPTION_MIN_ATTEMPT_MS = 5_000;
/** Initial answer + one repair. */
export const POST_CAPTION_MAX_ANSWERS = 2;
export const POST_CAPTION_RETRY = { maxRetries: 2, backoffMs: [1_000, 2_500], maxWaitMs: 5_000 } as const;
/** A caption and 5 hashtags need ~200 tokens; the rest is room for the model's thinking. */
export const POST_CAPTION_MAX_OUTPUT_TOKENS = 8_192;

/**
 * The Gemini adapter for captions: the storyboard planner's model (GEMINI_MODEL, chosen by the web
 * app's provider.ts), low thinking (a short answer), the whole 30 s per request, no retries of its own.
 */
export function createPostCaptionProvider(options: { apiKey: string; model: string; fetch?: typeof fetch }): PlannerProvider {
  return new GeminiPlanner({
    apiKey: options.apiKey,
    model: options.model,
    retry: { maxRetries: 0 },
    requestTimeoutMs: POST_CAPTION_TIMEOUT_MS,
    maxOutputTokens: POST_CAPTION_MAX_OUTPUT_TOKENS,
    thinkingLevel: "low",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export type PostCaptionCallOutcome = "ok" | "invalid_output" | "unsuitable" | "rejected" | "busy" | "timeout" | "error";

export interface PostCaptionCallReport {
  status: "final" | "failed";
  outcome: PostCaptionCallOutcome;
  model: string;
  usage: TokenUsage | null;
  latencyMs: number;
  /** Failed requests only: a short fixed code (planErrorCode), never Gemini's own text. */
  errorCode?: string;
}

/** Where each provider request is logged. `begin` runs BEFORE the request is sent. */
export interface PostCaptionUsageSink {
  begin(): Promise<unknown>;
  end(handle: unknown, report: PostCaptionCallReport): Promise<void>;
}

export type PostCaptionFailure = "busy" | "rejected" | "unavailable";

export class PostCaptionError extends Error {
  readonly reason: PostCaptionFailure;
  readonly detail: string;
  constructor(reason: PostCaptionFailure, detail: string, message: string) {
    super(message);
    this.name = "PostCaptionError";
    this.reason = reason;
    this.detail = detail;
  }
}

export interface PostCaptionInput {
  provider: PlannerProvider;
  script: PostCaptionScript;
  language: Language;
  usage?: PostCaptionUsageSink;
  timeoutMs?: number;
  retry?: { maxRetries?: number; backoffMs?: readonly number[]; maxWaitMs?: number };
  minAttemptMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onUsageError?: (error: unknown) => void;
}

export interface PostCaptionResult {
  suggestion: PostCaptionSuggestion;
  model: string;
  calls: number;
  repaired: boolean;
}

function outcomeOfError(error: unknown, timedOut: boolean): PostCaptionCallOutcome {
  if (timedOut) return "timeout";
  if (!(error instanceof ProviderError)) return "error";
  if (error.kind === "safety") return "rejected";
  if (error.kind === "transient" || error.kind === "quota") return "busy";
  return "error";
}

export async function suggestPostCaption(input: PostCaptionInput): Promise<PostCaptionResult> {
  const { provider, script, language, usage } = input;
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? POST_CAPTION_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const minAttemptMs = input.minAttemptMs ?? POST_CAPTION_MIN_ATTEMPT_MS;
  const controller = new AbortController();
  const outOfTime = () => controller.signal.aborted || deadline - now() < minAttemptMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const systemInstruction = buildPostCaptionSystemInstruction(language);
  const responseJsonSchema = postCaptionOutputJsonSchema();
  const turns: PlannerTurn[] = [{ role: "user", text: buildPostCaptionUserPrompt(script, language) }];
  let calls = 0;

  const logEnd = async (handle: unknown, report: PostCaptionCallReport) => {
    if (!usage) return;
    try {
      await usage.end(handle, report);
    } catch (error) {
      input.onUsageError?.(error);
    }
  };

  const callOnce = async (): Promise<{ response: PlannerResponse; evaluation: PostCaptionEvaluation }> => {
    if (controller.signal.aborted || (calls > 0 && outOfTime())) {
      throw new ProviderError({ provider: provider.name, kind: "transient", message: "caption time limit reached (or too little time left for another request)" });
    }
    const handle = usage ? await usage.begin() : null;
    calls++;
    const started = now();
    let response: PlannerResponse;
    try {
      response = await provider.generate({ systemInstruction, turns: [...turns], responseJsonSchema, abortSignal: controller.signal });
    } catch (error) {
      await logEnd(handle, { status: "failed", outcome: outcomeOfError(error, controller.signal.aborted), model: provider.model, usage: null, latencyMs: now() - started, errorCode: planErrorCode(error) });
      throw error;
    }
    const evaluation = evaluatePostCaptionOutput(response.text, language);
    const outcome: PostCaptionCallOutcome = evaluation.kind === "ok" ? "ok" : evaluation.kind === "unsuitable" ? "unsuitable" : "invalid_output";
    await logEnd(handle, { status: "final", outcome, model: response.model, usage: response.usage, latencyMs: now() - started });
    return { response, evaluation };
  };

  try {
    for (let answer = 1; answer <= POST_CAPTION_MAX_ANSWERS; answer++) {
      let result: { response: PlannerResponse; evaluation: PostCaptionEvaluation };
      try {
        result = await withRetries(callOnce, {
          maxRetries: input.retry?.maxRetries ?? POST_CAPTION_RETRY.maxRetries,
          backoffMs: input.retry?.backoffMs ?? POST_CAPTION_RETRY.backoffMs,
          maxWaitMs: input.retry?.maxWaitMs ?? POST_CAPTION_RETRY.maxWaitMs,
          deadline,
          minAttemptMs,
          now,
          ...(input.sleep ? { sleep: input.sleep } : {}),
        });
      } catch (error) {
        throw toPostCaptionError(error, outOfTime());
      }
      const { response, evaluation } = result;
      if (evaluation.kind === "ok") return { suggestion: evaluation.suggestion, model: response.model, calls, repaired: answer > 1 };
      if (evaluation.kind === "unsuitable") throw new PostCaptionError("rejected", "unsuitable", "The model found the video unsuitable for a caption.");
      if (answer === POST_CAPTION_MAX_ANSWERS) break;
      if (outOfTime()) throw new PostCaptionError("busy", "timeout", "Too little time left for the repair request.");
      turns.push({ role: "model", text: response.text.trim() || "(empty answer)" }, { role: "user", text: buildPostCaptionRepairPrompt(evaluation.problems, language) });
    }
    throw new PostCaptionError("busy", "invalid_output", "No valid caption after the repair attempt.");
  } finally {
    clearTimeout(timer);
  }
}

function toPostCaptionError(error: unknown, timedOut: boolean): Error {
  if (error instanceof ProviderError) {
    if (error.kind === "safety") return new PostCaptionError("rejected", error.kind, error.message);
    if (error.kind === "transient" || error.kind === "quota" || error.kind === "bad-response") return new PostCaptionError("busy", timedOut ? "timeout" : error.kind, error.message);
    return new PostCaptionError("unavailable", error.kind, error.message);
  }
  if (timedOut) return new PostCaptionError("busy", "timeout", "The caption time limit was reached.");
  return error instanceof Error ? error : new Error(String(error));
}
