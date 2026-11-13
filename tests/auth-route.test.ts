import { describe, expect, it } from "vitest";
import { checkSignInBody, checkSignUpBody, clientIp, handleAuthRequest, isSameOrigin, MAX_BODY_BYTES, SHARED_IP_BUCKET, type AuthHandlerDeps } from "../apps/web/lib/auth/handler";
import { DISABLED_AUTH_PATHS } from "../apps/web/lib/auth/endpoints";
import { AUTH_MESSAGES } from "../apps/web/lib/auth/messages";

// F08/F09: the /api/auth gatekeeper (allow-list, Origin, strict bodies, rate limits, account lock).
// Better Auth itself is replaced by a stand-in that records what reaches it.

const APP = "http://localhost:3230";
const password = `Pw-${Math.random().toString(36).slice(2)}-test`;

type Limits = { signUp?: boolean; signInIp?: boolean; signInEmail?: boolean; session?: boolean };

function limitResult(allowed: boolean, retryAfterSeconds = 321) {
  return { allowed, count: allowed ? 1 : 6, limit: 5, resetsAt: new Date(), retryAfterSeconds };
}

function deps(options: { allowed?: boolean; limits?: Limits; answer?: Response; lockedFor?: number; guardFails?: boolean } = {}) {
  const forwarded: Request[] = [];
  const ips: string[] = [];
  const hits: string[] = [];
  const guard: string[] = [];
  const logged: string[] = [];
  const limits = options.limits ?? {};
  const d: AuthHandlerDeps = {
    appOrigins: [APP],
    trustForwardedFor: true,
    forward: async (r) => {
      forwarded.push(r);
      return options.answer?.clone() ?? Response.json({ ok: true });
    },
    hitSignUpLimit: async (ip) => {
      ips.push(ip);
      return limitResult(limits.signUp ?? options.allowed ?? true);
    },
    hitSignInIpLimit: async (ip) => {
      hits.push(`signin-ip:${ip}`);
      return limitResult(limits.signInIp ?? true, 111);
    },
    hitSignInEmailLimit: async (email) => {
      hits.push(`signin-email:${email}`);
      return limitResult(limits.signInEmail ?? true, 222);
    },
    hitGetSessionLimit: async (ip) => {
      hits.push(`session-ip:${ip}`);
      return limitResult(limits.session ?? true, 33);
    },
    loginGuard: {
      getLock: async (email) => {
        guard.push(`lock?:${email}`);
        return options.lockedFor ? { locked: true, until: new Date(), retryAfterSeconds: options.lockedFor } : { locked: false };
      },
      recordFailure: async (email) => {
        guard.push(`fail:${email}`);
        if (options.guardFails) throw new Error("db down");
      },
      recordSuccess: async (email) => {
        guard.push(`ok:${email}`);
        if (options.guardFails) throw new Error("db down");
      },
    },
    logError: (message) => {
      logged.push(message);
    },
  };
  return { d, forwarded, ips, hits, guard, logged };
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
const signIn = { email: "priya@example.com", password };

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
      const body = path.endsWith("/sign-in/email") ? signIn : {};
      const res = await handleAuthRequest(req(method, path, method === "GET" ? {} : { body }), d);
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

describe("sign-in (A2)", () => {
  const signInReq = (body: unknown = signIn, headers: Record<string, string> = {}) =>
    req("POST", "/api/auth/sign-in/email", { body, headers: { "x-forwarded-for": "203.0.113.24", ...headers } });
  const wrong = () => Response.json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, { status: 401 });

  it("checks the IP limit, then the email limit (lowercased), then the lock, then forwards only email + password", async () => {
    const { d, forwarded, hits, guard } = deps();
    const res = await handleAuthRequest(signInReq({ email: " Priya@Example.COM ", password, rememberMe: false }), d);
    expect(res.status).toBe(200);
    expect(hits).toEqual(["signin-ip:203.0.113.24", "signin-email:priya@example.com"]);
    expect(guard).toEqual(["lock?:priya@example.com", "ok:priya@example.com"]);
    expect(await forwarded[0]?.json()).toEqual({ email: "priya@example.com", password });
  });

  it("over the IP limit: 429 with Retry-After, body not even read", async () => {
    const { d, forwarded, hits, guard } = deps({ limits: { signInIp: false } });
    const res = await handleAuthRequest(signInReq(), d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("111");
    expect(await res.json()).toEqual({ code: "TOO_MANY_ATTEMPTS", message: AUTH_MESSAGES.TOO_MANY_ATTEMPTS });
    expect(hits).toEqual(["signin-ip:203.0.113.24"]);
    expect(guard).toHaveLength(0);
    expect(forwarded).toHaveLength(0);
  });

  it("over the email limit: the same 429", async () => {
    const { d, forwarded } = deps({ limits: { signInEmail: false } });
    const res = await handleAuthRequest(signInReq(), d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("222");
    expect(await res.json()).toEqual({ code: "TOO_MANY_ATTEMPTS", message: AUTH_MESSAGES.TOO_MANY_ATTEMPTS });
    expect(forwarded).toHaveLength(0);
  });

  it("locked account: the same 429 and message as the rate limit, even with the right password", async () => {
    const { d, forwarded, guard } = deps({ lockedFor: 600 });
    const res = await handleAuthRequest(signInReq(), d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
    expect(await res.json()).toEqual({ code: "TOO_MANY_ATTEMPTS", message: AUTH_MESSAGES.TOO_MANY_ATTEMPTS });
    expect(forwarded).toHaveLength(0);
    expect(guard).toEqual(["lock?:priya@example.com"]);
  });

  it("wrong email or wrong password: 401 'Email or password is incorrect', counted as a failure", async () => {
    const { d, guard } = deps({ answer: wrong() });
    const res = await handleAuthRequest(signInReq(), d);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Email or password is incorrect" });
    expect(guard).toEqual(["lock?:priya@example.com", "fail:priya@example.com"]);
  });

  it("a failed counter update is reported, never shown, and the answer is unchanged", async () => {
    const failed = deps({ answer: wrong(), guardFails: true });
    expect((await handleAuthRequest(signInReq(), failed.d)).status).toBe(401);
    const ok = deps({ guardFails: true });
    expect((await handleAuthRequest(signInReq(), ok.d)).status).toBe(200);
    expect([...failed.logged, ...ok.logged].join(" ")).not.toContain("priya");
    expect(failed.logged).toHaveLength(1);
    expect(ok.logged).toHaveLength(1);
  });

  it("a paused account (403 ACCOUNT_SUSPENDED) passes through and counts neither way", async () => {
    const answer = Response.json({ code: "ACCOUNT_SUSPENDED", message: AUTH_MESSAGES.ACCOUNT_SUSPENDED }, { status: 403 });
    const { d, guard } = deps({ answer });
    const res = await handleAuthRequest(signInReq(), d);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ACCOUNT_SUSPENDED");
    expect(guard).toEqual(["lock?:priya@example.com"]);
  });

  it("refuses unknown fields, wrong types, broken JSON and bodies over 64 KB, before the email counter", async () => {
    for (const body of [{ ...signIn, role: "admin" }, { ...signIn, callbackURL: "https://evil.example" }, { ...signIn, rememberMe: "yes" }, { email: "priya@example.com" }, "{nope"]) {
      const { d, forwarded, hits } = deps();
      const res = await handleAuthRequest(signInReq(body), d);
      expect(res.status).toBe(400);
      expect(forwarded).toHaveLength(0);
      expect(hits).toEqual(["signin-ip:203.0.113.24"]);
    }
    const big = await handleAuthRequest(signInReq({ ...signIn, password: "x".repeat(MAX_BODY_BYTES) }), deps().d);
    expect(big.status).toBe(413);
  });

  it("wrong Origin is refused before anything is counted", async () => {
    const { d, hits, guard } = deps();
    const res = await handleAuthRequest(signInReq(signIn, { origin: "https://evil.example" }), d);
    expect(res.status).toBe(403);
    expect(hits).toHaveLength(0);
    expect(guard).toHaveLength(0);
  });

  it("a made-up X-Forwarded-For off Vercel shares one counter", async () => {
    const { d, hits } = deps();
    d.trustForwardedFor = false;
    await handleAuthRequest(signInReq(signIn, { "x-forwarded-for": "198.51.100.7" }), d);
    expect(hits[0]).toBe(`signin-ip:${SHARED_IP_BUCKET}`);
  });
});

describe("body size without Content-Length (F09 review)", () => {
  /** A chunked body: no Content-Length; counts how many chunks were pulled. */
  function chunked(path: string, chunk: string, count: number) {
    let pulled = 0;
    const bytes = new TextEncoder().encode(chunk);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= count) return controller.close();
        pulled++;
        controller.enqueue(bytes);
      },
    });
    const request = new Request(`${APP}${path}`, { method: "POST", headers: { origin: APP, "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    return { request, pulled: () => pulled };
  }

  it.each(["/api/auth/sign-in/email", "/api/auth/sign-up/email"])("%s: stops reading above 64 KB and answers 413", async (path) => {
    const { d, forwarded } = deps();
    const big = chunked(path, "x".repeat(16 * 1024), 1000);
    expect(big.request.headers.get("content-length")).toBeNull();
    const res = await handleAuthRequest(big.request, d);
    expect(res.status).toBe(413);
    expect(forwarded).toHaveLength(0);
    expect(big.pulled()).toBeLessThan(10);
  });

  it("a small chunked body is read normally", async () => {
    const { d, forwarded } = deps();
    const text = JSON.stringify(signIn);
    const small = chunked("/api/auth/sign-in/email", text, 1);
    expect((await handleAuthRequest(small.request, d)).status).toBe(200);
    expect(await forwarded[0]?.json()).toEqual(signIn);
  });
});

describe("checkSignInBody", () => {
  it.each([
    [{ ...signIn, email: "not-an-email" }, "INVALID_EMAIL"],
    [{ ...signIn, password: "" }, "INVALID_INPUT"],
    [{ ...signIn, password: "x".repeat(129) }, "INVALID_INPUT"],
    [{ ...signIn, password: 12345678 }, "INVALID_INPUT"],
    [{ ...signIn, name: "Priya" }, "INVALID_INPUT"],
    [[], "INVALID_INPUT"],
    [null, "INVALID_INPUT"],
  ])("refuses %j", (body, code) => {
    const r = checkSignInBody(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it("accepts a 1-character password (old passwords are never re-checked for length) and drops rememberMe", () => {
    expect(checkSignInBody({ ...signIn, password: "x" })).toEqual({ ok: true, value: { email: "priya@example.com", password: "x" } });
    expect(checkSignInBody({ ...signIn, rememberMe: true })).toEqual({ ok: true, value: signIn });
  });
});

describe("get-session (A4)", () => {
  it("counts 120 per minute per IP and answers 429 over it", async () => {
    const ok = deps();
    expect((await handleAuthRequest(new Request(`${APP}/api/auth/get-session`, { headers: { "x-forwarded-for": "203.0.113.24" } }), ok.d)).status).toBe(200);
    expect(ok.hits).toEqual(["session-ip:203.0.113.24"]);
    const over = deps({ limits: { session: false } });
    const res = await handleAuthRequest(new Request(`${APP}/api/auth/get-session`), over.d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("33");
    expect(over.forwarded).toHaveLength(0);
  });

  it("sign-out is not rate limited and goes straight to Better Auth", async () => {
    const { d, hits, forwarded } = deps();
    expect((await handleAuthRequest(req("POST", "/api/auth/sign-out", { body: {} }), d)).status).toBe(200);
    expect(hits).toHaveLength(0);
    expect(forwarded).toHaveLength(1);
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
  it("on Vercel uses the X-Forwarded-For address Vercel wrote", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.24" }), true)).toBe("203.0.113.24");
    expect(clientIp(new Headers(), true)).toBe(SHARED_IP_BUCKET);
  });

  it("elsewhere ignores caller-sent headers, so a made-up address buys no extra attempts", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.7" }), false)).toBe(SHARED_IP_BUCKET);
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.7" }), false)).toBe(SHARED_IP_BUCKET);
  });
});
