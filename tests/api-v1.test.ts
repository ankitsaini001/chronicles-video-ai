import type { RateLimitResult, RateLimitRule } from "@bytereel/db";
import { describe, expect, it, vi } from "vitest";
import { getMe, getUsage } from "../apps/web/lib/account/me";
import { handleApiRequest, newRequestId, requestIdFor, type ApiDeps, type ApiEndpoint } from "../apps/web/lib/api/v1";
import type { SessionUser } from "../apps/web/lib/auth/session";

// F11: the shared /api/v1 pipeline (API.md §1, §2, §3.6, §3.8, §4.1, §10.3) and B1 GET /api/v1/me.

const APP = "http://localhost:3000";
const RULE: RateLimitRule = { name: "v1-read-user", limit: 300, windowSeconds: 60 };

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

const allowed: RateLimitResult = { allowed: true, count: 1, limit: 300, resetsAt: new Date(), retryAfterSeconds: 60 };

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

const okEndpoint: ApiEndpoint = { rateLimit: RULE, handle: async () => ({ hello: "world" }) };
const get = (headers: Record<string, string> = {}) => new Request(`${APP}/api/v1/me`, { headers });
const post = (headers: Record<string, string> = {}) =>
  new Request(`${APP}/api/v1/things`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

describe("handleApiRequest", () => {
  it("success: the resource itself, no-store, X-Request-Id", async () => {
    const r = await handleApiRequest(get(), okEndpoint, deps());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ hello: "world" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-request-id")).toBe("req_TEST0000000000");
  });

  it("no session → 401 UNAUTHENTICATED in the envelope, rate limit not counted, handler not run", async () => {
    const hit = vi.fn(async () => allowed);
    const handle = vi.fn(async () => ({}));
    const r = await handleApiRequest(get(), { rateLimit: RULE, handle }, deps({ getUser: async () => null, hitRateLimit: hit }));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Please log in again.", requestId: "req_TEST0000000000" } });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(hit).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it("rate limit is counted per user id with the endpoint's rule", async () => {
    const hit = vi.fn(async () => allowed);
    await handleApiRequest(get(), okEndpoint, deps({ hitRateLimit: hit }));
    expect(hit).toHaveBeenCalledWith(RULE, user.id);
  });

  it("over the limit → 429 RATE_LIMITED with Retry-After and details.retryAfterSeconds", async () => {
    const handle = vi.fn(async () => ({}));
    const r = await handleApiRequest(get(), { rateLimit: RULE, handle }, deps({ hitRateLimit: async () => ({ ...allowed, allowed: false, retryAfterSeconds: 42 }) }));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("42");
    expect(await r.json()).toEqual({
      error: { code: "RATE_LIMITED", message: "You're going a bit fast. Please wait a minute.", details: { retryAfterSeconds: 42 }, requestId: "req_TEST0000000000" },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("GET needs no Origin (reads never change anything)", async () => {
    const r = await handleApiRequest(get({ origin: "https://evil.example" }), okEndpoint, deps());
    expect(r.status).toBe(200);
  });

  it.each([
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["no Origin and no fetch metadata", {}],
    ["no Origin, cross-site fetch", { "sec-fetch-site": "cross-site" }],
  ])("mutation with %s → 403 FORBIDDEN origin_mismatch before the session is read", async (_label, headers) => {
    const getUser = vi.fn(async () => user);
    const r = await handleApiRequest(post(headers), okEndpoint, deps({ getUser }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Please reload the page and try again.", details: { reason: "origin_mismatch" }, requestId: "req_TEST0000000000" },
    });
    expect(getUser).not.toHaveBeenCalled();
  });

  it.each([[{ origin: APP }], [{ "sec-fetch-site": "same-origin" }]])("mutation from the app itself passes (%j)", async (headers) => {
    const r = await handleApiRequest(post(headers), okEndpoint, deps());
    expect(r.status).toBe(200);
  });

  it("an unexpected error → 500 INTERNAL with a plain message (details only in the log)", async () => {
    const logError = vi.fn();
    const failing: ApiEndpoint = { rateLimit: RULE, handle: async () => { throw new Error("mongo exploded: secret-ish detail"); } };
    const r = await handleApiRequest(get(), failing, deps({ logError }));
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(JSON.parse(body)).toEqual({ error: { code: "INTERNAL", message: "Something went wrong on our side. Please try again.", requestId: "req_TEST0000000000" } });
    expect(body).not.toContain("mongo");
    expect(logError).toHaveBeenCalledOnce();
  });

  it("a database error while reading the session → 500 INTERNAL", async () => {
    const r = await handleApiRequest(get(), okEndpoint, deps({ getUser: async () => { throw new Error("down"); } }));
    expect(r.status).toBe(500);
  });

  it("a handler's own Response gets the common headers too", async () => {
    const endpoint: ApiEndpoint = { rateLimit: RULE, handle: async () => Response.redirect(`${APP}/somewhere`, 302) };
    const r = await handleApiRequest(get(), endpoint, deps());
    expect(r.status).toBe(302);
    expect(r.headers.get("x-request-id")).toBe("req_TEST0000000000");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("request ids", () => {
  it("uses a valid id sent by the client", () => {
    expect(requestIdFor(new Headers({ "x-request-id": "my-trace-123" }), () => "gen")).toBe("my-trace-123");
  });

  it.each(["", "has space", "x".repeat(65), "<script>", "a_b"])("ignores an invalid client id %j", (sent) => {
    expect(requestIdFor(new Headers({ "x-request-id": sent }), () => "gen")).toBe("gen");
  });

  it("makes req_ + 16 characters, different every time", () => {
    const a = newRequestId();
    expect(a).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(newRequestId()).not.toBe(a);
  });
});

describe("B1 getMe", () => {
  const now = new Date("2026-11-13T10:00:00.000Z");

  it("matches the API.md Me shape with zero usage and documented limits", async () => {
    expect(await getMe(user, now)).toEqual({
      id: user.id,
      name: "Ananya Iyer",
      email: "ananya.iyer@example.in",
      role: "creator",
      timezone: "Asia/Kolkata",
      defaultLanguage: "en",
      defaultVoiceGender: "female",
      createdAt: "2026-11-12T04:30:00.000Z",
      usage: {
        videosToday: { used: 0, limit: 3, resetsAt: "2026-11-13T18:30:00.000Z" },
        projectsToday: { used: 0, limit: 5, resetsAt: "2026-11-13T18:30:00.000Z" },
        voiceCharactersThisMonth: { used: 0, limit: 3000, resetsAt: "2026-11-30T18:30:00.000Z" },
      },
      instagram: { status: "not_connected", username: null },
      unreadNotifications: 0,
      maintenance: { active: false, message: null },
    });
  });

  it("never carries login-protection fields, even if the input object had them", async () => {
    const leaky = { ...user, failedLoginCount: 4, lockedUntil: new Date(), lastLoginAt: new Date(), status: "active" } as SessionUser;
    const me = await getMe(leaky, now);
    const json = JSON.stringify(me);
    for (const field of ["failedLoginCount", "lockedUntil", "lastLoginAt"]) expect(json).not.toContain(field);
    expect(Object.keys(me)).not.toContain("status");
  });

  it("the shell pill and B1 use the same numbers", async () => {
    const me = await getMe(user, now);
    expect((await getUsage(user, now)).videosToday).toEqual(me.usage.videosToday);
  });
});
