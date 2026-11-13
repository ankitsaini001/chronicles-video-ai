import { normalizeEmail, type RateLimitResult } from "@bytereel/db";
import { findAllowedAuthEndpoint } from "./endpoints";
import { AUTH_MESSAGES, SIGN_UP_LIMITS } from "./messages";

// The /api/auth/* gatekeeper (docs/API.md §3). Every request passes these checks, in this order,
// before Better Auth sees it:
//   1. only the 6 documented endpoints (anything else: 404)
//   2. POST/PUT/PATCH/DELETE: Origin must be the app's own address (§3.6), and the body JSON
//   3. sign-up: 5 requests per 15 minutes per IP (§3.7), then a strict body check
//      (name, email, password only; role/status/anything else: 400)
// Error bodies use Better Auth's shape { code, message } so the forms handle one shape.

export interface AuthHandlerDeps {
  /** Origins allowed to send mutating requests (the app's own). */
  appOrigins: readonly string[];
  /** Hands the request to Better Auth. */
  forward: (request: Request) => Promise<Response>;
  /** Counts one sign-up attempt for this IP address. */
  hitSignUpLimit: (ip: string) => Promise<RateLimitResult>;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** API.md §2: max 64 KB per JSON request. */
export const MAX_BODY_BYTES = 64 * 1024;

export async function handleAuthRequest(request: Request, deps: AuthHandlerDeps): Promise<Response> {
  const url = new URL(request.url);
  const endpoint = findAllowedAuthEndpoint(request.method, url.pathname);
  if (!endpoint) return authError(404, "NOT_FOUND", "Not found.");

  if (MUTATING.has(request.method)) {
    if (!isSameOrigin(request.headers, deps.appOrigins)) return authError(403, "FORBIDDEN_ORIGIN", AUTH_MESSAGES.FORBIDDEN_ORIGIN);
    if (!isJson(request.headers)) return authError(400, "INVALID_INPUT", AUTH_MESSAGES.INVALID_INPUT);
  }

  if (endpoint.id !== "A1") return deps.forward(request);

  // A1 sign-up.
  const limit = await deps.hitSignUpLimit(clientIp(request.headers));
  if (!limit.allowed) {
    return authError(429, "TOO_MANY_ATTEMPTS", AUTH_MESSAGES.TOO_MANY_ATTEMPTS, { "Retry-After": String(limit.retryAfterSeconds) });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return authError(413, "PAYLOAD_TOO_LARGE", AUTH_MESSAGES.INVALID_INPUT);
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return authError(413, "PAYLOAD_TOO_LARGE", AUTH_MESSAGES.INVALID_INPUT);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return authError(400, "INVALID_INPUT", AUTH_MESSAGES.INVALID_INPUT);
  }
  const checked = checkSignUpBody(body);
  if (!checked.ok) return authError(checked.status, checked.code, checked.message);

  // Better Auth gets only the cleaned fields.
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const cleaned = new Request(request.url, { method: "POST", headers, body: JSON.stringify(checked.value) });
  return renameSignUpErrors(await deps.forward(cleaned));
}

export type SignUpBody = { name: string; email: string; password: string };
type Checked = { ok: true; value: SignUpBody } | { ok: false; status: 400; code: string; message: string };

const SIGN_UP_KEYS = new Set(["name", "email", "password"]);

/**
 * API.md A1 body: exactly name (1–80, trimmed), email (valid, ≤ 254, lowercased) and password
 * (8–128). Any other field (role, status, image, callbackURL, rememberMe, …) is refused.
 */
export function checkSignUpBody(body: unknown): Checked {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid("INVALID_INPUT", AUTH_MESSAGES.INVALID_INPUT);
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => !SIGN_UP_KEYS.has(k));
  if (extra.length > 0) return invalid("INVALID_INPUT", `These fields can't be sent: ${extra.slice(0, 5).join(", ")}.`);

  const name = typeof record.name === "string" ? record.name.normalize("NFC").trim() : "";
  if (name.length < 1 || name.length > SIGN_UP_LIMITS.nameMax) return invalid("INVALID_INPUT", AUTH_MESSAGES.INVALID_NAME);

  const email = normalizeEmail(typeof record.email === "string" ? record.email : "");
  if (!email.ok) return invalid("INVALID_EMAIL", AUTH_MESSAGES.INVALID_EMAIL);

  const password = record.password;
  if (typeof password !== "string") return invalid("INVALID_INPUT", AUTH_MESSAGES.PASSWORD_LENGTH);
  if (password.length < SIGN_UP_LIMITS.passwordMin) return invalid("PASSWORD_TOO_SHORT", AUTH_MESSAGES.PASSWORD_LENGTH);
  if (password.length > SIGN_UP_LIMITS.passwordMax) return invalid("PASSWORD_TOO_LONG", AUTH_MESSAGES.PASSWORD_LENGTH);

  return { ok: true, value: { name, email: email.email, password } };
}

function invalid(code: string, message: string): Checked {
  return { ok: false, status: 400, code, message };
}

/**
 * API.md §3.6: the Origin header must be the app's own origin. Without an Origin header, the
 * browser's `Sec-Fetch-Site: same-origin` is accepted instead. Anything else is refused.
 */
export function isSameOrigin(headers: Headers, appOrigins: readonly string[]): boolean {
  const origin = headers.get("origin");
  if (origin !== null) return appOrigins.includes(origin);
  return headers.get("sec-fetch-site") === "same-origin";
}

function isJson(headers: Headers): boolean {
  const type = headers.get("content-type") ?? "";
  return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * The caller's IP address for the rate limit. On Vercel `x-forwarded-for` is set by Vercel itself.
 * The LAST entry is used: a proxy (also `next start`) appends the address it really saw, so a
 * caller can't pick a fresh IP by sending the header.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").map((p) => p.trim()).filter(Boolean).at(-1);
  return last || headers.get("x-real-ip")?.trim() || "unknown";
}

/** Better Auth's duplicate-email error, renamed to the API.md code and wording. */
async function renameSignUpErrors(response: Response): Promise<Response> {
  if (response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  const body = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
  if (body?.code !== "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" && body?.code !== "USER_ALREADY_EXISTS") return response;
  return authError(422, "USER_ALREADY_EXISTS", AUTH_MESSAGES.USER_ALREADY_EXISTS);
}

export function authError(status: number, code: string, message: string, extraHeaders: Record<string, string> = {}): Response {
  return Response.json({ code, message }, { status, headers: { "Cache-Control": "no-store", ...extraHeaders } });
}
