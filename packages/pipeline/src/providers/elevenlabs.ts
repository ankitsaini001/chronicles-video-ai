import { parseRetryAfter, ProviderError } from "./errors";

/**
 * ElevenLabs checks for `preflight --network` (P2a). Only free, read-only endpoints:
 * GET /v1/models and GET /v1/voices/{voice_id}. NO text-to-speech call is made here
 * (speech generation lives in speech.ts). The API key is sent only in the xi-api-key header
 * and never logged.
 */

const PROVIDER = "elevenlabs";
const BASE_URL = "https://api.elevenlabs.io";
const TIMEOUT_MS = 20_000;

export interface ElevenLabsModelInfo {
  id: string;
  name: string | null;
  canDoTextToSpeech: boolean;
  languages: string[];
}

export interface ElevenLabsVoiceInfo {
  id: string;
  name: string | null;
  category: string | null;
  labels: Record<string, string>;
}

export class ElevenLabsReadClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async listModels(): Promise<ElevenLabsModelInfo[]> {
    const body = await this.getJson("/v1/models");
    if (!Array.isArray(body)) throw new ProviderError({ provider: PROVIDER, kind: "bad-response", message: "unexpected /v1/models response" });
    return body.map((m: Record<string, unknown>) => ({
      id: String(m.model_id ?? ""),
      name: typeof m.name === "string" ? m.name : null,
      canDoTextToSpeech: m.can_do_text_to_speech === true,
      languages: Array.isArray(m.languages) ? m.languages.map((l: { name?: unknown }) => String(l?.name ?? "")).filter(Boolean) : [],
    }));
  }

  /**
   * Character usage of the account (GET /v1/user/subscription, read-only, free). Returns null when
   * the key lacks permission to read it; never throws for that case.
   */
  async getCharacterUsage(): Promise<{ used: number; limit: number; resetsAt: string | null; tier: string | null } | null> {
    try {
      const s = (await this.getJson("/v1/user/subscription")) as Record<string, unknown>;
      if (typeof s.character_count !== "number" || typeof s.character_limit !== "number") return null;
      const reset = typeof s.next_character_count_reset_unix === "number" ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null;
      return { used: s.character_count, limit: s.character_limit, resetsAt: reset, tier: typeof s.tier === "string" ? s.tier : null };
    } catch (error) {
      if (error instanceof ProviderError && error.kind !== "transient") return null;
      throw error;
    }
  }

  /**
   * Look up a voice. Returns `{ found: false }` with the provider's status/detail when the voice
   * does not exist or is not accessible to this key (404/400); other errors are thrown.
   */
  async getVoice(voiceId: string): Promise<{ found: true; voice: ElevenLabsVoiceInfo } | { found: false; status: number; detail: string }> {
    if (!/^[A-Za-z0-9]{1,64}$/.test(voiceId)) {
      throw new ProviderError({ provider: PROVIDER, kind: "invalid-request", message: `voice ID "${voiceId}" has unexpected characters` });
    }
    try {
      const v = (await this.getJson(`/v1/voices/${voiceId}`)) as Record<string, unknown>;
      const labels = v.labels && typeof v.labels === "object" ? (v.labels as Record<string, unknown>) : {};
      return {
        found: true,
        voice: {
          id: voiceId,
          name: typeof v.name === "string" ? v.name : null,
          category: typeof v.category === "string" ? v.category : null,
          labels: Object.fromEntries(Object.entries(labels).map(([k, val]) => [k, String(val)])),
        },
      };
    } catch (error) {
      if (error instanceof ProviderError && (error.status === 404 || error.status === 400)) {
        return { found: false, status: error.status, detail: error.message };
      }
      throw error;
    }
  }

  private async getJson(pathname: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${BASE_URL}${pathname}`, {
        method: "GET",
        headers: { "xi-api-key": this.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderError({ provider: PROVIDER, kind: "transient", message: `ElevenLabs request failed: ${(error as Error).message}` });
    }
    if (response.ok) return response.json();
    const detail = await errorDetail(response);
    const status = response.status;
    const kind = status === 401 || status === 403 ? "auth" : status === 429 || status >= 500 ? "transient" : "invalid-request";
    throw new ProviderError({
      provider: PROVIDER,
      kind,
      status,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      message: `ElevenLabs ${pathname.startsWith("/v1/voices/") ? "voice lookup" : pathname.startsWith("/v1/user") ? "subscription lookup" : "models list"} failed (${status})${detail ? `: ${detail}` : ""}`,
    });
  }
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      const d = parsed.detail;
      if (typeof d === "string") return d.slice(0, 300);
      if (d && typeof d === "object") {
        const obj = d as { status?: unknown; message?: unknown };
        return [obj.status, obj.message].filter((x) => typeof x === "string").join(": ").slice(0, 300);
      }
    } catch {
      // not JSON
    }
    return text.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return "";
  }
}
