/**
 * Provider error policy (PIPELINE_DESIGN.md §8):
 * - transient (timeouts, rate limits, 5xx, network): bounded retries, honoring Retry-After;
 * - invalid credentials, unknown/unsupported model, content/safety rejection, bad request: stop immediately.
 * Messages never contain secrets (they are also passed through redactSecrets before printing).
 */

export type ProviderErrorKind =
  | "auth"
  | "model-unavailable"
  | "safety"
  | "quota"
  | "voice-unavailable"
  | "account-restricted"
  | "budget"
  | "transient"
  | "invalid-request"
  | "bad-response";

export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  /** Server-requested wait before retrying, when supplied (Retry-After header or RetryInfo). */
  readonly retryAfterMs: number | null;

  constructor(opts: { provider: string; kind: ProviderErrorKind; message: string; status?: number | null; retryAfterMs?: number | null }) {
    super(opts.message);
    this.name = "ProviderError";
    this.provider = opts.provider;
    this.kind = opts.kind;
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }

  get retryable(): boolean {
    return this.kind === "transient";
  }
}

/** Plain-language advice shown with a fatal provider error. */
export function adviceFor(error: ProviderError): string {
  switch (error.kind) {
    case "auth":
      return "Check the API key in .env (it may be missing, mistyped, revoked or lacking permission). Nothing was retried.";
    case "model-unavailable":
      return "The configured model is not available for this key. Run `npm run pipeline -- preflight --network` to list available models, then set the model in .env.";
    case "safety":
      return "The provider refused the content (safety/content policy). Rephrase the topic notes; nothing was retried.";
    case "quota":
      return "The provider quota or rate limit is exhausted for now. Wait (see the provider dashboard) and try again later.";
    case "voice-unavailable":
      return "The configured voice ID was not found or is not usable with this key. Nothing was retried and no other voice was used. Check the voice ID in .env (run `npm run pipeline -- preflight --network`).";
    case "account-restricted":
      return "The provider account refused this request (e.g. library voices need a paid plan for API use, or unusual activity was detected). Nothing was retried and no other voice was used. Resolve it in the provider dashboard, or choose another voice yourself.";
    case "budget":
      return "The run's text-to-speech character budget would be exceeded, so the request was not sent. Raise --max-characters only if you mean to spend more.";
    case "transient":
      return "A temporary provider/network problem persisted after the allowed retries. Try again in a few minutes.";
    case "invalid-request":
      return "The provider rejected the request as invalid. This is a code or configuration problem; nothing was retried.";
    case "bad-response":
      return "The provider returned an unusable response.";
  }
}

/**
 * Parse a Retry-After header value (seconds or HTTP date) into milliseconds.
 * Returns null when absent or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
