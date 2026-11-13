import type { RateLimitResult, RateLimitRule } from "@bytereel/db";
import { CreateProjectBodySchema } from "@bytereel/db";
import { describe, expect, it, vi } from "vitest";
import {
  ApiProblem,
  ApiResult,
  canonicalJson,
  handleApiRequest,
  requestFingerprint,
  type ApiDeps,
  type ApiEndpoint,
  type IdempotencyBegin,
  type IdempotencyLock,
  type IdempotencyStore,
} from "../apps/web/lib/api/v1";
import type { SessionUser } from "../apps/web/lib/auth/session";

// F12: the parts of the /api/v1 pipeline that the first POST endpoint (C2) needs:
// JSON Content-Type, 64 KB body cap, strict body validation and Idempotency-Key (API.md §2, §3.6, §6).

const APP = "http://localhost:3000";
const RULE: RateLimitRule = { name: "create-project", limit: 10, windowSeconds: 3600 };
const KEY = "9b2f4c1e-7d3a-4e8b-a1c5-2f6d8e0b4a71";
const user: SessionUser = {
  id: "67330c1a9f1e4b2a7c0d1e01",
  name: "Ananya Iyer",
  email: "ananya.iyer@example.in",
  role: "creator",
  timezone: "Asia/Kolkata",
  defaultLanguage: "en",
  defaultVoiceGender: "female",
  createdAt: "2026-11-12T04:30:00.000Z",
};
const allowed: RateLimitResult = { allowed: true, count: 1, limit: 10, resetsAt: new Date(), retryAfterSeconds: 60 };
const VALID = { inputType: "topic", text: "How UPI payments work", language: "en", voiceGender: "female" };

/** An in-memory idempotency store with the same rules as packages/db/src/idempotency.ts. */
function memoryStore() {
  const records = new Map<string, { id: string; lockId: string; fingerprint: string; done: boolean; status?: number; body?: unknown }>();
  let n = 0;
  const store: IdempotencyStore & { records: typeof records } = {
    records,
    begin: vi.fn(async (userId: string, key: string, fingerprint: string): Promise<IdempotencyBegin> => {
      const k = `${userId}:${key}`;
      const existing = records.get(k);
      if (!existing) {
        const id = `rec${++n}`;
        records.set(k, { id, lockId: `lock${n}`, fingerprint, done: false });
        return { kind: "new", recordId: id, lockId: `lock${n}` };
      }
      if (existing.fingerprint !== fingerprint) return { kind: "reused" };
      if (!existing.done) return { kind: "in_progress" };
      return { kind: "replay", status: existing.status!, body: existing.body };
    }),
    finish: vi.fn(async (lock: IdempotencyLock, status: number, body: unknown) => {
      for (const r of records.values()) if (r.id === lock.recordId && r.lockId === lock.lockId && !r.done) Object.assign(r, { done: true, status, body });
    }),
    release: vi.fn(async (lock: IdempotencyLock) => {
      for (const [k, r] of records) if (r.id === lock.recordId && r.lockId === lock.lockId && !r.done) records.delete(k);
    }),
  };
  return store;
}

function deps(over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    appOrigins: [APP],
    getUser: async () => user,
    hitRateLimit: async () => allowed,
    logError: () => undefined,
    newRequestId: () => "req_TEST0000000000",
    ...over,
  };
}

type Body = typeof CreateProjectBodySchema extends { safeParse(v: unknown): infer R } ? (R extends { success: true; data: infer D } ? D : never) : never;

function endpoint(handle: ApiEndpoint<Body>["handle"] = async ({ body }) => new ApiResult(201, { saved: body.text })): ApiEndpoint<Body> {
  return { rateLimit: RULE, body: CreateProjectBodySchema, idempotent: true, handle };
}

function postJson(body: BodyInit | null, headers: Record<string, string> = {}, path = "/api/v1/projects"): Request {
  return new Request(`${APP}${path}`, {
    method: "POST",
    headers: { origin: APP, "content-type": "application/json", "idempotency-key": KEY, ...headers },
    body,
  });
}

describe("JSON body checks", () => {
  it("a valid body reaches the handler cleaned (trimmed) and the status of ApiResult is used", async () => {
    const r = await handleApiRequest(postJson(JSON.stringify({ ...VALID, text: "  How UPI payments work \n" })), endpoint(), deps({ idempotency: memoryStore() }));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ saved: "How UPI payments work" });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["no Content-Type", {}],
    ["text/plain (what an HTML form or a simple cross-site fetch sends)", { "content-type": "text/plain" }],
    ["application/x-www-form-urlencoded", { "content-type": "application/x-www-form-urlencoded" }],
  ])("%s → 400 INVALID_INPUT, handler not run", async (_label, headers) => {
    const handle = vi.fn(async () => ({}));
    const req = new Request(`${APP}/api/v1/projects`, { method: "POST", headers: { origin: APP, "idempotency-key": KEY, ...headers }, body: JSON.stringify(VALID) });
    if (!("content-type" in headers)) req.headers.delete("content-type");
    const r = await handleApiRequest(req, endpoint(handle), deps({ idempotency: memoryStore() }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "Please reload the page and try again.",
        details: { issues: [{ path: "headers.Content-Type", message: "must be application/json" }] },
        requestId: "req_TEST0000000000",
      },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("application/json; charset=utf-8 is fine", async () => {
    const r = await handleApiRequest(postJson(JSON.stringify(VALID), { "content-type": "application/json; charset=utf-8" }), endpoint(), deps({ idempotency: memoryStore() }));
    expect(r.status).toBe(201);
  });

  it("a body over 64 KB → 413 PAYLOAD_TOO_LARGE, even without Content-Length (counted while reading)", async () => {
    const big = JSON.stringify({ ...VALID, text: "x".repeat(70 * 1024) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(big);
        for (let i = 0; i < bytes.length; i += 8192) controller.enqueue(bytes.slice(i, i + 8192));
        controller.close();
      },
    });
    const req = new Request(`${APP}/api/v1/projects`, {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json", "idempotency-key": KEY },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const store = memoryStore();
    const r = await handleApiRequest(req, endpoint(), deps({ idempotency: store }));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: { code: "PAYLOAD_TOO_LARGE", message: "This request is too large.", requestId: "req_TEST0000000000" } });
    expect(store.begin).not.toHaveBeenCalled();
  });

  it("a body of exactly 64 KB is read (then validated)", async () => {
    const filler = "y".repeat(64 * 1024 - JSON.stringify({ ...VALID, text: "" }).length);
    const raw = JSON.stringify({ ...VALID, text: filler });
    expect(new TextEncoder().encode(raw).length).toBe(64 * 1024);
    const r = await handleApiRequest(postJson(raw), endpoint(), deps({ idempotency: memoryStore() }));
    expect(r.status).toBe(400); // read fine; the text is simply too long for a topic
    expect(((await r.json()) as { error: { details: { issues: unknown[] } } }).error.details.issues).toEqual([{ path: "text", message: "must be at most 300 characters" }]);
  });

  it("broken JSON → 400 INVALID_INPUT", async () => {
    const r = await handleApiRequest(postJson("{ not json"), endpoint(), deps({ idempotency: memoryStore() }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { details: unknown } }).error.details).toEqual({ issues: [{ path: "body", message: "must be valid JSON" }] });
  });

  it("unknown fields and bad values → 400 INVALID_INPUT with one issue per problem; the key is not recorded", async () => {
    const store = memoryStore();
    const r = await handleApiRequest(postJson(JSON.stringify({ ...VALID, language: "fr", ownerId: "someone-else", state: "published" })), endpoint(), deps({ idempotency: store }));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { message: string; details: { issues: unknown[] } } };
    expect(body.error.message).toBe("Please check the highlighted fields.");
    expect(body.error.details.issues).toEqual(
      expect.arrayContaining([
        { path: "language", message: "must be one of en, hi, hinglish" },
        { path: "ownerId", message: "unknown field" },
        { path: "state", message: "unknown field" },
      ]),
    );
    expect(store.begin).not.toHaveBeenCalled();
  });

  it("checks happen after the session and rate limit (signed out → 401, even with a bad body)", async () => {
    const r = await handleApiRequest(postJson("{ not json"), endpoint(), deps({ getUser: async () => null, idempotency: memoryStore() }));
    expect(r.status).toBe(401);
  });
});

describe("Idempotency-Key (API.md §6)", () => {
  it.each([
    ["missing", null],
    ["too short", "abc"],
    ["bad characters", "key with spaces!"],
    ["too long", "k".repeat(129)],
  ])("%s → 400 INVALID_INPUT, handler not run", async (_label, key) => {
    const handle = vi.fn(async () => ({}));
    const req = postJson(JSON.stringify(VALID));
    if (key === null) req.headers.delete("idempotency-key");
    else req.headers.set("idempotency-key", key);
    const r = await handleApiRequest(req, endpoint(handle), deps({ idempotency: memoryStore() }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { details: { issues: { path: string }[] } } }).error.details.issues[0]!.path).toBe("headers.Idempotency-Key");
    expect(handle).not.toHaveBeenCalled();
  });

  it("same key + same body → the first answer again with Idempotent-Replayed: true; the work runs once", async () => {
    const store = memoryStore();
    const handle = vi.fn(async () => new ApiResult(201, { project: { id: "p1" }, job: null }));
    const first = await handleApiRequest(postJson(JSON.stringify(VALID)), endpoint(handle), deps({ idempotency: store }));
    // Same fields in another order: the same request (canonical JSON).
    const reordered = { voiceGender: "female", language: "en", text: "How UPI payments work", inputType: "topic" };
    const second = await handleApiRequest(postJson(JSON.stringify(reordered)), endpoint(handle), deps({ idempotency: store, newRequestId: () => "req_SECOND00000000" }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(second.headers.get("x-request-id")).toBe("req_SECOND00000000");
    expect(handle).toHaveBeenCalledOnce();
  });

  it("same key + different body → 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const store = memoryStore();
    await handleApiRequest(postJson(JSON.stringify(VALID)), endpoint(), deps({ idempotency: store }));
    const r = await handleApiRequest(postJson(JSON.stringify({ ...VALID, voiceGender: "male" })), endpoint(), deps({ idempotency: store }));
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("same key while the first request is still running → 409 IDEMPOTENCY_IN_PROGRESS", async () => {
    const store = memoryStore();
    let release!: () => void;
    const slow = endpoint(() => new Promise((resolve) => (release = () => resolve(new ApiResult(201, { ok: true })))));
    const first = handleApiRequest(postJson(JSON.stringify(VALID)), slow, deps({ idempotency: store }));
    await vi.waitFor(() => expect(store.begin).toHaveBeenCalledOnce());
    const second = await handleApiRequest(postJson(JSON.stringify(VALID)), slow, deps({ idempotency: store }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    release();
    expect((await first).status).toBe(201);
  });

  it("the same key from another user is a separate request", async () => {
    const store = memoryStore();
    const handle = vi.fn(async () => new ApiResult(201, {}));
    await handleApiRequest(postJson(JSON.stringify(VALID)), endpoint(handle), deps({ idempotency: store }));
    await handleApiRequest(postJson(JSON.stringify(VALID)), endpoint(handle), deps({ idempotency: store, getUser: async () => ({ ...user, id: "67330c1a9f1e4b2a7c0d1e02" }) }));
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("a documented 4xx (e.g. QUOTA_EXCEEDED) is saved and replayed with the new request id", async () => {
    const store = memoryStore();
    const handle = vi.fn(async () => {
      throw new ApiProblem(429, "QUOTA_EXCEEDED", "You've created 5 projects today. Try again tomorrow.", { quota: "projects_per_day", limit: 5, used: 5, resetsAt: "2026-11-13T18:30:00.000Z" });
    });
    const first = await handleApiRequest(postJson(JSON.stringify(VALID)), endpoint(handle), deps({ idempotency: store }));
    const second = await handleApiRequest(postJson(JSON.stringify(VALID)), endpoint(handle), deps({ idempotency: store, newRequestId: () => "req_SECOND00000000" }));
    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
    const a = (await first.json()) as { error: Record<string, unknown> };
    const b = (await second.json()) as { error: Record<string, unknown> };
    expect(a.error.requestId).toBe("req_TEST0000000000");
    expect(b.error).toEqual({ ...a.error, requestId: "req_SECOND00000000" });
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(handle).toHaveBeenCalledOnce();
  });

  it("a 5xx is NOT saved: the key is released and the same click can be retried", async () => {
    const store = memoryStore();
    let fail = true;
    const handle = vi.fn(async () => {
      if (fail) throw new Error("database hiccup");
      return new ApiResult(201, { ok: true });
    });
    const first = await handleApiRequest(postJson(JSON.stringify(VALID)), endpoint(handle), deps({ idempotency: store }));
    expect(first.status).toBe(500);
    expect(store.release).toHaveBeenCalledOnce();
    fail = false;
    const second = await handleApiRequest(postJson(JSON.stringify(VALID)), endpoint(handle), deps({ idempotency: store }));
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBeNull();
  });

  it("the handler gets its lock (record id + this check-in's lockId) to save the answer in its own transaction", async () => {
    const store = memoryStore();
    const seen: (IdempotencyLock | null)[] = [];
    await handleApiRequest(
      postJson(JSON.stringify(VALID)),
      endpoint(async ({ idempotencyLock }) => {
        seen.push(idempotencyLock);
        return new ApiResult(201, {});
      }),
      deps({ idempotency: store }),
    );
    expect(seen).toEqual([{ recordId: "rec1", lockId: "lock1" }]);
  });

  it("a handler's own 5xx ApiProblem releases the key (API.md §6), so the same click can be retried", async () => {
    const store = memoryStore();
    let fail = true;
    const handle = vi.fn(async () => {
      if (fail) throw new ApiProblem(503, "INTERNAL", "Paused for a moment.");
      return new ApiResult(201, { ok: true });
    });
    const first = await handleApiRequest(postJson(JSON.stringify(VALID)), endpoint(handle), deps({ idempotency: store }));
    expect(first.status).toBe(503);
    expect(store.release).toHaveBeenCalledWith({ recordId: "rec1", lockId: "lock1" });
    expect(store.finish).not.toHaveBeenCalled();
    fail = false;
    const second = await handleApiRequest(postJson(JSON.stringify(VALID)), endpoint(handle), deps({ idempotency: store }));
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBeNull();
    expect(handle).toHaveBeenCalledTimes(2);
  });
});

describe("fingerprint", () => {
  it("is sha256 of method + path + canonical JSON (key order doesn't matter, values do)", () => {
    const a = requestFingerprint("POST", "/api/v1/projects", { b: 1, a: { d: [1, 2], c: "x" } });
    const b = requestFingerprint("post", "/api/v1/projects", { a: { c: "x", d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(requestFingerprint("POST", "/api/v1/other", { b: 1, a: { d: [1, 2], c: "x" } })).not.toBe(a);
    expect(requestFingerprint("POST", "/api/v1/projects", { b: 2, a: { d: [1, 2], c: "x" } })).not.toBe(a);
    expect(canonicalJson({ z: null, a: [true, "é"] })).toBe('{"a":[true,"é"],"z":null}');
  });
});
