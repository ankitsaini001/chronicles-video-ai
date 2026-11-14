// Calls from the storyboard screen to /api/v1 (browser only; F17–F20). Every change sends the
// project's `stateVersion` the page was loaded with, so another tab's change is never silently
// overwritten: the server answers 409 STALE_VERSION and the screen offers "Refresh".

export type ApiAnswer<T = Record<string, unknown>> =
  | { ok: true; status: number; json: T }
  | { ok: false; status: number; code: string; message: string; details: Record<string, unknown> | undefined };

export const CLIENT_MESSAGES = {
  OFFLINE: "Couldn't reach the server. Check your internet connection and try again.",
  INTERNAL: "Something went wrong on our side. Please try again.",
  STALE: "This project changed in another tab, refresh.",
} as const;

/** A random Idempotency-Key for one click (API.md §6); re-sent only for a retry of that same click. */
export function newIdempotencyKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function apiSend<T = Record<string, unknown>>(method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiAnswer<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, code: "OFFLINE", message: CLIENT_MESSAGES.OFFLINE, details: undefined };
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return { ok: true, status: response.status, json: json as T };
  if (response.status === 401) window.location.assign("/login");
  const error = (json.error ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
  return {
    ok: false,
    status: response.status,
    code: error.code ?? "INTERNAL",
    message: response.status >= 500 ? CLIENT_MESSAGES.INTERNAL : (error.message ?? CLIENT_MESSAGES.INTERNAL),
    details: error.details,
  };
}
