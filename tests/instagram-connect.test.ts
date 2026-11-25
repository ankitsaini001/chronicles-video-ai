import {
  API_RATE_LIMITS,
  decryptToken,
  disconnectInstagram,
  eligibleAccountType,
  encryptToken,
  InstagramAccountInUseError,
  InstagramBusyError,
  readTokenKeys,
  saveInstagramConnection,
  tokenAad,
  TokenDecryptError,
  toInstagramConnectionResource,
  type InstagramConnectionDocument,
  type InstagramConnectionToSave,
  type RateLimitResult,
  type TokenKeys,
} from "@bytereel/db";
import { type Db, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { ApiProblem } from "../apps/web/lib/api/v1";
import type { SessionUser } from "../apps/web/lib/auth/session";
import { readInstagramConfig } from "../apps/web/lib/instagram/config";
import { finishConnect, setupFailed, startConnect, type InstagramFlowDeps } from "../apps/web/lib/instagram/connect";
import { connectionStatus, disconnectConnection, meInstagram } from "../apps/web/lib/instagram/connection";
import { FakeInstagramApi, fakeCode, fakeIgUserId } from "../apps/web/lib/instagram/fake-instagram";
import { instagramNotice, INSTAGRAM_MESSAGES } from "../apps/web/lib/instagram/messages";
import { InstagramApiError, MetaInstagramApi, type InstagramApi } from "../apps/web/lib/instagram/meta-client";
import { fakeInstagramProblem, instagramApiFromEnv } from "../apps/web/lib/instagram/provider";
import { parseReturnTo, signState, stateKey, STATE_TTL_SECONDS, verifyState } from "../apps/web/lib/instagram/state";
import { SITE } from "../apps/web/lib/site";

// F28 "Connect / disconnect Instagram": token encryption (AES-256-GCM, a new IV each time, key
// versions), the signed OAuth state (expiry, tampering, bound to the login session), the account
// type rule, the settings checks (names only, never values), the Meta client's parsing and errors
// (no token / secret / Instagram text anywhere), G2/G3 with fakes (every error path, owner checks),
// the connection transaction and disconnect (fake database), G1/G4 and B1. ZERO network calls:
// the Meta client gets a fake fetch. tools/e2e/f28-instagram.ts covers the real database and HTTP.

const OWNER = new ObjectId("67330c1a9f1e4b2a7c0d1e01");
const OTHER = new ObjectId("67330c1a9f1e4b2a7c0d1e99");
const PROJECT = "67330d5e9f1e4b2a7c0d2a10";
const FOREIGN_PROJECT = "67330d5e9f1e4b2a7c0d2a99";
const NOW = new Date("2026-11-22T06:00:00.000Z");
const KEY_1 = Buffer.alloc(32, 7).toString("base64");
const KEY_2 = Buffer.alloc(32, 9).toString("base64");
const AUTH_SECRET = "a-test-only-auth-secret-that-is-long-enough-123";
const APP_SECRET = "appsecret-test-0123456789abcdef";
/** The record a test token belongs to (F28 review: AAD `${ownerId}:${igUserId}`). */
const AAD = `${OWNER.toHexString()}:17841400000000001`;

const user: SessionUser = {
  id: OWNER.toHexString(),
  name: "Ananya Iyer",
  email: "ananya.iyer@example.in",
  role: "creator",
  timezone: "Asia/Kolkata",
  defaultLanguage: "en",
  defaultVoiceGender: "female",
  createdAt: "2026-11-12T04:30:00.000Z",
};

function keys(env: Record<string, string> = {}): TokenKeys {
  const result = readTokenKeys({ TOKEN_ENCRYPTION_KEYS: JSON.stringify({ "1": KEY_1 }), TOKEN_ENCRYPTION_ACTIVE_VERSION: "1", ...env });
  if (!result.ok) throw new Error(result.problems.join(" "));
  return result.keys;
}

describe("token encryption (AES-256-GCM, DATABASE.md §6.2)", () => {
  it("round-trips, records the key version, and never stores the plain token", () => {
    const enc = encryptToken("IGQVJ-secret-token", keys(), AAD);
    expect(enc.keyVersion).toBe("1");
    expect(JSON.stringify(enc)).not.toContain("IGQVJ-secret-token");
    expect(Buffer.from(enc.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(enc.tag, "base64")).toHaveLength(16);
    expect(decryptToken(enc, keys(), AAD)).toBe("IGQVJ-secret-token");
  });

  it("a NEW random IV every time: the same token encrypts differently", () => {
    const a = encryptToken("same", keys(), AAD);
    const b = encryptToken("same", keys(), AAD);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("a wrong key, a changed tag, changed data or an unknown version all fail", () => {
    const enc = encryptToken("token", keys(), AAD);
    const wrong = keys({ TOKEN_ENCRYPTION_KEYS: JSON.stringify({ "1": KEY_2 }) });
    expect(() => decryptToken(enc, wrong, AAD)).toThrow(TokenDecryptError);
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] = buf[0]! ^ 1;
      return buf.toString("base64");
    };
    expect(() => decryptToken({ ...enc, tag: flip(enc.tag) }, keys(), AAD)).toThrow(TokenDecryptError);
    expect(() => decryptToken({ ...enc, ciphertext: flip(enc.ciphertext) }, keys(), AAD)).toThrow(TokenDecryptError);
    expect(() => decryptToken({ ...enc, keyVersion: "7" }, keys(), AAD)).toThrow(TokenDecryptError);
  });

  it("bound to its record: another owner's or another Instagram account's AAD can't decrypt it", () => {
    const enc = encryptToken("token", keys(), tokenAad(OWNER, "17841400000000001"));
    expect(decryptToken(enc, keys(), tokenAad(OWNER.toHexString(), "17841400000000001"))).toBe("token");
    expect(() => decryptToken(enc, keys(), tokenAad(OTHER, "17841400000000001"))).toThrow(TokenDecryptError);
    expect(() => decryptToken(enc, keys(), tokenAad(OWNER, "17841400000000002"))).toThrow(TokenDecryptError);
  });

  it("rotation: version 2 encrypts new tokens, version 1 still reads old ones", () => {
    const old = encryptToken("old", keys(), AAD);
    const both = keys({ TOKEN_ENCRYPTION_KEYS: JSON.stringify({ "1": KEY_1, "2": KEY_2 }), TOKEN_ENCRYPTION_ACTIVE_VERSION: "2" });
    const fresh = encryptToken("new", both, AAD);
    expect(fresh.keyVersion).toBe("2");
    expect(decryptToken(old, both, AAD)).toBe("old");
    expect(decryptToken(fresh, both, AAD)).toBe("new");
  });

  it("settings problems name the setting, never the value", () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    const cases = [
      {},
      { TOKEN_ENCRYPTION_KEYS: "not json", TOKEN_ENCRYPTION_ACTIVE_VERSION: "1" },
      { TOKEN_ENCRYPTION_KEYS: JSON.stringify({ "1": short }), TOKEN_ENCRYPTION_ACTIVE_VERSION: "1" },
      { TOKEN_ENCRYPTION_KEYS: JSON.stringify({ "1": KEY_1 }), TOKEN_ENCRYPTION_ACTIVE_VERSION: "2" },
      { TOKEN_ENCRYPTION_KEYS: JSON.stringify({ "1": KEY_1 }) },
    ];
    for (const env of cases) {
      const result = readTokenKeys(env);
      expect(result.ok).toBe(false);
      const text = result.ok ? "" : result.problems.join(" ");
      expect(text).toMatch(/TOKEN_ENCRYPTION_(KEYS|ACTIVE_VERSION)/);
      expect(text).not.toContain(KEY_1);
      expect(text).not.toContain(short);
    }
  });
});

describe("the OAuth state (signed, 10 minutes, bound to the login session)", () => {
  const key = stateKey(AUTH_SECRET);

  it("verifies for the same session and gives back returnTo", () => {
    const state = signState(key, "session-1", { kind: "publish", projectId: PROJECT }, NOW);
    expect(verifyState(key, state, "session-1", NOW)).toEqual({ ok: true, returnTo: { kind: "publish", projectId: PROJECT } });
    expect(state).not.toContain("session-1");
  });

  it("expired after 10 minutes; another session; another secret; tampered", () => {
    const state = signState(key, "session-1", { kind: "settings" }, NOW);
    const later = new Date(NOW.getTime() + STATE_TTL_SECONDS * 1000);
    expect(verifyState(key, state, "session-1", later)).toMatchObject({ ok: false, reason: "expired" });
    expect(verifyState(key, state, "session-2", NOW)).toMatchObject({ ok: false, reason: "other_session", returnTo: { kind: "settings" } });
    expect(verifyState(key, state, null, NOW)).toMatchObject({ ok: false, reason: "other_session" });
    expect(verifyState(stateKey(`${AUTH_SECRET}x`), state, "session-1", NOW)).toEqual({ ok: false, reason: "tampered" });
    const [body, sig] = state.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, r: `publish:${FOREIGN_PROJECT}` })).toString("base64url");
    expect(verifyState(key, `${forgedBody}.${sig}`, "session-1", NOW)).toEqual({ ok: false, reason: "tampered" });
    for (const junk of ["", "abc", "a.b.c", `${body}.`, `${body}.${"A".repeat(43)}`]) expect(verifyState(key, junk, "session-1", NOW)).toEqual({ ok: false, reason: "tampered" });
  });

  it("returnTo: settings (default) or publish:<24 hex>, nothing else", () => {
    expect(parseReturnTo(null)).toEqual({ kind: "settings" });
    expect(parseReturnTo("settings")).toEqual({ kind: "settings" });
    expect(parseReturnTo(`publish:${PROJECT}`)).toEqual({ kind: "publish", projectId: PROJECT });
    for (const bad of ["", "publish:", "publish:xyz", "https://evil.example", "/dashboard", `publish:${PROJECT}x`, "SETTINGS"]) expect(parseReturnTo(bad)).toBeNull();
  });
});

describe("the account type rule and the messages", () => {
  it("only Business and Media_Creator (any case); personal and anything else → null", () => {
    expect(eligibleAccountType("Business")).toBe("BUSINESS");
    expect(eligibleAccountType("MEDIA_CREATOR")).toBe("MEDIA_CREATOR");
    expect(eligibleAccountType("Media_Creator")).toBe("MEDIA_CREATOR");
    for (const other of ["PERSONAL", "Personal", "", null, undefined, 3, "CREATOR"]) expect(eligibleAccountType(other)).toBeNull();
  });

  it("each way back from Instagram has one plain line; the product name comes from SITE", () => {
    expect(instagramNotice({ instagram: "connected" })).toEqual({ tone: "success", text: "Instagram connected." });
    expect(instagramNotice({ instagram_error: "INSTAGRAM_ACCOUNT_INELIGIBLE" })?.text).toBe(INSTAGRAM_MESSAGES.ineligible);
    expect(instagramNotice({ instagram_error: "INSTAGRAM_ACCOUNT_IN_USE" })?.text).toBe(`This Instagram account is already connected to another ${SITE.name} account.`);
    expect(instagramNotice({ instagram_error: "INSTAGRAM_OAUTH_FAILED", reason: "access_denied" })?.text).toBe(INSTAGRAM_MESSAGES.denied);
    expect(instagramNotice({ instagram_error: "INSTAGRAM_OAUTH_FAILED", reason: "invalid_state" })?.text).toBe(INSTAGRAM_MESSAGES.invalidState);
    expect(instagramNotice({ instagram_error: "INSTAGRAM_OAUTH_FAILED", reason: "not_set_up" })?.text).toBe(INSTAGRAM_MESSAGES.notSetUp);
    expect(instagramNotice({ instagram_error: "<script>" })?.text).toBe(INSTAGRAM_MESSAGES.exchangeFailed);
    expect(instagramNotice({})).toBeNull();
  });
});

describe("settings and the stand-in switch", () => {
  it("Instagram settings: problems by name; the redirect defaults to BETTER_AUTH_URL + the callback path", () => {
    const missing = readInstagramConfig({ BETTER_AUTH_URL: "http://localhost:3000" });
    expect(missing.ok).toBe(false);
    expect(missing.ok ? "" : missing.problems.join(" ")).toMatch(/INSTAGRAM_APP_ID.*INSTAGRAM_APP_SECRET/);
    const ok = readInstagramConfig({ INSTAGRAM_APP_ID: "1234567890", INSTAGRAM_APP_SECRET: APP_SECRET, BETTER_AUTH_URL: "http://localhost:3000" });
    expect(ok).toEqual({ ok: true, config: { appId: "1234567890", appSecret: APP_SECRET, redirectUri: "http://localhost:3000/api/v1/instagram/callback" } });
    const explicit = readInstagramConfig({ INSTAGRAM_APP_ID: "1234567890", INSTAGRAM_APP_SECRET: APP_SECRET, INSTAGRAM_REDIRECT_URI: "https://tunnel.example.dev/api/v1/instagram/callback" });
    expect(explicit.ok && explicit.config.redirectUri).toBe("https://tunnel.example.dev/api/v1/instagram/callback");
    const bad = readInstagramConfig({ INSTAGRAM_APP_ID: "1234567890", INSTAGRAM_APP_SECRET: APP_SECRET, INSTAGRAM_REDIRECT_URI: "http://evil.example/api/v1/instagram/callback" });
    expect(bad.ok).toBe(false);
    const shortSecret = readInstagramConfig({ INSTAGRAM_APP_ID: "1234567890", INSTAGRAM_APP_SECRET: "tiny", BETTER_AUTH_URL: "http://localhost:3000" });
    expect(shortSecret.ok ? "" : shortSecret.problems.join(" ")).not.toContain("tiny");
  });

  it("the stand-in only on bytereel_test + a test port, not on Vercel; the real one is refused on bytereel_test", () => {
    const test = { MONGODB_URI: "mongodb+srv://u:p@cluster0.example.mongodb.net/", MONGODB_DB: "bytereel_test", BETTER_AUTH_URL: "http://localhost:3233", E2E_FAKE_INSTAGRAM: "1" };
    expect(fakeInstagramProblem(test)).toBeNull();
    expect(instagramApiFromEnv(test)).toMatchObject({ ok: true, fake: true });
    expect(fakeInstagramProblem({ ...test, MONGODB_DB: "bytereel" })).toMatch(/only allowed with MONGODB_DB=bytereel_test/);
    expect(fakeInstagramProblem({ ...test, BETTER_AUTH_URL: "http://localhost:3000" })).toMatch(/local test server/);
    expect(fakeInstagramProblem({ ...test, VERCEL: "1" })).toMatch(/Vercel/);
    expect(fakeInstagramProblem({ ...test, E2E_FAKE_INSTAGRAM: "yes" })).toMatch(/must be "1"/);
    const real = instagramApiFromEnv({ ...test, E2E_FAKE_INSTAGRAM: "", INSTAGRAM_APP_ID: "1234567890", INSTAGRAM_APP_SECRET: APP_SECRET });
    expect(real).toMatchObject({ ok: false });
    expect(instagramApiFromEnv({ ...test, MONGODB_DB: "bytereel", E2E_FAKE_INSTAGRAM: "", INSTAGRAM_APP_ID: "1234567890", INSTAGRAM_APP_SECRET: APP_SECRET })).toMatchObject({ ok: true, fake: false });
  });
});

// ---------- the Meta client with a fake fetch (no network) ----------

type Call = { url: string; init?: RequestInit | undefined };
function metaWith(answers: ((call: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const api = new MetaInstagramApi({ appId: "1234567890", appSecret: APP_SECRET, redirectUri: "http://localhost:3000/api/v1/instagram/callback" }, async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const answer = answers.shift();
    if (!answer) throw new Error("unexpected call");
    return answer(call);
  });
  return { api, calls };
}
const json = (body: unknown, status = 200) => () => Response.json(body, { status });

describe("the Meta client (Instagram API with Instagram Login)", () => {
  it("authorize URL: client id, exact redirect, code, the two scopes, state", () => {
    const url = new URL(metaWith([]).api.authorizeUrl("S.T"));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "1234567890",
      redirect_uri: "http://localhost:3000/api/v1/instagram/callback",
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_content_publish",
      state: "S.T",
    });
  });

  it("code → short-lived (form POST; data[] or flat) → long-lived → /me", async () => {
    const { api, calls } = metaWith([
      json({ data: [{ access_token: "SHORT-TOKEN", user_id: "17841400000000001", permissions: "instagram_business_basic,instagram_business_content_publish" }] }),
      json({ access_token: "LONG-TOKEN", token_type: "bearer", expires_in: 5183944 }),
      json({ data: [{ user_id: "17841400000000001", username: "physics.with.ananya", account_type: "Media_Creator", profile_picture_url: "https://scontent.cdninstagram.com/p.jpg" }] }),
    ]);
    const short = await api.exchangeCode("AQB");
    expect(short).toEqual({ accessToken: "SHORT-TOKEN", permissions: ["instagram_business_basic", "instagram_business_content_publish"] });
    expect(calls[0]!.url).toBe("https://api.instagram.com/oauth/access_token");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init?.body)))).toEqual({
      client_id: "1234567890",
      client_secret: APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: "http://localhost:3000/api/v1/instagram/callback",
      code: "AQB",
    });
    expect(await api.longLivedToken(short.accessToken)).toEqual({ accessToken: "LONG-TOKEN", expiresInSeconds: 5183944 });
    expect(new URL(calls[1]!.url).searchParams.get("grant_type")).toBe("ig_exchange_token");
    const profile = await api.profile("LONG-TOKEN");
    expect(profile).toEqual({ userId: "17841400000000001", username: "physics.with.ananya", accountType: "Media_Creator", profilePictureUrl: "https://scontent.cdninstagram.com/p.jpg" });
    const me = new URL(calls[2]!.url);
    expect(me.pathname).toBe("/v27.0/me");
    expect(me.searchParams.get("fields")).toBe("user_id,username,account_type,profile_picture_url");
    // The token goes in the address, as Meta's "Get started" page shows.
    expect(me.searchParams.get("access_token")).toBe("LONG-TOKEN");
  });

  it("the code exchange doesn't need user_id: a real 17-digit NUMBER (rounded by JSON) still works; a flat answer too", async () => {
    // As Instagram may send it: a JSON number larger than 2^53 (JavaScript can't hold it exactly).
    const raw = '{"access_token":"T","user_id":17841400000000001,"permissions":"instagram_business_basic,instagram_business_content_publish"}';
    const { api } = metaWith([() => new Response(raw, { headers: { "content-type": "application/json" } })]);
    expect(await api.exchangeCode("c")).toEqual({ accessToken: "T", permissions: ["instagram_business_basic", "instagram_business_content_publish"] });
    const flat = metaWith([json({ access_token: "T2" })]);
    expect(await flat.api.exchangeCode("c")).toEqual({ accessToken: "T2", permissions: null });
  });

  it("/me's user_id: text as is; an exact number is accepted; a rounded 17-digit number is REFUSED (never stored rounded)", async () => {
    const text = metaWith([json({ user_id: "17841400000000001", username: "a", account_type: "Business" })]);
    expect((await text.api.profile("t")).userId).toBe("17841400000000001");
    const exact = metaWith([json({ user_id: 1234567, username: "a", account_type: "Business" })]);
    expect((await exact.api.profile("t")).userId).toBe("1234567");
    const rounded = metaWith([() => new Response('{"user_id":17841400000000001,"username":"a","account_type":"Business"}', { headers: { "content-type": "application/json" } })]);
    const error = await rounded.api.profile("t").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstagramApiError);
    expect((error as InstagramApiError).kind).toBe("bad_answer");
  });

  it("errors say only the step and status: never a token, the secret or Instagram's text", async () => {
    const providerText = "Invalid OAuth access token - Cannot parse access token LONG-TOKEN";
    const cases: [() => Promise<unknown>, InstagramApiError["kind"]][] = [
      [() => metaWith([json({ error_type: "OAuthException", code: 400, error_message: providerText }, 400)]).api.exchangeCode("c"), "rejected"],
      [() => metaWith([json({ error: { message: providerText } }, 500)]).api.longLivedToken("SHORT-TOKEN"), "unavailable"],
      [() => metaWith([() => Promise.reject(Object.assign(new Error(`timeout ${providerText}`), { name: "TimeoutError" }))]).api.profile("LONG-TOKEN"), "timeout"],
      [() => metaWith([() => Promise.reject(new TypeError("fetch failed for https://graph.instagram.com/?access_token=LONG-TOKEN"))]).api.profile("LONG-TOKEN"), "unavailable"],
      [() => metaWith([json({ username: "x" })]).api.profile("LONG-TOKEN"), "bad_answer"],
    ];
    for (const [run, kind] of cases) {
      const error = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(InstagramApiError);
      expect((error as InstagramApiError).kind).toBe(kind);
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      for (const secret of ["LONG-TOKEN", "SHORT-TOKEN", APP_SECRET, "Invalid OAuth"]) expect(text).not.toContain(secret);
    }
  });

  it("a non-https profile picture is dropped", async () => {
    const { api } = metaWith([json({ user_id: "1", username: "a", account_type: "Business", profile_picture_url: "javascript:alert(1)" })]);
    expect((await api.profile("t")).profilePictureUrl).toBeNull();
  });
});

// ---------- G2 / G3 with fakes ----------

const allowed: RateLimitResult = { allowed: true, count: 1, limit: 10, resetsAt: NOW, retryAfterSeconds: 60 };
const keyEnv = { TOKEN_ENCRYPTION_KEYS: JSON.stringify({ "1": KEY_1 }), TOKEN_ENCRYPTION_ACTIVE_VERSION: "1" };

function flow(options: { session?: { sessionId: string; user: SessionUser } | null; api?: InstagramApi | null; keysOk?: boolean; save?: InstagramFlowDeps["save"]; rate?: RateLimitResult; now?: Date } = {}) {
  const logs: string[] = [];
  const saved: InstagramConnectionToSave[] = [];
  const rules: string[] = [];
  const deps: InstagramFlowDeps = {
    getSession: async () => (options.session === undefined ? { sessionId: "session-1", user } : options.session),
    hitRateLimit: async (rule) => (rules.push(rule.name), options.rate ?? allowed),
    ownsProject: async (userId, projectId) => userId === user.id && projectId === PROJECT,
    instagram: () => (options.api === null ? { ok: false, problems: ["INSTAGRAM_APP_ID is missing."] } : { ok: true, fake: true, api: options.api ?? new FakeInstagramApi("http://localhost:3233") }),
    tokenKeys: () => (options.keysOk === false ? readTokenKeys({}) : readTokenKeys(keyEnv)),
    stateKey: () => stateKey(AUTH_SECRET),
    save:
      options.save ??
      (async (_userId, input) => {
        saved.push(input);
        return { _id: new ObjectId(), ownerId: OWNER, schemaVersion: 1, connectedAt: NOW, lastRefreshedAt: NOW, revokedAt: null, status: "active", ...input };
      }),
    now: () => options.now ?? NOW,
    log: (m) => logs.push(m),
  };
  return { deps, logs, saved, rules };
}
const at = (path: string) => new Request(`http://localhost:3000${path}`);
const location = (r: Response) => r.headers.get("location") ?? "";
const stateFor = (returnTo: Parameters<typeof signState>[2], session = "session-1", now = NOW) => signState(stateKey(AUTH_SECRET), session, returnTo, now);
const callback = (params: Record<string, string>) => at(`/api/v1/instagram/callback?${new URLSearchParams(params)}`);
const publishBack = `/projects/${PROJECT}/publish`;

describe("G2 start connecting", () => {
  it("signed out → /login", async () => {
    const r = await startConnect(at("/api/v1/instagram/connect"), flow({ session: null }).deps);
    expect(r.status).toBe(302);
    expect(location(r)).toBe("/login");
  });

  it("bad returnTo → 400 INVALID_INPUT; another user's project → 404 (before the rate limit or Instagram)", async () => {
    const f = flow();
    const bad = await startConnect(at("/api/v1/instagram/connect?returnTo=https://evil.example"), f.deps);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.details.issues[0].path).toBe("returnTo");
    const foreign = await startConnect(at(`/api/v1/instagram/connect?returnTo=publish:${FOREIGN_PROJECT}`), f.deps);
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.code).toBe("NOT_FOUND");
    expect(f.rules).toEqual([]);
  });

  it("→ 302 to Instagram's login page with a state bound to this session (10/hour counter)", async () => {
    const f = flow();
    const r = await startConnect(at(`/api/v1/instagram/connect?returnTo=publish:${PROJECT}`), f.deps);
    expect(r.status).toBe(302);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const url = new URL(location(r));
    expect(url.pathname).toBe("/api/v1/instagram/e2e-authorize");
    expect(verifyState(stateKey(AUTH_SECRET), url.searchParams.get("state")!, "session-1", NOW)).toEqual({ ok: true, returnTo: { kind: "publish", projectId: PROJECT } });
    expect(f.rules).toEqual([API_RATE_LIMITS.instagramConnectPerUser.name]);
    const settings = await startConnect(at("/api/v1/instagram/connect"), f.deps);
    expect(verifyState(stateKey(AUTH_SECRET), new URL(location(settings)).searchParams.get("state")!, "session-1", NOW)).toMatchObject({ returnTo: { kind: "settings" } });
  });

  it("over the limit, or not set up → back to the page with a plain code (names in the log, no values)", async () => {
    const limited = await startConnect(at(`/api/v1/instagram/connect?returnTo=publish:${PROJECT}`), flow({ rate: { ...allowed, allowed: false } }).deps);
    expect(location(limited)).toBe(`${publishBack}?instagram_error=RATE_LIMITED`);
    const f = flow({ api: null, keysOk: false });
    const off = await startConnect(at(`/api/v1/instagram/connect?returnTo=publish:${PROJECT}`), f.deps);
    expect(location(off)).toBe(`${publishBack}?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=not_set_up`);
    expect(f.logs.join(" ")).toMatch(/INSTAGRAM_APP_ID.*TOKEN_ENCRYPTION_KEYS/);
    expect(f.logs.join(" ")).not.toContain(KEY_1);
    const settingsOff = await startConnect(at("/api/v1/instagram/connect"), flow({ api: null }).deps);
    expect(location(settingsOff)).toBe("/dashboard?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=not_set_up");
  });
});

describe("G3 the callback", () => {
  it("signed out → /login; no state, or neither code nor error → JSON 400", async () => {
    expect(location(await finishConnect(callback({ code: "x", state: "y" }), flow({ session: null }).deps))).toBe("/login");
    expect((await finishConnect(callback({ code: "x" }), flow().deps)).status).toBe(400);
    expect((await finishConnect(callback({ state: stateFor({ kind: "settings" }) }), flow().deps)).status).toBe(400);
  });

  it("Creator account → saved ENCRYPTED, back with ?instagram=connected; no token in the answer or the log", async () => {
    const f = flow();
    const r = await finishConnect(callback({ code: `${fakeCode("creator", "ananya")}#_`, state: stateFor({ kind: "publish", projectId: PROJECT }) }), f.deps);
    expect(r.status).toBe(302);
    expect(location(r)).toBe(`${publishBack}?instagram=connected`);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(f.saved).toHaveLength(1);
    const s = f.saved[0]!;
    expect(s).toMatchObject({ igUserId: fakeIgUserId("ananya"), username: "e2e_ananya", accountType: "MEDIA_CREATOR", scopes: ["instagram_business_basic", "instagram_business_content_publish"] });
    expect(f.rules).toEqual([API_RATE_LIMITS.instagramCallbackPerUser.name]);
    expect(s.tokenExpiresAt.toISOString()).toBe(new Date(NOW.getTime() + 60 * 86400 * 1000).toISOString());
    const plain = decryptToken(s.accessToken, keys(), tokenAad(OWNER, fakeIgUserId("ananya")));
    expect(plain).toMatch(/^e2e-long\.creator\.ananya\./);
    expect(JSON.stringify(s)).not.toContain(plain);
    expect(`${location(r)} ${[...r.headers.values()].join(" ")} ${await r.text()} ${f.logs.join(" ")}`).not.toContain("e2e-long");
  });

  it("Business works; a personal account → INSTAGRAM_ACCOUNT_INELIGIBLE and NOTHING is saved", async () => {
    const f = flow();
    expect(location(await finishConnect(callback({ code: fakeCode("business", "shop"), state: stateFor({ kind: "settings" }) }), f.deps))).toBe("/dashboard?instagram=connected");
    expect(f.saved[0]!.accountType).toBe("BUSINESS");
    const p = flow();
    const r = await finishConnect(callback({ code: fakeCode("personal", "me"), state: stateFor({ kind: "publish", projectId: PROJECT }) }), p.deps);
    expect(location(r)).toBe(`${publishBack}?instagram_error=INSTAGRAM_ACCOUNT_INELIGIBLE`);
    expect(p.saved).toHaveLength(0);
  });

  it("Cancel on Instagram → access_denied (no call to Instagram, nothing saved)", async () => {
    const calls: string[] = [];
    const spy: InstagramApi = { authorizeUrl: () => "", exchangeCode: async () => (calls.push("x"), Promise.reject(new Error("no"))), longLivedToken: async () => Promise.reject(new Error("no")), profile: async () => Promise.reject(new Error("no")) };
    const f = flow({ api: spy });
    const r = await finishConnect(callback({ error: "access_denied", error_reason: "user_denied", error_description: "The user denied your request.", state: stateFor({ kind: "publish", projectId: PROJECT }) }), f.deps);
    expect(location(r)).toBe(`${publishBack}?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=access_denied`);
    expect(calls).toEqual([]);
    expect(f.saved).toHaveLength(0);
  });

  it("forged state → dashboard; expired or another session's → its own page; all invalid_state, nothing called", async () => {
    const f = flow();
    const good = stateFor({ kind: "publish", projectId: PROJECT });
    const [body] = good.split(".");
    expect(location(await finishConnect(callback({ code: fakeCode("creator", "a"), state: `${body}.AAAA` }), f.deps))).toBe("/dashboard?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=invalid_state");
    const expired = stateFor({ kind: "publish", projectId: PROJECT }, "session-1", new Date(NOW.getTime() - 11 * 60_000));
    expect(location(await finishConnect(callback({ code: fakeCode("creator", "a"), state: expired }), f.deps))).toBe(`${publishBack}?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=invalid_state`);
    const otherSession = stateFor({ kind: "publish", projectId: PROJECT }, "session-2");
    expect(location(await finishConnect(callback({ code: fakeCode("creator", "a"), state: otherSession }), f.deps))).toBe(`${publishBack}?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=invalid_state`);
    expect(f.saved).toHaveLength(0);
  });

  it("a state naming ANOTHER user's project (signed, e.g. their own login) goes back to the dashboard", async () => {
    const f = flow();
    const r = await finishConnect(callback({ code: fakeCode("creator", "a"), state: stateFor({ kind: "publish", projectId: FOREIGN_PROJECT }) }), f.deps);
    expect(location(r)).toBe("/dashboard?instagram=connected");
  });

  it("posting not allowed on Instagram's page → missing_permission, NOTHING saved; no permission list → scopes [] (unknown)", async () => {
    const f = flow();
    const r = await finishConnect(callback({ code: fakeCode("nopublish", "a"), state: stateFor({ kind: "publish", projectId: PROJECT }) }), f.deps);
    expect(location(r)).toBe(`${publishBack}?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=missing_permission`);
    expect(f.saved).toHaveLength(0);
    expect(instagramNotice({ instagram_error: "INSTAGRAM_OAUTH_FAILED", reason: "missing_permission" })?.text).toBe("Please allow posting when Instagram asks, then connect again.");
    const noList = new FakeInstagramApi("http://localhost:3233");
    const api: InstagramApi = { authorizeUrl: (s) => noList.authorizeUrl(s), exchangeCode: async (c) => ({ ...(await noList.exchangeCode(c)), permissions: null }), longLivedToken: (t) => noList.longLivedToken(t), profile: (t) => noList.profile(t) };
    const g = flow({ api });
    expect(location(await finishConnect(callback({ code: fakeCode("creator", "a"), state: stateFor({ kind: "settings" }) }), g.deps))).toBe("/dashboard?instagram=connected");
    expect(g.saved[0]!.scopes).toEqual([]);
  });

  it("G3's own counter (20/hour): over it → RATE_LIMITED before any call to Instagram; a bad state isn't counted", async () => {
    const calls: string[] = [];
    const spy: InstagramApi = { authorizeUrl: () => "", exchangeCode: async () => (calls.push("x"), Promise.reject(new Error("no"))), longLivedToken: async () => Promise.reject(new Error("no")), profile: async () => Promise.reject(new Error("no")) };
    const f = flow({ api: spy, rate: { ...allowed, allowed: false } });
    const r = await finishConnect(callback({ code: fakeCode("creator", "a"), state: stateFor({ kind: "publish", projectId: PROJECT }) }), f.deps);
    expect(location(r)).toBe(`${publishBack}?instagram_error=RATE_LIMITED`);
    expect(calls).toEqual([]);
    expect(f.rules).toEqual([API_RATE_LIMITS.instagramCallbackPerUser.name]);
    expect(API_RATE_LIMITS.instagramCallbackPerUser).toMatchObject({ limit: 20, windowSeconds: 3600 });
    const g = flow();
    await finishConnect(callback({ code: fakeCode("creator", "a"), state: "forged.state" }), g.deps);
    expect(g.rules).toEqual([]);
  });

  it("the routes' setup failing (e.g. no database settings) → My videos with reason=not_set_up, the error's name in the log", () => {
    const logs: string[] = [];
    const r = setupFailed(callback({ code: "x", state: "y" }), new Error("The database is not set up (MONGODB_URI)."), (m) => logs.push(m));
    expect(r.status).toBe(302);
    expect(location(r)).toBe("/dashboard?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=not_set_up");
    expect(logs.join(" ")).toMatch(/not set up.*Error/);
  });

  it("already active for another user → INSTAGRAM_ACCOUNT_IN_USE (the new token is dropped)", async () => {
    const f = flow({ save: async () => Promise.reject(new InstagramAccountInUseError()) });
    const r = await finishConnect(callback({ code: fakeCode("creator", "shared"), state: stateFor({ kind: "publish", projectId: PROJECT }) }), f.deps);
    expect(location(r)).toBe(`${publishBack}?instagram_error=INSTAGRAM_ACCOUNT_IN_USE`);
  });

  it("the code exchange fails → exchange_failed (log: step + status only); not set up → not_set_up; a database failure → exchange_failed, no data in the log", async () => {
    const f = flow();
    expect(location(await finishConnect(callback({ code: fakeCode("broken", "a"), state: stateFor({ kind: "publish", projectId: PROJECT }) }), f.deps))).toBe(`${publishBack}?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=exchange_failed`);
    expect(f.logs.join(" ")).toMatch(/code_exchange failed: rejected \(HTTP 400\)/);
    expect(location(await finishConnect(callback({ code: fakeCode("creator", "a"), state: stateFor({ kind: "settings" }) }), flow({ keysOk: false }).deps))).toBe("/dashboard?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=not_set_up");
    const db = flow({ save: async () => Promise.reject(Object.assign(new Error("write failed with e2e-long.creator.a.SECRET"), { code: 112 })) });
    expect(location(await finishConnect(callback({ code: fakeCode("creator", "a"), state: stateFor({ kind: "settings" }) }), db.deps))).toBe("/dashboard?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=exchange_failed");
    expect(db.logs.join(" ")).toMatch(/Error \(code 112\)/);
    expect(db.logs.join(" ")).not.toContain("e2e-long");
  });
});

// ---------- the connection transaction (fake database) ----------

function fakeDb(handlers: Record<string, (...args: any[]) => unknown>) {
  const calls: { name: string; args: any[] }[] = [];
  const collection = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => (...args: any[]) => {
          const key = `${name}.${method}`;
          calls.push({ name: key, args });
          const handler = handlers[key];
          if (!handler) throw new Error(`unexpected ${key}`);
          // `find` returns a cursor right away (its `.toArray()` is the async part).
          if (method === "find") return handler(...args);
          try {
            return Promise.resolve(handler(...args));
          } catch (error) {
            return Promise.reject(error);
          }
        },
      },
    );
  let transactions = 0;
  const session = { withTransaction: async (fn: () => Promise<void>) => (transactions++, fn()), endSession: async () => undefined };
  const db = { client: { startSession: () => session }, collection } as unknown as Db;
  return { db, calls, names: () => calls.map((c) => c.name), transactions: () => transactions };
}

const toSave = (): InstagramConnectionToSave => ({
  igUserId: "17841400000000001",
  username: "physics.with.ananya",
  accountType: "MEDIA_CREATOR",
  profilePictureUrl: null,
  accessToken: encryptToken("PLAIN-TOKEN", keys(), AAD),
  tokenExpiresAt: new Date("2027-01-21T06:00:00.000Z"),
  scopes: ["instagram_business_basic", "instagram_business_content_publish"],
});
const existingDoc = (overrides: { [K in keyof InstagramConnectionDocument]?: InstagramConnectionDocument[K] | undefined } = {}): InstagramConnectionDocument => ({
  _id: new ObjectId("6733101a9f1e4b2a7c0d7a01"),
  ownerId: OWNER,
  schemaVersion: 1,
  connectedAt: NOW,
  lastRefreshedAt: NOW,
  revokedAt: null,
  status: "active",
  ...toSave(),
  ...(overrides as Partial<InstagramConnectionDocument>),
});

describe("saveInstagramConnection: one transaction, one account per user both ways", () => {
  it("new connection: checks no OTHER user has it active, inserts, audits instagram.connected (no token in the audit)", async () => {
    const fake = fakeDb({ "instagramConnections.findOne": () => null, "instagramConnections.insertOne": () => ({}), "auditLogs.insertOne": () => ({}) });
    const doc = await saveInstagramConnection(fake.db, OWNER.toHexString(), toSave(), NOW);
    expect(fake.transactions()).toBe(1);
    expect(fake.calls[0]!.args[0]).toEqual({ igUserId: "17841400000000001", status: "active", ownerId: { $ne: OWNER } });
    expect(fake.calls[1]!.args[0]).toEqual({ ownerId: OWNER });
    expect(doc).toMatchObject({ ownerId: OWNER, status: "active", revokedAt: null, connectedAt: NOW, lastRefreshedAt: NOW });
    const audit = fake.calls.find((c) => c.name === "auditLogs.insertOne")!.args[0];
    expect(audit).toMatchObject({ actorId: OWNER, action: "instagram.connected", subject: { type: "instagramConnection", id: doc._id }, data: { reconnected: false } });
    expect(JSON.stringify(audit)).not.toContain(toSave().accessToken.ciphertext);
    for (const call of fake.calls) expect(call.args[1]).toHaveProperty("session");
  });

  it("reconnect: replaces the user's own document (same id), revokedAt cleared", async () => {
    const old = existingDoc({ status: "revoked", revokedAt: NOW, accessToken: undefined });
    const fake = fakeDb({ "instagramConnections.findOne": (f: any) => (f.ownerId?.$ne ? null : old), "instagramConnections.replaceOne": () => ({}), "auditLogs.insertOne": () => ({}) });
    const doc = await saveInstagramConnection(fake.db, OWNER, toSave(), NOW);
    expect(doc._id.equals(old._id)).toBe(true);
    const replaced = fake.calls.find((c) => c.name === "instagramConnections.replaceOne")!.args;
    expect(replaced[0]).toEqual({ _id: old._id, ownerId: OWNER });
    expect(replaced[1]).toMatchObject({ status: "active", revokedAt: null });
    expect(fake.calls.find((c) => c.name === "auditLogs.insertOne")!.args[0].data).toMatchObject({ reconnected: true, sameAccount: true });
  });

  it("another user has it active → InstagramAccountInUseError, nothing written", async () => {
    const fake = fakeDb({ "instagramConnections.findOne": (f: any) => (f.ownerId?.$ne ? { _id: new ObjectId() } : null) });
    await expect(saveInstagramConnection(fake.db, OWNER, toSave(), NOW)).rejects.toBeInstanceOf(InstagramAccountInUseError);
    expect(fake.names().filter((n) => !n.endsWith("findOne"))).toEqual([]);
  });

  it("two users finishing at once: the unique igUserId index (duplicate key) → InstagramAccountInUseError", async () => {
    const dup = Object.assign(new Error("E11000 duplicate key"), { code: 11000, keyPattern: { igUserId: 1 } });
    const fake = fakeDb({ "instagramConnections.findOne": () => null, "instagramConnections.insertOne": () => { throw dup; } });
    await expect(saveInstagramConnection(fake.db, OWNER, toSave(), NOW)).rejects.toBeInstanceOf(InstagramAccountInUseError);
  });

  it("the same user twice at once (duplicate ownerId) → tried once more, then replaces", async () => {
    const dup = Object.assign(new Error("E11000 duplicate key"), { code: 11000, keyPattern: { ownerId: 1 } });
    let inserted = false;
    const fake = fakeDb({
      "instagramConnections.findOne": (f: any) => (f.ownerId?.$ne ? null : inserted ? existingDoc() : null),
      "instagramConnections.insertOne": () => {
        inserted = true;
        throw dup;
      },
      "instagramConnections.replaceOne": () => ({}),
      "auditLogs.insertOne": () => ({}),
    });
    const doc = await saveInstagramConnection(fake.db, OWNER, toSave(), NOW);
    expect(doc.status).toBe("active");
    expect(fake.transactions()).toBe(2);
  });
});

describe("saveInstagramConnection: a second duplicate on ownerId", () => {
  it("is rethrown as it is (not 'already connected to another account')", async () => {
    const dup = Object.assign(new Error("E11000 duplicate key"), { code: 11000, keyPattern: { ownerId: 1 } });
    const fake = fakeDb({ "instagramConnections.findOne": () => null, "instagramConnections.insertOne": () => { throw dup; } });
    const error = await saveInstagramConnection(fake.db, OWNER, toSave(), NOW).catch((e: unknown) => e);
    expect(error).toBe(dup);
    expect(fake.transactions()).toBe(2);
  });
});

describe("disconnect (G4) and the resources", () => {
  it("active → token removed ($unset), status revoked, revokedAt, audit instagram.disconnected; owner in every filter", async () => {
    const doc = existingDoc();
    const fake = fakeDb({
      "instagramConnections.findOne": () => doc,
      "posts.findOne": () => null,
      "posts.find": () => ({ toArray: async () => [] }),
      "instagramConnections.findOneAndUpdate": () => ({ ...doc, accessToken: undefined, status: "revoked", revokedAt: NOW }),
      "auditLogs.insertOne": () => ({}),
    });
    const out = await disconnectInstagram(fake.db, OWNER.toHexString(), NOW);
    expect(out).toMatchObject({ status: "revoked", revokedAt: NOW });
    const update = fake.calls.find((c) => c.name === "instagramConnections.findOneAndUpdate")!.args;
    expect(update[0]).toEqual({ _id: doc._id, ownerId: OWNER });
    expect(update[1]).toEqual({ $set: { status: "revoked", revokedAt: NOW }, $unset: { accessToken: "" } });
    expect(fake.calls.find((c) => c.name === "auditLogs.insertOne")!.args[0]).toMatchObject({ action: "instagram.disconnected", actorId: OWNER });
    expect(fake.calls[0]!.args[0]).toEqual({ ownerId: OWNER });
  });

  it("F30: refused while a post is being published (nothing written); a failed post's approval is cancelled in the SAME transaction", async () => {
    const busy = fakeDb({ "instagramConnections.findOne": () => existingDoc(), "posts.findOne": () => ({ _id: new ObjectId() }) });
    await expect(disconnectInstagram(busy.db, OWNER, NOW)).rejects.toBeInstanceOf(InstagramBusyError);
    expect(busy.names()).toEqual(["instagramConnections.findOne", "posts.findOne"]);
    expect(busy.calls[1]!.args[0]).toEqual({ ownerId: OWNER, state: { $in: ["publishing", "outcome_unknown"] } });

    const doc = existingDoc();
    const failedPost = { _id: new ObjectId(), projectId: new ObjectId(), state: "publish_failed" };
    const fake = fakeDb({
      "instagramConnections.findOne": () => doc,
      "posts.findOne": () => null,
      "posts.find": () => ({ toArray: async () => [failedPost] }),
      "projects.find": () => ({ toArray: async () => [{ _id: failedPost.projectId, title: "The water cycle" }] }),
      "posts.updateOne": () => ({ modifiedCount: 1 }),
      "notifications.insertMany": () => ({}),
      "notifications.insertOne": () => ({}),
      "instagramConnections.findOneAndUpdate": () => ({ ...doc, accessToken: undefined, status: "revoked", revokedAt: NOW }),
      "auditLogs.insertOne": () => ({}),
    });
    await disconnectInstagram(fake.db, OWNER, NOW);
    expect(fake.transactions()).toBe(1);
    expect(fake.calls.find((c) => c.name === "posts.find")!.args[0]).toEqual({ ownerId: OWNER, state: { $in: ["scheduled", "publish_failed"] } });
    const moved = fake.calls.find((c) => c.name === "posts.updateOne")!.args;
    expect(moved[0]).toEqual({ _id: failedPost._id, ownerId: OWNER, state: "publish_failed" });
    expect(moved[1].$set).toMatchObject({ state: "approval_invalidated", invalidatedReason: "instagram_disconnected", invalidatedAt: NOW });
    const note = fake.calls.find((c) => c.name.startsWith("notifications.insert"))!.args[0];
    expect(JSON.stringify(note)).toContain("approval_invalidated");
    expect(JSON.stringify(note)).toContain("The water cycle");
    // Every write ran inside the one transaction (each got the session).
    for (const c of fake.calls.filter((c) => /update|insert|find/i.test(c.name))) expect(c.args.at(-1)).toHaveProperty("session");
  });

  it("nothing connected, or already disconnected → null (nothing written) → G4 404", async () => {
    for (const found of [null, existingDoc({ status: "revoked", accessToken: undefined })]) {
      const fake = fakeDb({ "instagramConnections.findOne": () => found });
      expect(await disconnectInstagram(fake.db, OWNER, NOW)).toBeNull();
      expect(fake.names()).toEqual(["instagramConnections.findOne"]);
    }
    const error = await disconnectConnection({ find: async () => null, disconnect: async () => null }, user.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiProblem);
    expect((error as ApiProblem).status).toBe(404);
    expect((error as ApiProblem).message).toBe("No Instagram account is connected.");
  });

  it("G1/G4 answers and B1 never carry the token; B1 shows active + username, not_connected after Disconnect", async () => {
    const doc = existingDoc({ profilePictureUrl: "https://scontent.cdninstagram.com/p.jpg" });
    const g1 = await connectionStatus({ find: async (id) => (id === user.id ? doc : null), disconnect: async () => null }, user.id);
    expect(g1.connection).toEqual({
      id: doc._id.toHexString(),
      igUserId: doc.igUserId,
      username: doc.username,
      accountType: "MEDIA_CREATOR",
      profilePictureUrl: "https://scontent.cdninstagram.com/p.jpg",
      status: "active",
      tokenExpiresAt: "2027-01-21T06:00:00.000Z",
      connectedAt: NOW.toISOString(),
      lastRefreshedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(g1)).not.toMatch(/accessToken|ciphertext/);
    expect(JSON.stringify(toInstagramConnectionResource(doc))).not.toContain(doc.accessToken!.ciphertext);
    expect(await connectionStatus({ find: async () => null, disconnect: async () => null }, OTHER.toHexString())).toEqual({ connection: null });
    expect(meInstagram(doc)).toEqual({ status: "active", username: "physics.with.ananya" });
    expect(meInstagram({ status: "revoked", username: "x" })).toEqual({ status: "not_connected", username: null });
    expect(meInstagram({ status: "expired", username: "x" })).toEqual({ status: "expired", username: "x" });
    expect(meInstagram(null)).toEqual({ status: "not_connected", username: null });
  });
});
