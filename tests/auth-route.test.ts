import { describe, expect, it } from "vitest";
import { checkSignUpBody, clientIp, handleAuthRequest, isSameOrigin, MAX_BODY_BYTES, type AuthHandlerDeps } from "../apps/web/lib/auth/handler";
import { DISABLED_AUTH_PATHS } from "../apps/web/lib/auth/endpoints";
import { AUTH_MESSAGES } from "../apps/web/lib/auth/messages";

// F08: the /api/auth gatekeeper (allow-list, Origin, strict sign-up body, rate limit). Better Auth
// itself is replaced by a stand-in that records what reaches it.

const APP = "http://localhost:3230";
const password = `Pw-${Math.random().toString(36).slice(2)}-test`;

function deps(options: { allowed?: boolean; answer?: Response } = {}) {
  const forwarded: Request[] = [];
  const ips: string[] = [];
  const d: AuthHandlerDeps = {
    appOrigins: [APP],
    forward: async (r) => {
      forwarded.push(r);
      return options.answer?.clone() ?? Response.json({ ok: true });
    },
    hitSignUpLimit: async (ip) => {
      ips.push(ip);
      const allowed = options.allowed ?? true;
      return { allowed, count: allowed ? 1 : 6, limit: 5, resetsAt: new Date(), retryAfterSeconds: 321 };
    },
  };
  return { d, forwarded, ips };
}

function req(method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: APP, "content-type": "application/json", ...init.headers };
  return new Request(`${APP}${path}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
  });
}

const signUp = { name: "Priya", email: "priya@example.com", password };

describe("endpoint allow-list", () => {
  it.each(DISABLED_AUTH_PATHS.map((p) => [p]))("answers 404 for %s and never reaches Better Auth", async (path) => {
    for (const method of ["GET", "POST"]) {
      const { d, forwarded } = deps();
      const res = await handleAuthRequest(req(method, `/api/auth${path}`, method === "POST" ? { body: {} } : {}), d);
      expect(res.status).toBe(404);
      expect(forwarded).toHaveLength(0);
    }
  });

  it.each([
    ["GET", "/api/auth/sign-up/email"],
    ["POST", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-up/email/"],
    ["POST", "/api/auth/SIGN-UP/email"],
    ["POST", "/api/auth/sign-up%2Femail"],
    ["GET", "/api/auth/callback/google"],
    ["GET", "/api/auth/reset-password/sometoken"],
    ["DELETE", "/api/auth/delete-user"],
    ["POST", "/api/auth/"],
  ])("answers 404 for %s %s", async (method, path) => {
    const { d, forwarded } = deps();
    const res = await handleAuthRequest(req(method, path, method === "GET" ? {} : { body: {} }), d);
    expect(res.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  it("forwards the allowed endpoints", async () => {
    for (const [method, path] of [
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/sign-out"],
      ["POST", "/api/auth/change-password"],
      ["POST", "/api/auth/reset-password"],
    ] as const) {
      const { d, forwarded } = deps();
      const res = await handleAuthRequest(req(method, path, method === "GET" ? {} : { body: {} }), d);
      expect(res.status).toBe(200);
      expect(forwarded).toHaveLength(1);
    }
  });
});

describe("Origin check", () => {
  it("refuses a sign-up from another site with 403 FORBIDDEN_ORIGIN before counting it", async () => {
    const { d, forwarded, ips } = deps();
    const res = await handleAuthRequest(req("POST", "/api/auth/sign-up/email", { body: signUp, headers: { origin: "https://evil.example" } }), d);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "FORBIDDEN_ORIGIN", message: AUTH_MESSAGES.FORBIDDEN_ORIGIN });
    expect(forwarded).toHaveLength(0);
    expect(ips).toHaveLength(0);
  });

  it("accepts Sec-Fetch-Site same-origin only when there is no Origin header", () => {
    expect(isSameOrigin(new Headers({ origin: APP }), [APP])).toBe(true);
    expect(isSameOrigin(new Headers({ origin: "null" }), [APP])).toBe(false);
    expect(isSameOrigin(new Headers({ origin: "http://localhost:3230.evil.com" }), [APP])).toBe(false);
    expect(isSameOrigin(new Headers({ "sec-fetch-site": "same-origin" }), [APP])).toBe(true);
    expect(isSameOrigin(new Headers({ "sec-fetch-site": "cross-site" }), [APP])).toBe(false);
    expect(isSameOrigin(new Headers({ origin: "https://evil.example", "sec-fetch-site": "same-origin" }), [APP])).toBe(false);
    expect(isSameOrigin(new Headers(), [APP])).toBe(false);
  });

  it("GET get-session needs no Origin", async () => {
    const { d } = deps();
    const res = await handleAuthRequest(new Request(`${APP}/api/auth/get-session`), d);
    expect(res.status).toBe(200);
  });

  it("requires a JSON body on POST (a plain HTML form can't post)", async () => {
    const { d, forwarded } = deps();
    const res = await handleAuthRequest(req("POST", "/api/auth/sign-in/email", { body: "email=a", headers: { "content-type": "application/x-www-form-urlencoded" } }), d);
    expect(res.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
});

describe("sign-up", () => {
  it("forwards only the cleaned fields", async () => {
    const { d, forwarded, ips } = deps();
    const res = await handleAuthRequest(req("POST", "/api/auth/sign-up/email", { body: { name: "  Priya  ", email: " Priya@Example.COM ", password }, headers: { "x-forwarded-for": "203.0.113.24" } }), d);
    expect(res.status).toBe(200);
    expect(ips).toEqual(["203.0.113.24"]);
    expect(await forwarded[0]?.json()).toEqual({ name: "Priya", email: "priya@example.com", password });
  });

  it("refuses server-owned and unknown fields with 400", async () => {
    for (const extra of [{ role: "admin" }, { status: "active" }, { image: "x" }, { callbackURL: "/" }, { rememberMe: false }, { timezone: "UTC" }]) {
      const { d, forwarded } = deps();
      const res = await handleAuthRequest(req("POST", "/api/auth/sign-up/email", { body: { ...signUp, ...extra } }), d);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("INVALID_INPUT");
      expect(forwarded).toHaveLength(0);
    }
  });

  it("answers 429 TOO_MANY_ATTEMPTS with Retry-After when over the limit", async () => {
    const { d, forwarded } = deps({ allowed: false });
    const res = await handleAuthRequest(req("POST", "/api/auth/sign-up/email", { body: signUp }), d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("321");
    expect(await res.json()).toEqual({ code: "TOO_MANY_ATTEMPTS", message: AUTH_MESSAGES.TOO_MANY_ATTEMPTS });
    expect(forwarded).toHaveLength(0);
  });

  it("refuses bodies over 64 KB and broken JSON", async () => {
    const big = await handleAuthRequest(req("POST", "/api/auth/sign-up/email", { body: { ...signUp, name: "x".repeat(MAX_BODY_BYTES) } }), deps().d);
    expect(big.status).toBe(413);
    const broken = await handleAuthRequest(req("POST", "/api/auth/sign-up/email", { body: "{nope" }), deps().d);
    expect(broken.status).toBe(400);
  });

  it("renames Better Auth's duplicate-email error to USER_ALREADY_EXISTS (422)", async () => {
    const answer = Response.json({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", message: "User already exists. Use another email." }, { status: 422 });
    const res = await handleAuthRequest(req("POST", "/api/auth/sign-up/email", { body: signUp }), deps({ answer }).d);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: "USER_ALREADY_EXISTS", message: AUTH_MESSAGES.USER_ALREADY_EXISTS });
  });

  it("passes other Better Auth errors through unchanged", async () => {
    const answer = Response.json({ code: "NOT_ALLOWLISTED", message: AUTH_MESSAGES.NOT_ALLOWLISTED }, { status: 403 });
    const res = await handleAuthRequest(req("POST", "/api/auth/sign-up/email", { body: signUp }), deps({ answer }).d);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_ALLOWLISTED");
  });
});

describe("checkSignUpBody", () => {
  it.each([
    [{ ...signUp, name: "   " }, "INVALID_INPUT"],
    [{ ...signUp, name: "x".repeat(81) }, "INVALID_INPUT"],
    [{ ...signUp, email: "not-an-email" }, "INVALID_EMAIL"],
    [{ ...signUp, email: `${"a".repeat(250)}@example.com` }, "INVALID_EMAIL"],
    [{ ...signUp, password: "1234567" }, "PASSWORD_TOO_SHORT"],
    [{ ...signUp, password: "x".repeat(129) }, "PASSWORD_TOO_LONG"],
    [{ name: "A", email: "a@example.com" }, "INVALID_INPUT"],
    [[], "INVALID_INPUT"],
    [null, "INVALID_INPUT"],
  ])("refuses %j", (body, code) => {
    const r = checkSignUpBody(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it("accepts 8 and 128 character passwords and keeps spaces in passwords", () => {
    expect(checkSignUpBody({ ...signUp, password: "12345678" }).ok).toBe(true);
    expect(checkSignUpBody({ ...signUp, password: "x".repeat(128) }).ok).toBe(true);
    const r = checkSignUpBody({ ...signUp, password: " pass word " });
    expect(r.ok && r.value.password).toBe(" pass word ");
  });
});

describe("clientIp", () => {
  it("uses the last x-forwarded-for entry, then x-real-ip", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("2.2.2.2");
    expect(clientIp(new Headers({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
