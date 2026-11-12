import { CharacterAlignmentSchema, type CharacterAlignment, type VoiceSettings } from "../contracts";
import { parseRetryAfter, ProviderError, type ProviderErrorKind } from "./errors";
import { withRetries, type RetryOptions } from "./retry";

/**
 * Speech provider boundary (PIPELINE_DESIGN.md §6, §8 "Speech") and the ElevenLabs adapter.
 *
 * ElevenLabs: POST /v1/text-to-speech/{voice_id}/with-timestamps (documented REST endpoint; no SDK
 * dependency, same pattern as the read-only client). One request per scene. The voice ID comes
 * from configuration only: there is NO fallback voice, so a missing/refused voice stops the run.
 *
 * Error policy: transient failures (network, timeout, 429 busy/concurrency, 5xx) get at most 2
 * retries honoring Retry-After. Invalid key, missing permission, voice not found, quota exceeded,
 * unusual activity, paid-plan-only (library) voices and invalid requests stop immediately.
 * `beforeAttempt` runs before EVERY attempt (retries included) so the caller can count characters
 * and enforce a budget before anything is sent. The API key goes only into the xi-api-key header.
 */

export const ELEVENLABS_PROVIDER = "elevenlabs";
const BASE_URL = "https://api.elevenlabs.io";
const TIMEOUT_MS = 120_000;

export interface SpeechRequest {
  voiceId: string;
  modelId: string;
  text: string;
  previousText: string | null;
  nextText: string | null;
  settings: VoiceSettings;
  outputFormat: string;
  seed: number | null;
  applyTextNormalization: "auto" | "on" | "off";
}

export interface SpeechResponse {
  audio: Uint8Array;
  alignment: CharacterAlignment | null;
  normalizedAlignment: CharacterAlignment | null;
  requestId: string | null;
  /** Characters the provider says it charged (x-character-count), when reported. */
  characterCost: number | null;
  retries: number;
  durationMs: number;
}

export interface SpeechCallOptions {
  /** Called before every attempt (the first and each retry). Throw to stop before sending. */
  beforeAttempt?: (attempt: number) => Promise<void> | void;
  retry?: RetryOptions;
}

export interface SpeechProvider {
  readonly name: string;
  synthesize(request: SpeechRequest, options?: SpeechCallOptions): Promise<SpeechResponse>;
}

export class ElevenLabsSpeech implements SpeechProvider {
  readonly name = ELEVENLABS_PROVIDER;

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async synthesize(request: SpeechRequest, options: SpeechCallOptions = {}): Promise<SpeechResponse> {
    if (!/^[A-Za-z0-9]{1,64}$/.test(request.voiceId)) {
      throw new ProviderError({ provider: ELEVENLABS_PROVIDER, kind: "invalid-request", message: `voice ID "${request.voiceId}" has unexpected characters` });
    }
    const started = Date.now();
    let attempt = 0;
    const result = await withRetries(async () => {
      attempt++;
      await options.beforeAttempt?.(attempt);
      return this.once(request);
    }, options.retry ?? {});
    return { ...result, retries: attempt - 1, durationMs: Date.now() - started };
  }

  private async once(request: SpeechRequest): Promise<Omit<SpeechResponse, "retries" | "durationMs">> {
    const url = `${BASE_URL}/v1/text-to-speech/${request.voiceId}/with-timestamps?output_format=${encodeURIComponent(request.outputFormat)}`;
    const body: Record<string, unknown> = {
      text: request.text,
      model_id: request.modelId,
      voice_settings: request.settings,
      apply_text_normalization: request.applyTextNormalization,
    };
    if (request.previousText) body.previous_text = request.previousText;
    if (request.nextText) body.next_text = request.nextText;
    if (request.seed !== null) body.seed = request.seed;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "xi-api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderError({ provider: ELEVENLABS_PROVIDER, kind: "transient", message: `ElevenLabs text-to-speech request failed: ${(error as Error).message}` });
    }
    if (!response.ok) throw await speechError(response);

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      throw new ProviderError({ provider: ELEVENLABS_PROVIDER, kind: "bad-response", message: `ElevenLabs returned unreadable JSON: ${(error as Error).message}` });
    }
    if (typeof json.audio_base64 !== "string" || json.audio_base64.length === 0) {
      throw new ProviderError({ provider: ELEVENLABS_PROVIDER, kind: "bad-response", message: "ElevenLabs response has no audio_base64" });
    }
    const cost = response.headers.get("x-character-count") ?? response.headers.get("character-cost");
    return {
      audio: new Uint8Array(Buffer.from(json.audio_base64, "base64")),
      alignment: parseAlignment(json.alignment, "alignment"),
      normalizedAlignment: parseAlignment(json.normalized_alignment, "normalized_alignment"),
      requestId: response.headers.get("request-id") ?? response.headers.get("x-request-id"),
      characterCost: cost !== null && /^\d+$/.test(cost.trim()) ? Number(cost.trim()) : null,
    };
  }
}

function parseAlignment(value: unknown, field: string): CharacterAlignment | null {
  if (value === null || value === undefined) return null;
  const parsed = CharacterAlignmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderError({ provider: ELEVENLABS_PROVIDER, kind: "bad-response", message: `ElevenLabs ${field} has an unexpected shape` });
  }
  return parsed.data;
}

/** Map an ElevenLabs error response to our error policy (pure; unit-tested). */
export function classifySpeechError(status: number, detailStatus: string | null, message: string): ProviderErrorKind {
  const code = (detailStatus ?? "").toLowerCase();
  const text = `${code} ${message}`.toLowerCase();
  if (/unusual.?activity|free users cannot use library voices|library voice|paid_plan_required|payment_required|subscription.*required|upgrade your subscription/.test(text) || status === 402) {
    return "account-restricted";
  }
  if (/voice_not_found|voice.*(not found|does not exist)|voice_not_fine_tuned|invalid voice/.test(text)) return "voice-unavailable";
  if (/quota_exceeded|quota|character limit|credits?/.test(text) && status !== 429 && status < 500) return "quota";
  if (/model_not_found|model.*not (found|available)|invalid model/.test(text)) return "model-unavailable";
  if (/invalid_api_key|missing_permissions|unauthori[sz]ed|api key/.test(text) || status === 401 || status === 403) return "auth";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  if (status === 404) return "voice-unavailable"; // the only path parameter is the voice ID
  return "invalid-request";
}

async function speechError(response: Response): Promise<ProviderError> {
  const status = response.status;
  let detailStatus: string | null = null;
  let detail = "";
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      const d = parsed.detail;
      if (typeof d === "string") detail = d;
      else if (Array.isArray(d)) detail = d.map((x) => (x && typeof x === "object" && "msg" in x ? String((x as { msg: unknown }).msg) : String(x))).join("; ");
      else if (d && typeof d === "object") {
        const obj = d as { status?: unknown; code?: unknown; message?: unknown };
        detailStatus = typeof obj.status === "string" ? obj.status : typeof obj.code === "string" ? obj.code : null;
        detail = [detailStatus, typeof obj.message === "string" ? obj.message : null].filter(Boolean).join(": ");
      }
    } catch {
      detail = text.replace(/\s+/g, " ");
    }
  } catch {
    // no body
  }
  detail = detail.slice(0, 300);
  const kind = classifySpeechError(status, detailStatus, detail);
  return new ProviderError({
    provider: ELEVENLABS_PROVIDER,
    kind,
    status,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    message: `ElevenLabs text-to-speech failed (${status})${detail ? `: ${detail}` : ""}`,
  });
}
