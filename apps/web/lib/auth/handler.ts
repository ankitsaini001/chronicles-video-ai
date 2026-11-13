import { normalizeEmail, type LoginLock, type RateLimitResult } from "@bytereel/db";
import { findAllowedAuthEndpoint } from "./endpoints";
import { AUTH_MESSAGES, SIGN_IN_LIMITS, SIGN_UP_LIMITS } from "./messages";

// The /api/auth/* gatekeeper (docs/API.md §3). Every request passes these checks, in this order,
// before Better Auth sees it:
//   1. only the 6 documented endpoints (anything else: 404)
//   2. POST/PUT/PATCH/DELETE: Origin must be the app's own address (§3.6), and the body JSON
//   3. sign-up (A1): 5 requests per 15 minutes per IP (§3.7), then a strict body check
//      (name, email, password only; role/status/anything else: 400)
//   4. sign-in (A2): 5 per 15 minutes per IP, strict body (email, password, optional rememberMe
//      which is dropped), 5 per 15 minutes per email, account lock (10 wrong passwords in a row →
//      15 minutes), then Better Auth checks the password. Wrong email or wrong password get the
//      same 401; a lock gets the same 429 as the rate limits (no hint that the email exists).
//   5. get-session (A4): 120 per minute per IP
// Error bodies use Better Auth's shape { code, message } so the forms handle one shape.

export interface AuthHandlerDeps {
  /** Origins allowed to send mutating requests (the app's own). */
  appOrigins: readonly string[];
  /** Hands the request to Better Auth. */
  forward: (request: Request) => Promise<Response>;
  /** Counts one sign-up attempt for this IP address. */
  hitSignUpLimit: (ip: string) => Promise<RateLimitResult>;
  /** Counts one sign-in attempt for this IP address. */
  hitSignInIpLimit: (ip: string) => Promise<RateLimitResult>;
  /** Counts one sign-in attempt for this (lowercased) email. */
  hitSignInEmailLimit: (email: string) => Promise<RateLimitResult>;
  /** Counts one get-session request for this IP address. */
  hitGetSessionLimit: (ip: string) => Promise<RateLimitResult>;
  /** The account lock counters on `user` (packages/db login-guard). */
  loginGuard: {
    getLock: (email: string) => Promise<LoginLock>;
    recordFailure: (email: string) => Promise<unknown>;
    recordSuccess: (email: string) => Promise<void>;
  };
  /** Where to report a failed counter update (default: console.error). Never given the email. */
  logError?: (message: string, error: unknown) => void;
  /** True only on Vercel, which overwrites X-Forwarded-For with the real caller's address. */
  trustForwardedFor: boolean;
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

  if (endpoint.id === "A1") return signUp(request, deps);
  if (endpoint.id === "A2") return signIn(request, deps);
  if (endpoint.id === "A4") {
    const limit = await deps.hitGetSessionLimit(clientIp(request.headers, deps.trustForwardedFor));
    if (!limit.allowed) return tooManyAttempts(limit.retryAfterSeconds);
  }
  return deps.forward(request);
}

/** A1 sign-up. */
async function signUp(request: Request, deps: AuthHandlerDeps): Promise<Response> {
  const limit = await deps.hitSignUpLimit(clientIp(request.headers, deps.trustForwardedFor));
  if (!limit.allowed) return tooManyAttempts(limit.retryAfterSeconds);

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const checked = checkSignUpBody(body.value);
  if (!checked.ok) return authError(checked.status, checked.code, checked.message);

  // Better Auth gets only the cleaned fields.
  return renameSignUpErrors(await deps.forward(withJsonBody(request, checked.value)));
}

/** A2 sign-in. */
async function signIn(request: Request, deps: AuthHandlerDeps): Promise<Response> {
  const ipLimit = await deps.hitSignInIpLimit(clientIp(request.headers, deps.trustForwardedFor));
  if (!ipLimit.allowed) return tooManyAttempts(ipLimit.retryAfterSeconds);

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const checked = checkSignInBody(body.value);
  if (!checked.ok) return authError(checked.status, checked.code, checked.message);
  const { email } = checked.value;

  const emailLimit = await deps.hitSignInEmailLimit(email);
  if (!emailLimit.allowed) return tooManyAttempts(emailLimit.retryAfterSeconds);
  const lock = await deps.loginGuard.getLock(email);
  if (lock.locked) return tooManyAttempts(lock.retryAfterSeconds);

  // Better Auth gets only email + password (rememberMe dropped: sessions are always 30 days).
  const response = await deps.forward(withJsonBody(request, checked.value));
  const logError = deps.logError ?? defaultLogError;

  if (response.ok) {
    // Logged in. A failed counter reset must not undo a working login, so it is only reported.
    await deps.loginGuard.recordSuccess(email).catch((error: unknown) => logError("Log in: could not reset the failed-login counter.", error));
    return response;
  }
  if (response.status === 401 && (await errorCodeOf(response)) === "INVALID_EMAIL_OR_PASSWORD") {
    // Wrong email or wrong password: one answer for both. Counts towards the lock (if the account exists).
    await deps.loginGuard.recordFailure(email).catch((error: unknown) => logError("Log in: could not count a failed login.", error));
    return authError(401, "INVALID_EMAIL_OR_PASSWORD", AUTH_MESSAGES.INVALID_EMAIL_OR_PASSWORD);
  }
  // e.g. 403 ACCOUNT_SUSPENDED (correct password, account not active): neither a failure nor a success.
  return response;
}

/** API.md §2: at most 64 KB, valid JSON. Returns the parsed value or the error answer. */
async function readJsonBody(request: Request): Promise<{ value: unknown } | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return authError(413, "PAYLOAD_TOO_LARGE", AUTH_MESSAGES.INVALID_INPUT);
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return authError(413, "PAYLOAD_TOO_LARGE", AUTH_MESSAGES.INVALID_INPUT);
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return authError(400, "INVALID_INPUT", AUTH_MESSAGES.INVALID_INPUT);
  }
}

/** A copy of the request with a new JSON body. */
function withJsonBody(request: Request, value: unknown): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: JSON.stringify(value) });
}

function tooManyAttempts(retryAfterSeconds: number): Response {
  return authError(429, "TOO_MANY_ATTEMPTS", AUTH_MESSAGES.TOO_MANY_ATTEMPTS, { "Retry-After": String(retryAfterSeconds) });
}

async function errorCodeOf(response: Response): Promise<unknown> {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return undefined;
  const body = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
  return body?.code;
}

function defaultLogError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : error);
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

export type SignInBody = { email: string; password: string };
type CheckedSignIn = { ok: true; value: SignInBody } | { ok: false; status: 400; code: string; message: string };

const SIGN_IN_KEYS = new Set(["email", "password", "rememberMe"]);

/**
 * API.md A2 body: email (valid, ≤ 254, lowercased) and password (1–128). `rememberMe` may be sent
 * as a boolean but is dropped (sessions are always 30 days). Any other field is refused.
 */
export function checkSignInBody(body: unknown): CheckedSignIn {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalidSignIn("INVALID_INPUT", AUTH_MESSAGES.INVALID_INPUT);
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => !SIGN_IN_KEYS.has(k));
  if (extra.length > 0) return invalidSignIn("INVALID_INPUT", `These fields can't be sent: ${extra.slice(0, 5).join(", ")}.`);
  if ("rememberMe" in record && typeof record.rememberMe !== "boolean") return invalidSignIn("INVALID_INPUT", AUTH_MESSAGES.INVALID_INPUT);

  const email = normalizeEmail(typeof record.email === "string" ? record.email : "");
  if (!email.ok) return invalidSignIn("INVALID_EMAIL", AUTH_MESSAGES.INVALID_EMAIL);

  const password = record.password;
  if (typeof password !== "string" || password.length < 1 || password.length > SIGN_IN_LIMITS.passwordMax) {
    return invalidSignIn("INVALID_INPUT", AUTH_MESSAGES.INVALID_INPUT);
  }
  return { ok: true, value: { email: email.email, password } };
}

function invalidSignIn(code: string, message: string): CheckedSignIn {
  return { ok: false, status: 400, code, message };
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
 * The caller's IP address for the rate limit.
 * - On Vercel, X-Forwarded-For is written by Vercel itself (a caller can't fake it): use it.
 * - Anywhere else (your computer, `next start`), the header is whatever the caller sent, so it is
 *   ignored and all requests share one counter. Faking an address must never buy more attempts.
 */
export const SHARED_IP_BUCKET = "untrusted-network";

export function clientIp(headers: Headers, trustForwardedFor: boolean): string {
  if (!trustForwardedFor) return SHARED_IP_BUCKET;
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || SHARED_IP_BUCKET;
}

/** Better Auth's duplicate-email error, renamed to the API.md code and wording. */
async function renameSignUpErrors(response: Response): Promise<Response> {
  if (response.ok) return response;
  const code = await errorCodeOf(response);
  if (code !== "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" && code !== "USER_ALREADY_EXISTS") return response;
  return authError(422, "USER_ALREADY_EXISTS", AUTH_MESSAGES.USER_ALREADY_EXISTS);
}

export function authError(status: number, code: string, message: string, extraHeaders: Record<string, string> = {}): Response {
  return Response.json({ code, message }, { status, headers: { "Cache-Control": "no-store", ...extraHeaders } });
}
