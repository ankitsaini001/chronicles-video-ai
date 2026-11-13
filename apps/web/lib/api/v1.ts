import { createHash } from "node:crypto";
import type { RateLimitResult, RateLimitRule } from "@bytereel/db";
import { isSameOrigin } from "../auth/handler";
import type { SessionUser } from "../auth/session";

// The shared request pipeline for every /api/v1 endpoint (docs/API.md §1 "Request pipeline"):
//   request id → Origin check (POST/PUT/PATCH/DELETE) → session (status active) → rate limit per
//   user → JSON body checks (Content-Type, 64 KB, strict validation) → Idempotency-Key (only for
//   endpoints that need one) → the endpoint's own work → JSON answer.
// Every answer carries `X-Request-Id` and `Cache-Control: no-store` (API.md §2). Errors use the
// envelope { error: { code, message, details?, requestId } } (API.md §4.1). Unexpected errors
// become 500 INTERNAL with a plain message; the details go to the server log only.
// Kept free of Next.js and of the real database so the tests can run it with fakes
// (lib/api/server.ts builds the real dependencies).
//
// Still to add when the first endpoint needs it (F11 review):
//   - Origin check opt-out, only for the Meta callbacks / anonymous J3 (verified by signature)
//   - admin role check for /api/v1/admin/* → 403 FORBIDDEN, details.reason "admin_only"

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "PAYLOAD_TOO_LARGE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "INTERNAL";

/** Default messages (API.md §3.6, §3.8, §4.3, §10.3, openapi.yaml responses). */
export const API_MESSAGES = {
  UNAUTHENTICATED: "Please log in again.",
  FORBIDDEN_ORIGIN: "Please reload the page and try again.",
  INVALID_INPUT: "Please check the highlighted fields.",
  /** A request the page itself builds is wrong (Content-Type, Idempotency-Key, not JSON). */
  INVALID_REQUEST: "Please reload the page and try again.",
  PAYLOAD_TOO_LARGE: "This request is too large.",
  IDEMPOTENCY_KEY_REUSED: "This request key was already used for a different request.",
  IDEMPOTENCY_IN_PROGRESS: "Still working on your previous click. Please wait a moment.",
  RATE_LIMITED: "You're going a bit fast. Please wait a minute.",
  INTERNAL: "Something went wrong on our side. Please try again.",
} as const;

/** API.md §2: at most 64 KB per JSON request body. */
export const MAX_BODY_BYTES = 64 * 1024;

/** API.md §6: 8–128 characters of letters, digits, "_", ":" and "-". */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:-]{8,128}$/;

/** One problem in a request, as sent in `details.issues` (API.md §4.1). */
export type InputIssue = { path: string; message: string };

/**
 * A body validator. Any Zod schema fits (only `safeParse` is used), so this file doesn't need Zod.
 */
export interface BodySchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly SchemaIssue[] } };
}
type SchemaIssue = { path: readonly PropertyKey[]; message: string; code?: string; keys?: readonly string[] };

/** Proof that this request owns its idempotency record (DATABASE.md §4.13: id + this check-in's lockId). */
export type IdempotencyLock = { recordId: string; lockId: string };

/** What happened when an Idempotency-Key was checked in (DATABASE.md §4.13). */
export type IdempotencyBegin =
  | ({ kind: "new" } & IdempotencyLock)
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "reused" }
  | { kind: "in_progress" };

/** Where Idempotency-Keys are remembered (the `idempotencyKeys` collection in production). */
export interface IdempotencyStore {
  /** Check a key in. `fingerprint` proves a repeat is the same request. */
  begin(userId: string, key: string, fingerprint: string): Promise<IdempotencyBegin>;
  /**
   * Save the answer, so a repeat gets it again. Does nothing if the record was already saved or
   * another request took it over (it no longer has this lockId).
   */
  finish(lock: IdempotencyLock, status: number, body: unknown): Promise<unknown>;
  /** Forget the key (after a 5xx), so the client may try again with it. Only while it is still ours. */
  release(lock: IdempotencyLock): Promise<void>;
}

export interface ApiDeps {
  /** Origins allowed to send mutating requests (the app's own, API.md §3.6). */
  appOrigins: readonly string[];
  /** The signed-in, `active` user for this request, or null (API.md §3.1). */
  getUser: (request: Request) => Promise<SessionUser | null>;
  /** Counts one request for this rule and user. */
  hitRateLimit: (rule: RateLimitRule, userId: string) => Promise<RateLimitResult>;
  /** Needed by endpoints with `idempotent: true`. */
  idempotency?: IdempotencyStore;
  /** Where unexpected errors are reported (default: console.error). */
  logError?: (message: string, error: unknown) => void;
  /** Makes a new request id (tests pass a fixed one). */
  newRequestId?: () => string;
}

export interface ApiContext<B = undefined> {
  request: Request;
  user: SessionUser;
  requestId: string;
  /** The validated body (only for endpoints with a `body` schema). */
  body: B;
  /**
   * This request's hold on its `idempotencyKeys` record (only for `idempotent` endpoints). A
   * handler that writes in a transaction must save its answer with this lock inside the same
   * transaction, and roll back if the lock was lost, so the same click can never do the work twice.
   */
  idempotencyLock: IdempotencyLock | null;
}

export interface ApiEndpoint<B = undefined> {
  /** The short-window limit for this endpoint (API.md §10.3), counted per user. */
  rateLimit: RateLimitRule;
  /**
   * Strict validator for a JSON body. When set, the request must be `Content-Type: application/json`
   * (else 400 INVALID_INPUT), at most 64 KB (else 413 PAYLOAD_TOO_LARGE, counted while reading, so
   * a missing or false Content-Length doesn't help) and valid JSON that passes the schema.
   */
  body?: BodySchema<B>;
  /** API.md §6: an `Idempotency-Key` header is required; repeats replay the first answer. */
  idempotent?: boolean;
  /**
   * The endpoint's work. Return a plain value (sent as 200 JSON), an `ApiResult` (another status),
   * or a ready Response (not for idempotent endpoints). Throw `ApiProblem` for a documented error.
   */
  handle: (context: ApiContext<B>) => Promise<unknown>;
}

/** A success answer with a status other than 200 (e.g. 201 Created). */
export class ApiResult {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/** A documented error answer (API.md §4.2), thrown by a handler. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiProblem";
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Runs one /api/v1 request through the shared pipeline. */
export async function handleApiRequest<B>(request: Request, endpoint: ApiEndpoint<B>, deps: ApiDeps): Promise<Response> {
  const requestId = requestIdFor(request.headers, deps.newRequestId ?? newRequestId);
  const logError = deps.logError ?? defaultLogError;
  let lock: IdempotencyLock | null = null;
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

    let body = undefined as B;
    let rawBody: unknown = undefined;
    if (endpoint.body) {
      const read = await readJsonBody(request);
      if (!read.ok) return problemResponse(read.problem, requestId);
      rawBody = read.value;
    }

    let idempotencyKey: string | null = null;
    if (endpoint.idempotent) {
      idempotencyKey = request.headers.get("idempotency-key");
      if (idempotencyKey === null || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
        return apiError(400, "INVALID_INPUT", API_MESSAGES.INVALID_REQUEST, requestId, {
          details: { issues: [{ path: "headers.Idempotency-Key", message: "must be 8–128 characters of letters, digits, _ : -" }] },
        });
      }
    }

    if (endpoint.body) {
      // Invalid bodies are answered before the key is recorded: there is nothing to replay, and a
      // repeat gets the same 400 anyway.
      const parsed = endpoint.body.safeParse(rawBody);
      if (!parsed.success) {
        return apiError(400, "INVALID_INPUT", API_MESSAGES.INVALID_INPUT, requestId, { details: { issues: toInputIssues(parsed.error.issues) } });
      }
      body = parsed.data;
    }

    if (idempotencyKey !== null) {
      if (!deps.idempotency) throw new Error("This endpoint needs an idempotency store.");
      const fingerprint = requestFingerprint(request.method, new URL(request.url).pathname, rawBody);
      const begin = await deps.idempotency.begin(user.id, idempotencyKey, fingerprint);
      if (begin.kind === "reused") return apiError(422, "IDEMPOTENCY_KEY_REUSED", API_MESSAGES.IDEMPOTENCY_KEY_REUSED, requestId);
      if (begin.kind === "in_progress") return apiError(409, "IDEMPOTENCY_IN_PROGRESS", API_MESSAGES.IDEMPOTENCY_IN_PROGRESS, requestId);
      if (begin.kind === "replay") {
        // A saved error gets this request's id, like every error body (API.md §4.1).
        const saved = begin.body as { error?: Record<string, unknown> } | null;
        const replayBody = saved && typeof saved === "object" && saved.error ? { error: { ...saved.error, requestId } } : begin.body;
        return Response.json(replayBody, { status: begin.status, headers: { ...commonHeaders(requestId), "Idempotent-Replayed": "true" } });
      }
      lock = { recordId: begin.recordId, lockId: begin.lockId };
    }

    let status: number;
    let payload: unknown;
    try {
      const result = await endpoint.handle({ request, user, requestId, body, idempotencyLock: lock });
      if (result instanceof Response) {
        if (lock !== null) throw new Error("Idempotent endpoints must return a value, not a Response.");
        // A copy: some Responses (e.g. Response.redirect) have read-only headers.
        const response = new Response(result.body, result);
        response.headers.set("X-Request-Id", requestId);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
      [status, payload] = result instanceof ApiResult ? [result.status, result.body] : [200, result];
    } catch (error) {
      if (!(error instanceof ApiProblem)) throw error;
      if (lock !== null) {
        if (error.status < 500) {
          // The saved answer has no requestId of its own: a replay is a new request.
          await deps.idempotency!.finish(lock, error.status, errorBody(error.code, error.message, null, error.details));
        } else {
          // API.md §6: 5xx answers are not saved; the same click may be retried.
          await deps.idempotency!.release(lock).catch(() => undefined);
        }
        lock = null;
      }
      return problemResponse(error, requestId);
    }

    if (lock !== null) {
      await deps.idempotency!.finish(lock, status, payload);
      lock = null;
    }
    return apiJson(payload, requestId, status);
  } catch (error) {
    logError(`API ${request.method} ${new URL(request.url).pathname} failed (request ${requestId}).`, error);
    // API.md §6: 5xx answers are not saved, so the client may retry with the same key.
    if (lock !== null) await deps.idempotency?.release(lock).catch(() => undefined);
    return apiError(500, "INTERNAL", API_MESSAGES.INTERNAL, requestId);
  }
}

function problemResponse(problem: ApiProblem, requestId: string): Response {
  return apiError(problem.status, problem.code, problem.message, requestId, {
    ...(problem.details ? { details: problem.details } : {}),
    ...(problem.headers ? { headers: problem.headers } : {}),
  });
}

type JsonRead = { ok: true; value: unknown } | { ok: false; problem: ApiProblem };

/** API.md §2, §3.6: Content-Type application/json, at most 64 KB, valid JSON. */
export async function readJsonBody(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<JsonRead> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    return {
      ok: false,
      problem: new ApiProblem(400, "INVALID_INPUT", API_MESSAGES.INVALID_REQUEST, { issues: [{ path: "headers.Content-Type", message: "must be application/json" }] }),
    };
  }
  const tooLarge = { ok: false as const, problem: new ApiProblem(413, "PAYLOAD_TOO_LARGE", API_MESSAGES.PAYLOAD_TOO_LARGE) };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  const text = await readTextUpTo(request, maxBytes);
  if (text === null) return tooLarge;
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      problem: new ApiProblem(400, "INVALID_INPUT", API_MESSAGES.INVALID_REQUEST, { issues: [{ path: "body", message: "must be valid JSON" }] }),
    };
  }
}

/** The body as UTF-8 text, or null once it is over `maxBytes` (reading stops there). */
async function readTextUpTo(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** Schema issues → `details.issues` with dot/bracket paths (API.md §4.1), one per unknown field. */
export function toInputIssues(issues: readonly SchemaIssue[]): InputIssue[] {
  const out: InputIssue[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys" && issue.keys) {
      for (const key of issue.keys) out.push({ path: formatPath([...issue.path, key]), message: "unknown field" });
    } else {
      out.push({ path: formatPath(issue.path), message: issue.message });
    }
  }
  return out;
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? String(part) : `.${String(part)}`;
  }
  return out === "" ? "body" : out;
}

/** API.md §6: sha256 of method + path + canonical JSON body (keys sorted at every level). */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  const hash = createHash("sha256").update(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`, "utf8").digest("hex");
  return `sha256:${hash}`;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
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
  return Response.json(errorBody(code, message, requestId, options.details), { status, headers: { ...commonHeaders(requestId), ...options.headers } });
}

/** The error envelope (API.md §4.1). `requestId` null = a saved answer for replays (no id of its own). */
export function errorBody(code: ApiErrorCode, message: string, requestId: string | null, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}), ...(requestId !== null ? { requestId } : {}) } };
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
