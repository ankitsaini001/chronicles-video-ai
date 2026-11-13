import type { RateLimitResult, RateLimitRule } from "@bytereel/db";
import { isSameOrigin } from "../auth/handler";
import type { SessionUser } from "../auth/session";

// The shared request pipeline for every /api/v1 endpoint (docs/API.md §1 "Request pipeline"):
//   request id → Origin check (POST/PUT/PATCH/DELETE) → session (status active) → rate limit per
//   user → the endpoint's own work → JSON answer.
// Every answer carries `X-Request-Id` and `Cache-Control: no-store` (API.md §2). Errors use the
// envelope { error: { code, message, details?, requestId } } (API.md §4.1). Unexpected errors
// become 500 INTERNAL with a plain message; the details go to the server log only.
// Kept free of Next.js and of the real database so the tests can run it with fakes
// (lib/api/server.ts builds the real dependencies).

export type ApiErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_INPUT" | "RATE_LIMITED" | "INTERNAL";

/** Default messages (API.md §3.6, §3.8, §4.3, §10.3). */
export const API_MESSAGES = {
  UNAUTHENTICATED: "Please log in again.",
  FORBIDDEN_ORIGIN: "Please reload the page and try again.",
  RATE_LIMITED: "You're going a bit fast. Please wait a minute.",
  INTERNAL: "Something went wrong on our side. Please try again.",
} as const;

export interface ApiDeps {
  /** Origins allowed to send mutating requests (the app's own, API.md §3.6). */
  appOrigins: readonly string[];
  /** The signed-in, `active` user for this request, or null (API.md §3.1). */
  getUser: (request: Request) => Promise<SessionUser | null>;
  /** Counts one request for this rule and user. */
  hitRateLimit: (rule: RateLimitRule, userId: string) => Promise<RateLimitResult>;
  /** Where unexpected errors are reported (default: console.error). */
  logError?: (message: string, error: unknown) => void;
  /** Makes a new request id (tests pass a fixed one). */
  newRequestId?: () => string;
}

export interface ApiContext {
  request: Request;
  user: SessionUser;
  requestId: string;
}

// TODO (F11 review), before the first POST/PATCH endpoint (B2 or C2), add as ApiEndpoint options,
// enforced in handleApiRequest:
//   - JSON Content-Type required for bodies → 400 INVALID_INPUT (API.md §3.6)
//   - 64 KB body cap → 413 PAYLOAD_TOO_LARGE, counted while streaming (like readTextUpTo in
//     lib/auth/handler.ts), also without Content-Length (API.md §2)
//   - Origin check opt-out, only for the Meta callbacks / anonymous J3 (verified by signature)
//   - admin role check for /api/v1/admin/* → 403 FORBIDDEN, details.reason "admin_only"
export interface ApiEndpoint {
  /** The short-window limit for this endpoint (API.md §10.3), counted per user. */
  rateLimit: RateLimitRule;
  /** The endpoint's work. Return a plain value (sent as 200 JSON) or a ready Response. */
  handle: (context: ApiContext) => Promise<unknown>;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Runs one /api/v1 request through the shared pipeline. */
export async function handleApiRequest(request: Request, endpoint: ApiEndpoint, deps: ApiDeps): Promise<Response> {
  const requestId = requestIdFor(request.headers, deps.newRequestId ?? newRequestId);
  const logError = deps.logError ?? defaultLogError;
  try {
    if (MUTATING.has(request.method) && !isSameOrigin(request.headers, deps.appOrigins)) {
      return apiError(403, "FORBIDDEN", API_MESSAGES.FORBIDDEN_ORIGIN, requestId, { details: { reason: "origin_mismatch" } });
    }

    const user = await deps.getUser(request);
    if (!user) return apiError(401, "UNAUTHENTICATED", API_MESSAGES.UNAUTHENTICATED, requestId);

    const limit = await deps.hitRateLimit(endpoint.rateLimit, user.id);
    if (!limit.allowed) {
      return apiError(429, "RATE_LIMITED", API_MESSAGES.RATE_LIMITED, requestId, {
        details: { retryAfterSeconds: limit.retryAfterSeconds },
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      });
    }

    const result = await endpoint.handle({ request, user, requestId });
    if (result instanceof Response) {
      // A copy: some Responses (e.g. Response.redirect) have read-only headers.
      const response = new Response(result.body, result);
      response.headers.set("X-Request-Id", requestId);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    return apiJson(result, requestId);
  } catch (error) {
    logError(`API ${request.method} ${new URL(request.url).pathname} failed (request ${requestId}).`, error);
    return apiError(500, "INTERNAL", API_MESSAGES.INTERNAL, requestId);
  }
}

/** A success answer (API.md §2: the resource itself, no wrapper). */
export function apiJson(body: unknown, requestId: string, status = 200): Response {
  return Response.json(body, { status, headers: commonHeaders(requestId) });
}

/** An error answer in the /api/v1 envelope (API.md §4.1). */
export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  options: { details?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Response {
  const error = options.details ? { code, message, details: options.details, requestId } : { code, message, requestId };
  return Response.json({ error }, { status, headers: { ...commonHeaders(requestId), ...options.headers } });
}

function commonHeaders(requestId: string): Record<string, string> {
  return { "Cache-Control": "no-store", "X-Request-Id": requestId };
}

/** API.md §2: the client may send its own id (≤ 64 characters, letters, digits and "-"). */
const CLIENT_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export function requestIdFor(headers: Headers, make: () => string = newRequestId): string {
  const sent = headers.get("x-request-id");
  return sent !== null && CLIENT_REQUEST_ID.test(sent) ? sent : make();
}

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, like the examples

/** "req_" + 16 random characters, e.g. "req_01JCXK70B4M2QR7T". */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let id = "req_";
  for (const byte of bytes) id += ID_ALPHABET[byte % 32];
  return id;
}

function defaultLogError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : error);
}
