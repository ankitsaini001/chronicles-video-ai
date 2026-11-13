/**
 * Planner provider boundary. The planning stage only talks to this interface, so tests use a
 * mock and the live adapter (Gemini) can be swapped without touching the planning logic.
 */

export interface PlannerTurn {
  role: "user" | "model";
  text: string;
}

export interface PlannerRequest {
  systemInstruction: string;
  /** Conversation so far: the initial prompt, and for a repair the previous answer + the errors. */
  turns: PlannerTurn[];
  /** JSON Schema for structured output. */
  responseJsonSchema: Record<string, unknown>;
  /** Cancels the request (e.g. a caller's overall timeout). The provider then throws a transient error. */
  abortSignal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  totalTokens: number | null;
}

export interface PlannerResponse {
  /** Raw JSON text returned by the model. Parsed and validated by the caller. */
  text: string;
  /** Model that actually answered (as reported by the provider, or the configured one). */
  model: string;
  /** Provider finish reason, e.g. "STOP" or "MAX_TOKENS". */
  finishReason: string | null;
  usage: TokenUsage | null;
  /** Retries spent on transient errors for this call. */
  retries: number;
  durationMs: number;
}

export interface PlannerProvider {
  readonly name: string;
  readonly model: string;
  generate(request: PlannerRequest): Promise<PlannerResponse>;
}
