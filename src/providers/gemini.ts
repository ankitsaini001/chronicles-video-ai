import { ApiError, GoogleGenAI, type GenerateContentResponse, type Model } from "@google/genai";
import { parseRetryAfter, ProviderError } from "./errors";
import type { PlannerProvider, PlannerRequest, PlannerResponse, TokenUsage } from "./planner";
import { withRetries, type RetryOptions } from "./retry";

/**
 * Gemini planner adapter (PIPELINE_DESIGN.md §3) using the official @google/genai SDK.
 *
 * - Structured output: responseMimeType application/json + a JSON schema derived from our contract.
 *   A JSON response is still validated by our own schema and semantic rules afterwards.
 * - The SDK's own retries are off; transient errors get our bounded policy (2 retries, Retry-After).
 * - Invalid key, unknown model and safety blocks stop immediately.
 * - The API key goes only to the SDK. It is never logged, stored or put in an error message.
 */

const PROVIDER = "gemini";
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS = 32_768;
const SAFETY_FINISH_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

export interface GeminiOptions {
  apiKey: string;
  model: string;
  retry?: RetryOptions;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Builds an SDK client whose fetch remembers the last Retry-After header (the SDK error drops headers). */
function createClient(apiKey: string, baseFetch: typeof fetch = fetch) {
  const state = { lastRetryAfterMs: null as number | null };
  const recordingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await baseFetch(input, init);
    state.lastRetryAfterMs = response.ok ? null : parseRetryAfter(response.headers.get("retry-after"));
    return response;
  };
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS, fetch: recordingFetch } });
  return { client, state };
}

export class GeminiPlanner implements PlannerProvider {
  readonly name = PROVIDER;
  readonly model: string;
  private readonly client: GoogleGenAI;
  private readonly state: { lastRetryAfterMs: number | null };
  private readonly retry: RetryOptions;

  constructor(options: GeminiOptions) {
    this.model = options.model;
    const { client, state } = createClient(options.apiKey, options.fetch);
    this.client = client;
    this.state = state;
    this.retry = options.retry ?? {};
  }

  async generate(request: PlannerRequest): Promise<PlannerResponse> {
    const started = Date.now();
    let retries = 0;
    const response = await withRetries(
      async () => {
        this.state.lastRetryAfterMs = null;
        try {
          // Streaming keeps the connection active while the model thinks; long non-streaming
          // requests hit server-side DEADLINE_EXCEEDED (504) in the first live run.
          const stream = await this.client.models.generateContentStream({
            model: this.model,
            contents: request.turns.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
            config: {
              systemInstruction: request.systemInstruction,
              responseMimeType: "application/json",
              responseJsonSchema: request.responseJsonSchema,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            },
          });
          const chunks: GenerateContentResponse[] = [];
          for await (const chunk of stream) chunks.push(chunk);
          return mergeChunks(chunks);
        } catch (error) {
          throw classifyGeminiError(error, this.state.lastRetryAfterMs, this.model);
        }
      },
      {
        ...this.retry,
        onRetry: (info) => {
          retries++;
          this.retry.onRetry?.(info);
        },
      },
    );
    return interpretResponse(response, this.model, retries, Date.now() - started);
  }
}

/** Merge streamed chunks into one response-like object: concatenated text, last finish reason, usage and model version. */
export function mergeChunks(chunks: readonly GenerateContentResponse[]): GenerateContentResponse {
  const text = chunks.map((c) => c.text ?? "").join("");
  const blocked = chunks.find((c) => c.promptFeedback?.blockReason)?.promptFeedback;
  const finishReason = chunks.map((c) => c.candidates?.[0]?.finishReason).filter(Boolean).at(-1);
  const hasCandidate = chunks.some((c) => (c.candidates?.length ?? 0) > 0);
  const usageMetadata = chunks.map((c) => c.usageMetadata).filter(Boolean).at(-1);
  const modelVersion = chunks.map((c) => c.modelVersion).filter(Boolean).at(-1);
  return {
    text,
    promptFeedback: blocked,
    candidates: hasCandidate ? [{ finishReason }] : [],
    usageMetadata,
    modelVersion,
  } as unknown as GenerateContentResponse;
}

export function interpretResponse(response: GenerateContentResponse, model: string, retries: number, durationMs: number): PlannerResponse {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new ProviderError({ provider: PROVIDER, kind: "safety", message: `Gemini blocked the request (${blockReason})` });
  }
  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason ? String(candidate.finishReason) : null;
  if (finishReason && SAFETY_FINISH_REASONS.has(finishReason)) {
    throw new ProviderError({ provider: PROVIDER, kind: "safety", message: `Gemini stopped generating for content-policy reasons (${finishReason})` });
  }
  if (!candidate) {
    throw new ProviderError({ provider: PROVIDER, kind: "bad-response", message: "Gemini returned no candidates" });
  }
  return {
    text: response.text ?? "",
    model: response.modelVersion ?? model,
    finishReason,
    usage: usageFrom(response),
    retries,
    durationMs,
  };
}

function usageFrom(response: GenerateContentResponse): TokenUsage | null {
  const u = response.usageMetadata;
  if (!u) return null;
  return {
    promptTokens: u.promptTokenCount ?? null,
    outputTokens: u.candidatesTokenCount ?? null,
    thinkingTokens: u.thoughtsTokenCount ?? null,
    totalTokens: u.totalTokenCount ?? null,
  };
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: Array<Record<string, unknown>> };
}

/** Turn an SDK/network error into a ProviderError with our retry policy's kind. */
export function classifyGeminiError(error: unknown, retryAfterHeaderMs: number | null, model: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = error instanceof ApiError ? error.status : typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : null;

  if (status === null) {
    const name = (error as { name?: string })?.name ?? "";
    const message = error instanceof Error ? error.message : String(error);
    const transient = /abort|timeout/i.test(name) || /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timed out/i.test(message);
    return new ProviderError({
      provider: PROVIDER,
      kind: transient ? "transient" : "bad-response",
      message: `Gemini request failed: ${shorten(message)}`,
    });
  }

  const body = parseErrorBody(error instanceof Error ? error.message : String(error));
  const apiMessage = body?.error?.message ?? (error instanceof Error ? error.message : String(error));
  const apiStatus = body?.error?.status ?? "";
  const details = body?.error?.details ?? [];
  const reasons = details.map((d) => String(d.reason ?? "")).filter(Boolean);
  const retryInfo = details.find((d) => String(d["@type"] ?? "").endsWith("RetryInfo"));
  const retryAfterMs = retryAfterHeaderMs ?? parseDuration(retryInfo?.retryDelay);
  const text = `Gemini API error ${status}${apiStatus ? ` ${apiStatus}` : ""}: ${shorten(apiMessage)}`;
  const make = (kind: ProviderError["kind"], message = text) => new ProviderError({ provider: PROVIDER, kind, status, retryAfterMs, message });

  if (reasons.includes("API_KEY_INVALID") || /api key (not valid|invalid|expired)/i.test(apiMessage) || status === 401) {
    return make("auth", `Gemini rejected the API key (${status}${apiStatus ? ` ${apiStatus}` : ""}). ${shorten(apiMessage)}`);
  }
  if (status === 403) return make("auth");
  if (status === 404 || (status === 400 && /model/i.test(apiMessage) && /not (found|supported)|unsupported|unknown/i.test(apiMessage))) {
    return make("model-unavailable", `Gemini model "${model}" is not available: ${shorten(apiMessage)}`);
  }
  if (status === 429 || status === 408 || status >= 500) return make("transient");
  return make("invalid-request");
}

function parseErrorBody(message: string): GoogleErrorBody | null {
  try {
    const parsed = JSON.parse(message) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as GoogleErrorBody) : null;
  } catch {
    return null;
  }
}

/** "17s" / "1.5s" -> ms */
function parseDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

function shorten(text: string, max = 400): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}...` : single;
}

// ---------- preflight --network (no generation) ----------

export interface GeminiModelInfo {
  id: string;
  displayName: string | null;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  supportsGenerateContent: boolean;
}

export type GeminiModelCheck =
  | { ok: true; model: GeminiModelInfo }
  | { ok: false; kind: ProviderError["kind"]; message: string; flashModels: GeminiModelInfo[] | null };

function toInfo(model: Model): GeminiModelInfo {
  return {
    id: (model.name ?? "").replace(/^models\//, ""),
    displayName: model.displayName ?? null,
    inputTokenLimit: model.inputTokenLimit ?? null,
    outputTokenLimit: model.outputTokenLimit ?? null,
    supportsGenerateContent: model.supportedActions?.includes("generateContent") ?? false,
  };
}

/**
 * Cheap auth + model check: models.get for the configured model (and models.list when it is
 * missing, to show which Flash-class models this key can use). Never calls generateContent.
 * Does not substitute another model.
 */
export async function checkGeminiModel(apiKey: string, model: string, baseFetch?: typeof fetch): Promise<GeminiModelCheck> {
  const { client, state } = createClient(apiKey, baseFetch);
  try {
    const info = toInfo(await client.models.get({ model }));
    if (!info.supportsGenerateContent) {
      return { ok: false, kind: "model-unavailable", message: `model "${model}" exists but does not support generateContent`, flashModels: await listFlashModels(client) };
    }
    return { ok: true, model: info };
  } catch (error) {
    const classified = classifyGeminiError(error, state.lastRetryAfterMs, model);
    if (classified.kind === "auth") return { ok: false, kind: "auth", message: classified.message, flashModels: null };
    let flashModels: GeminiModelInfo[] | null = null;
    try {
      flashModels = await listFlashModels(client);
    } catch {
      flashModels = null;
    }
    return { ok: false, kind: classified.kind, message: classified.message, flashModels };
  }
}

async function listFlashModels(client: GoogleGenAI): Promise<GeminiModelInfo[]> {
  const result: GeminiModelInfo[] = [];
  const pager = await client.models.list({ config: { pageSize: 100 } });
  for await (const model of pager) {
    const info = toInfo(model);
    if (info.supportsGenerateContent && /flash/i.test(info.id)) result.push(info);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
