// Calls from the storyboard screen and the My videos cards to /api/v1 (browser only; F17–F21). Every change sends the
// project's `stateVersion` the page was loaded with, so another tab's change is never silently
// overwritten: the server answers 409 STALE_VERSION and the screen offers "Refresh".
// F26 (founder test): every call gives up after SEND_TIMEOUT_MS, so a server that never answers
// can't leave a button locked with no message. A timed-out change keeps its Idempotency-Key (like
// OFFLINE), so sending the same click again can never start the work twice.

export type ApiAnswer<T = Record<string, unknown>> =
  | { ok: true; status: number; json: T }
  | { ok: false; status: number; code: string; message: string; details: Record<string, unknown> | undefined };

export const CLIENT_MESSAGES = {
  OFFLINE: "Couldn't reach the server. Check your internet connection and try again.",
  TIMEOUT: "No answer from the server. Please try again.",
  INTERNAL: "Something went wrong on our side. Please try again.",
  STALE: "This project changed in another tab, refresh.",
} as const;

/** How long one call waits for the server's whole answer before giving up (every call here is quick). */
export const SEND_TIMEOUT_MS = 30_000;

/** 503 errors whose message is shown as is (API.md §4.3); any other 5xx shows the generic text. */
const SHOWN_503_CODES = ["SPEND_CEILING", "PROVIDER_BUSY", "MAINTENANCE"];

/** A random Idempotency-Key for one click (API.md §6); re-sent only for a retry of that same click. */
export function newIdempotencyKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function apiSend<T = Record<string, unknown>>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<ApiAnswer<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    text = await response.text();
  } catch {
    return controller.signal.aborted
      ? { ok: false, status: 0, code: "TIMEOUT", message: CLIENT_MESSAGES.TIMEOUT, details: undefined }
      : { ok: false, status: 0, code: "OFFLINE", message: CLIENT_MESSAGES.OFFLINE, details: undefined };
  } finally {
    clearTimeout(timer);
  }
  const json = parseJson(text);
  if (response.ok) return { ok: true, status: response.status, json: json as T };
  if (response.status === 401) window.location.assign("/login");
  const error = (json.error ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
  // A few 503 answers carry a message meant for the creator (e.g. "Voice limit reached this month.").
  const plain503 = response.status === 503 && SHOWN_503_CODES.includes(error.code ?? "");
  return {
    ok: false,
    status: response.status,
    code: error.code ?? "INTERNAL",
    message: response.status >= 500 && !plain503 ? CLIENT_MESSAGES.INTERNAL : (error.message ?? CLIENT_MESSAGES.INTERNAL),
    details: error.details,
  };
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
