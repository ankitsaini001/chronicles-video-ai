import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { readAuthConfig } from "../apps/web/lib/auth/config";
import { createAuth, SERVER_OWNED_DEFAULTS } from "../apps/web/lib/auth/create-auth";
import { ALLOWED_AUTH_ENDPOINTS, DISABLED_AUTH_PATHS } from "../apps/web/lib/auth/endpoints";
import { AUTH_MESSAGES } from "../apps/web/lib/auth/messages";
import { SITE } from "../apps/web/lib/site";

// F08: Better Auth set-up (hooks, server-owned fields, lockdown list, settings check).
// Uses Better Auth's in-memory database; no network.

const config = { secret: "test-secret-0123456789-abcdefghijklmnop", baseURL: "http://localhost:3230", appOrigin: "http://localhost:3230" };

function setup(invited: string[] = []) {
  const store: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] };
  const checked: string[] = [];
  const linked: { email: string; userId: string }[] = [];
  const auth = createAuth({
    config,
    database: memoryAdapter(store),
    invites: {
      isInvited: async (email) => {
        checked.push(email);
        return invited.includes(email);
      },
      markSignedUp: async (email, userId) => {
        linked.push({ email, userId });
      },
    },
    logError: () => undefined,
  });
  return { auth, store, checked, linked };
}

const password = `Test-${Math.random().toString(36).slice(2)}-pass`;

async function errorOf(promise: Promise<unknown>): Promise<{ statusCode?: number; body?: { code?: string; message?: string } }> {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode?: number; body?: { code?: string; message?: string } };
  }
  throw new Error("expected an error");
}

describe("sign-up hooks (allow-list)", () => {
  it("lets an invited email sign up and links the invite", async () => {
    const { auth, store, linked } = setup(["priya@example.com"]);
    const res = await auth.api.signUpEmail({ body: { name: "Priya", email: "priya@example.com", password } });
    expect(res.user.email).toBe("priya@example.com");
    expect(res.token).toBeTruthy();
    expect(store.user).toHaveLength(1);
    expect(store.account?.[0]?.password).not.toBe(password);
    expect(linked).toEqual([{ email: "priya@example.com", userId: res.user.id }]);
  });

  it("refuses an email that is not invited with 403 NOT_ALLOWLISTED and creates nothing", async () => {
    const { auth, store, linked } = setup(["priya@example.com"]);
    const err = await errorOf(auth.api.signUpEmail({ body: { name: "X", email: "stranger@example.com", password } }));
    expect(err.statusCode).toBe(403);
    expect(err.body).toMatchObject({ code: "NOT_ALLOWLISTED", message: AUTH_MESSAGES.NOT_ALLOWLISTED });
    expect(store.user).toHaveLength(0);
    expect(store.account).toHaveLength(0);
    expect(linked).toHaveLength(0);
  });

  it("checks and stores the lowercased email", async () => {
    const { auth, store, checked } = setup(["priya.sharma@example.com"]);
    await auth.api.signUpEmail({ body: { name: "Priya", email: "Priya.Sharma@Example.COM", password } });
    expect(checked).toEqual(["priya.sharma@example.com"]);
    expect(store.user?.[0]?.email).toBe("priya.sharma@example.com");
  });

  it("the private-beta message uses the configured product name", () => {
    expect(AUTH_MESSAGES.NOT_ALLOWLISTED).toBe(`${SITE.name} is in private beta — request access`);
  });
});

describe("server-owned user fields (input: false)", () => {
  it("ignores role/status/defaults sent in the sign-up body", async () => {
    const { auth, store } = setup(["eve@example.com"]);
    const body = {
      name: "Eve",
      email: "eve@example.com",
      password,
      role: "admin",
      status: "suspended",
      timezone: "UTC",
      defaultLanguage: "hi",
      defaultVoiceGender: "male",
      failedLoginCount: -5,
      lockedUntil: new Date(0).toISOString(),
      lastLoginAt: new Date(0).toISOString(),
    };
    const res = await auth.api.signUpEmail({ body });
    expect(res.user).toMatchObject({ role: "creator", status: "active", timezone: "Asia/Kolkata", defaultLanguage: "en", defaultVoiceGender: "female" });
    expect(store.user?.[0]).toMatchObject(SERVER_OWNED_DEFAULTS);
  });

  it("keeps the login-protection fields out of API answers", async () => {
    const { auth } = setup(["a@example.com"]);
    const res = await auth.api.signUpEmail({ body: { name: "A", email: "a@example.com", password } });
    expect(res.user).not.toHaveProperty("failedLoginCount");
    expect(res.user).not.toHaveProperty("lockedUntil");
    expect(res.user).not.toHaveProperty("lastLoginAt");
  });
});

describe("log in (F09): only active users get a session", () => {
  async function signedUp() {
    const s = setup(["priya@example.com"]);
    await s.auth.api.signUpEmail({ body: { name: "Priya", email: "priya@example.com", password } });
    s.store.session = [];
    return s;
  }

  it("an active user logs in", async () => {
    const { auth, store } = await signedUp();
    const res = await auth.api.signInEmail({ body: { email: "priya@example.com", password } });
    expect(res.token).toBeTruthy();
    expect(store.session).toHaveLength(1);
  });

  it.each(["suspended", "deleting"])("a %s user is refused with 403 ACCOUNT_SUSPENDED and gets no session", async (status) => {
    const { auth, store } = await signedUp();
    (store.user?.[0] as Record<string, unknown>).status = status;
    const err = await errorOf(auth.api.signInEmail({ body: { email: "priya@example.com", password } }));
    expect(err.statusCode).toBe(403);
    expect(err.body).toMatchObject({ code: "ACCOUNT_SUSPENDED", message: AUTH_MESSAGES.ACCOUNT_SUSPENDED });
    expect(store.session).toHaveLength(0);
  });

  it("a wrong password for a suspended user still gets the generic 401 (status checked after the password)", async () => {
    const { auth, store } = await signedUp();
    (store.user?.[0] as Record<string, unknown>).status = "suspended";
    const err = await errorOf(auth.api.signInEmail({ body: { email: "priya@example.com", password: "wrong-password-1" } }));
    expect(err.statusCode).toBe(401);
    expect(err.body?.code).toBe("INVALID_EMAIL_OR_PASSWORD");
  });

  it("an unknown email gets the same 401 as a wrong password", async () => {
    const { auth } = await signedUp();
    const err = await errorOf(auth.api.signInEmail({ body: { email: "nobody@example.com", password } }));
    expect(err.statusCode).toBe(401);
    expect(err.body?.code).toBe("INVALID_EMAIL_OR_PASSWORD");
  });

  it("the paused-account message uses the configured product name", () => {
    expect(AUTH_MESSAGES.ACCOUNT_SUSPENDED).toBe(`Your account is paused. Contact the ${SITE.name} team.`);
  });
});

describe("password rules", () => {
  it.each([
    ["short", "1234567", "PASSWORD_TOO_SHORT"],
    ["long", "x".repeat(129), "PASSWORD_TOO_LONG"],
  ])("refuses a %s password", async (_label, pw, code) => {
    const { auth } = setup(["a@example.com"]);
    const err = await errorOf(auth.api.signUpEmail({ body: { name: "A", email: "a@example.com", password: pw } }));
    expect(err.statusCode).toBe(400);
    expect(err.body?.code).toBe(code);
  });
});

describe("lockdown list", () => {
  it("exposes exactly the 6 documented endpoints", () => {
    expect(ALLOWED_AUTH_ENDPOINTS.map((e) => `${e.method} ${e.path}`)).toEqual([
      "POST /sign-up/email",
      "POST /sign-in/email",
      "POST /sign-out",
      "GET /get-session",
      "POST /change-password",
      "POST /reset-password",
    ]);
  });

  it("disables every other Better Auth endpoint (fails if an upgrade adds one)", () => {
    const { auth } = setup();
    const allowed = new Set<string>(ALLOWED_AUTH_ENDPOINTS.map((e) => e.path));
    const disabled = new Set<string>(DISABLED_AUTH_PATHS);
    const paths = Object.values(auth.api as Record<string, { path?: string }>)
      .map((endpoint) => endpoint.path)
      .filter((p): p is string => typeof p === "string");
    expect(paths.length).toBeGreaterThan(20);
    const notCovered = paths.filter((p) => !allowed.has(p) && !disabled.has(p) && !p.includes(":"));
    expect(notCovered).toEqual([]);
    // Every path we disable really exists (no typos).
    expect([...disabled].filter((p) => !paths.includes(p))).toEqual([]);
  });
});

describe("readAuthConfig", () => {
  const good = { BETTER_AUTH_SECRET: "s".repeat(32), BETTER_AUTH_URL: "http://localhost:3000" };

  it("accepts a good secret and URL", () => {
    expect(readAuthConfig(good)).toEqual({ ok: true, config: { secret: "s".repeat(32), baseURL: "http://localhost:3000", appOrigin: "http://localhost:3000" } });
    expect(readAuthConfig({ ...good, BETTER_AUTH_URL: "https://bytereel.app/" })).toMatchObject({ ok: true, config: { appOrigin: "https://bytereel.app" } });
  });

  it.each([
    [{ ...good, BETTER_AUTH_SECRET: "" }, "BETTER_AUTH_SECRET is missing"],
    [{ ...good, BETTER_AUTH_SECRET: "short-secret" }, "too short"],
    [{ ...good, BETTER_AUTH_URL: "" }, "BETTER_AUTH_URL is missing"],
    [{ ...good, BETTER_AUTH_URL: "localhost:3000" }, "BETTER_AUTH_URL must be"],
    [{ ...good, BETTER_AUTH_URL: "http://localhost:3000/api/auth" }, "BETTER_AUTH_URL must be"],
    [{ ...good, BETTER_AUTH_URL: "ftp://x.com" }, "BETTER_AUTH_URL must be"],
  ])("reports a problem (%#)", (env, text) => {
    const r = readAuthConfig(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).toContain(text);
  });

  it("never repeats the secret in a message", () => {
    const r = readAuthConfig({ BETTER_AUTH_SECRET: "tooshort-SECRETVALUE", BETTER_AUTH_URL: "" });
    expect(JSON.stringify(r)).not.toContain("SECRETVALUE");
  });
});

describe("markInviteSignedUp", () => {
  it("fills signedUpUserId only when it is still empty, as an ObjectId", async () => {
    const { markInviteSignedUp } = await import("@bytereel/db");
    const { ObjectId } = await import("mongodb");
    const calls: { filter: unknown; update: unknown }[] = [];
    const db = {
      collection: (name: string) => {
        expect(name).toBe("allowlist");
        return { updateOne: async (filter: unknown, update: unknown) => (calls.push({ filter, update }), { modifiedCount: 1 }) };
      },
    } as unknown as Parameters<typeof markInviteSignedUp>[0];
    const id = new ObjectId().toHexString();
    expect(await markInviteSignedUp(db, " Priya@Example.com ", id)).toBe(true);
    expect(calls[0]?.filter).toEqual({ email: "priya@example.com", signedUpUserId: null });
    expect(calls[0]?.update).toEqual({ $set: { signedUpUserId: new ObjectId(id) } });
    await expect(markInviteSignedUp(db, "priya@example.com", "not-an-id")).rejects.toThrow();
  });
});
