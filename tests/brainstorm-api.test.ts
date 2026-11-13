import {
  API_RATE_LIMITS,
  BRAINSTORM_SUBJECT_LIMITS,
  BrainstormBodySchema,
  indexesForFeatures,
  USAGE_LIMITS,
  usageCounterPeriod,
  type BrainstormCountResult,
  type RateLimitResult,
} from "@bytereel/db";
import type { PlannerProvider, PlannerRequest, PlannerResponse } from "@bytereel/pipeline/brainstorm";
import { describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiDeps } from "../apps/web/lib/api/v1";
import type { SessionUser } from "../apps/web/lib/auth/session";
import { runBrainstorm, type BrainstormDeps, type UsageFinish } from "../apps/web/lib/brainstorm/handler";
import { brainstormProviderFromEnv, FAKE_GEMINI_ENV, fakeGeminiProblem } from "../apps/web/lib/brainstorm/provider";
import { ProviderError } from "../packages/pipeline/src/providers";

// F14: C7 POST /api/v1/brainstorm through the real /api/v1 pipeline, with fakes for the session,
// the counters, the usage log and Gemini. Checks the body rules, the 10/hour and 30/day limits
// (a refused request never reaches Gemini), the error answers and the providerUsage logging.

const APP = "http://localhost:3000";
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
const allowed: RateLimitResult = { allowed: true, count: 1, limit: 10, resetsAt: new Date(), retryAfterSeconds: 3600 };

const IDEAS = Array.from({ length: 5 }, (_, i) => ({ title: `Monsoon idea ${i + 1}`, hook: `Did you know fact ${i + 1}?`, angle: `Everyday example ${i + 1}` }));
const GOOD = JSON.stringify({ suitable: true, ideas: IDEAS });

class FakeGemini implements PlannerProvider {
  readonly name = "gemini";
  readonly model = "gemini-3.6-flash";
  readonly generate = vi.fn(async (_request: PlannerRequest): Promise<PlannerResponse> => {
    const next = this.script.shift() ?? GOOD;
    if (next instanceof Error) throw next;
    return { text: next, model: "gemini-3.6-flash-001", finishReason: "STOP", usage: { promptTokens: 900, outputTokens: 300, thinkingTokens: 200, totalTokens: 1400 }, retries: 0, durationMs: 4 };
  });
  constructor(private readonly script: Array<string | Error> = []) {}
}

function setup(options: { script?: Array<string | Error>; daily?: BrainstormCountResult; hourlyAllowed?: boolean; providerOk?: boolean } = {}) {
  const gemini = new FakeGemini(options.script);
  const reserved: unknown[] = [];
  const finished: UsageFinish[] = [];
  const logs: string[] = [];
  const brainstormDeps: BrainstormDeps = {
    provider: vi.fn(() => (options.providerOk === false ? { ok: false as const, problem: "GEMINI_API_KEY is missing." } : { ok: true as const, provider: gemini, fake: false })),
    countToday: vi.fn(async () => options.daily ?? { ok: true as const, used: 1 }),
    reserveUsage: vi.fn(async (input) => {
      reserved.push(input);
      return `usage-${reserved.length}`;
    }),
    finishUsage: vi.fn(async (_handle, input) => void finished.push(input)),
    log: (level, message) => void logs.push(`${level}: ${message}`),
    run: { sleep: async () => undefined },
  };
  const apiDeps: ApiDeps = {
    appOrigins: [APP],
    getUser: async () => user,
    hitRateLimit: vi.fn(async () => (options.hourlyAllowed === false ? { ...allowed, allowed: false, count: 11, retryAfterSeconds: 1200 } : allowed)),
    logError: (message, error) => void logs.push(`error: ${message} ${error instanceof Error ? error.message : String(error)}`),
    newRequestId: () => "req_TEST0000000000",
  };
  const call = (body: unknown, headers: Record<string, string> = {}) =>
    handleApiRequest(
      new Request(`${APP}/api/v1/brainstorm`, { method: "POST", headers: { "content-type": "application/json", origin: APP, ...headers }, body: JSON.stringify(body) }),
      { rateLimit: API_RATE_LIMITS.brainstormPerUser, body: BrainstormBodySchema, handle: ({ user: u, body: b, requestId }) => runBrainstorm({ user: u, body: b, requestId }, brainstormDeps) },
      apiDeps,
    );
  return { gemini, brainstormDeps, apiDeps, reserved, finished, logs, call };
}

describe("C7 body (BrainstormBodySchema)", () => {
  const issues = (value: unknown) => {
    const r = BrainstormBodySchema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
  };

  it("subject 2–100 characters after the idea-text cleaning; language required", () => {
    expect(BRAINSTORM_SUBJECT_LIMITS).toEqual({ min: 2, max: 100 });
    expect(issues({ subject: "AI", language: "en" })).toEqual([]);
    expect(issues({ subject: "x".repeat(100), language: "hi" })).toEqual([]);
    expect(issues({ subject: "x".repeat(101), language: "en" })).toEqual(["subject: must be at most 100 characters"]);
    expect(issues({ subject: "  a \u0007 ", language: "en" })).toEqual(["subject: must be at least 2 characters"]);
    expect(issues({ subject: "Indian monsoon" })).toEqual(["language: must be one of en, hi, hinglish"]);
    expect(issues({ language: "en" })).toEqual(["subject: must be text"]);
  });

  it("cleans: control characters out, NFC, trimmed", () => {
    const r = BrainstormBodySchema.safeParse({ subject: "  Café\u0000 culture \n", language: "hinglish" });
    expect(r.success && r.data).toEqual({ subject: "Café culture", language: "hinglish" });
  });

  it("is strict: unknown fields refused", () => {
    expect(issues({ subject: "Indian monsoon", language: "en", count: 8 })).toEqual(["body: Unrecognized key: \"count\""]);
  });
});

describe("C7 limits and log setup", () => {
  it("10 per hour (rateLimits) and 30 per day (usageCounters `brainstorms`, user timezone)", () => {
    expect(API_RATE_LIMITS.brainstormPerUser).toEqual({ name: "brainstorm", limit: 10, windowSeconds: 3600 });
    expect(USAGE_LIMITS.brainstormsPerDay).toBe(30);
    const p = usageCounterPeriod("brainstorms", "Asia/Kolkata", new Date("2026-11-13T19:00:00Z"));
    expect(p.period).toBe("2026-11-14");
    expect(p.resetsAt.toISOString()).toBe("2026-11-14T18:30:00.000Z");
  });

  it("F14 creates the three providerUsage indexes (DATABASE.md §4.15)", () => {
    expect(indexesForFeatures(["F14"]).map((i) => [i.collection, i.name, i.keys])).toEqual([
      ["providerUsage", "at", { at: -1 }],
      ["providerUsage", "ownerId_at", { ownerId: 1, at: -1 }],
      ["providerUsage", "provider_at", { provider: 1, at: -1 }],
    ]);
  });
});

describe("C7 POST /api/v1/brainstorm", () => {
  it("200: exactly 5 ideas in the documented shape; cleaned subject echoed", async () => {
    const t = setup();
    const r = await t.call({ subject: "  Indian monsoon ", language: "en" });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json).toEqual({ subject: "Indian monsoon", language: "en", ideas: IDEAS.map((idea, i) => ({ id: `idea-${i + 1}`, ...idea })) });
    expect(t.gemini.generate).toHaveBeenCalledOnce();
    expect(t.brainstormDeps.countToday).toHaveBeenCalledWith(user);
  });

  it("logs every Gemini request in providerUsage: reserved before, finished after; never the subject", async () => {
    const t = setup({ script: [new ProviderError({ provider: "gemini", kind: "transient", status: 503, message: "busy" }), GOOD] });
    const r = await t.call({ subject: "Indian monsoon", language: "en" });
    expect(r.status).toBe(200);
    expect(t.reserved).toEqual([
      { ownerId: user.id, model: "gemini-3.6-flash", estCostInr: 0 },
      { ownerId: user.id, model: "gemini-3.6-flash", estCostInr: 0 },
    ]);
    expect(t.finished).toEqual([
      { status: "failed", outcome: "busy", model: "gemini-3.6-flash", units: { promptTokens: 0, outputTokens: 0 }, estCostInr: 0, latencyMs: expect.any(Number) },
      { status: "final", outcome: "ok", model: "gemini-3.6-flash-001", units: { promptTokens: 900, outputTokens: 500 }, estCostInr: 0, latencyMs: expect.any(Number) },
    ]);
    expect(JSON.stringify([t.reserved, t.finished])).not.toContain("monsoon");
  });

  it("hourly limit (11th in the hour): 429 RATE_LIMITED, Gemini never called, nothing counted or logged", async () => {
    const t = setup({ hourlyAllowed: false });
    const r = await t.call({ subject: "Indian monsoon", language: "en" });
    expect(r.status).toBe(429);
    expect((await r.json()).error.code).toBe("RATE_LIMITED");
    expect(r.headers.get("retry-after")).toBe("1200");
    expect(t.brainstormDeps.countToday).not.toHaveBeenCalled();
    expect(t.gemini.generate).not.toHaveBeenCalled();
    expect(t.reserved).toEqual([]);
  });

  it("daily limit (31st today): 429 QUOTA_EXCEEDED brainstorms_per_day with resetsAt, Gemini never called", async () => {
    const resetsAt = new Date("2026-11-13T18:30:00.000Z");
    const t = setup({ daily: { ok: false, used: 30, limit: 30, resetsAt } });
    const r = await t.call({ subject: "Indian monsoon", language: "en" });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({
      error: {
        code: "QUOTA_EXCEEDED",
        message: "You've used today's 30 brainstorms. Try again tomorrow.",
        details: { quota: "brainstorms_per_day", limit: 30, used: 30, resetsAt: resetsAt.toISOString() },
        requestId: "req_TEST0000000000",
      },
    });
    expect(t.gemini.generate).not.toHaveBeenCalled();
    expect(t.reserved).toEqual([]);
  });

  it("invalid body: 400 INVALID_INPUT, not counted for the day, Gemini never called", async () => {
    const t = setup();
    const r = await t.call({ subject: "x", language: "fr" });
    expect(r.status).toBe(400);
    expect((await r.json()).error.details.issues).toEqual([
      { path: "subject", message: "must be at least 2 characters" },
      { path: "language", message: "must be one of en, hi, hinglish" },
    ]);
    expect(t.brainstormDeps.countToday).not.toHaveBeenCalled();
    expect(t.gemini.generate).not.toHaveBeenCalled();
  });

  it("safety block: 422 PROVIDER_REJECTED with a plain message", async () => {
    const t = setup({ script: [new ProviderError({ provider: "gemini", kind: "safety", message: "blocked" })] });
    const r = await t.call({ subject: "something unsafe", language: "en" });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatchObject({ code: "PROVIDER_REJECTED", message: "We can't suggest ideas for this subject. Please try a different one." });
  });

  it("busy after the retries: 503 PROVIDER_BUSY, brainstorm wording (no 'Your idea is saved'), Retry-After", async () => {
    const t = setup({ script: [0, 1, 2].map(() => new ProviderError({ provider: "gemini", kind: "transient", status: 503, message: "busy" })) });
    const r = await t.call({ subject: "Indian monsoon", language: "en" });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatchObject({ code: "PROVIDER_BUSY", message: "Our AI is very busy right now. Please try again in a few minutes." });
    expect(r.headers.get("retry-after")).toBe("60");
    expect(t.gemini.generate).toHaveBeenCalledTimes(3);
    expect(t.finished.map((f) => f.outcome)).toEqual(["busy", "busy", "busy"]);
  });

  it("invalid answer twice: 503 PROVIDER_BUSY after one repair", async () => {
    const four = JSON.stringify({ suitable: true, ideas: IDEAS.slice(0, 4) });
    const t = setup({ script: [four, four] });
    const r = await t.call({ subject: "Indian monsoon", language: "en" });
    expect(r.status).toBe(503);
    expect(t.gemini.generate).toHaveBeenCalledTimes(2);
    expect(t.finished.map((f) => f.outcome)).toEqual(["invalid_output", "invalid_output"]);
  });

  it("Gemini not set up (no key): 500 INTERNAL, reason only in the server log, nothing counted", async () => {
    const t = setup({ providerOk: false });
    const r = await t.call({ subject: "Indian monsoon", language: "en" });
    expect(r.status).toBe(500);
    expect((await r.json()).error.message).toBe("Something went wrong on our side. Please try again.");
    expect(t.logs.join("\n")).toContain("GEMINI_API_KEY is missing.");
    expect(t.brainstormDeps.countToday).not.toHaveBeenCalled();
  });

  it("no Idempotency-Key needed; one sent is ignored (C7 saves nothing)", async () => {
    const t = setup();
    expect((await t.call({ subject: "Indian monsoon", language: "en" }, { "idempotency-key": "bad key!" })).status).toBe(200);
  });
});

describe("Gemini setup and the test-only fake switch", () => {
  const localTest = { MONGODB_DB: "bytereel_test", BETTER_AUTH_URL: "http://localhost:3235", [FAKE_GEMINI_ENV]: "1" };

  it("allowed only on a local test server (test database, port 3230–3239, not on Vercel)", () => {
    expect(fakeGeminiProblem({})).toBeNull();
    expect(fakeGeminiProblem(localTest)).toBeNull();
    expect(fakeGeminiProblem({ ...localTest, VERCEL: "1" })).toMatch(/Vercel/);
    expect(fakeGeminiProblem({ ...localTest, VERCEL_ENV: "production" })).toMatch(/Vercel/);
    expect(fakeGeminiProblem({ ...localTest, MONGODB_DB: "bytereel" })).toMatch(/bytereel_test/);
    expect(fakeGeminiProblem({ ...localTest, BETTER_AUTH_URL: "http://localhost:3000" })).toMatch(/local test server/);
    expect(fakeGeminiProblem({ ...localTest, BETTER_AUTH_URL: "https://bytereel.app" })).toMatch(/local test server/);
    expect(fakeGeminiProblem({ ...localTest, [FAKE_GEMINI_ENV]: "true" })).toMatch(/must be "1"/);
  });

  it("set where not allowed: brainstorm refuses to run (never quietly real or fake)", () => {
    const r = brainstormProviderFromEnv({ ...localTest, VERCEL: "1", GEMINI_API_KEY: "k", GEMINI_MODEL: "m" });
    expect(r.ok).toBe(false);
  });

  it("real Gemini needs GEMINI_API_KEY; brainstorm has its own model (default gemini-3.1-flash-lite), not GEMINI_MODEL", () => {
    expect(brainstormProviderFromEnv({ GEMINI_BRAINSTORM_MODEL: "m1" })).toEqual({ ok: false, problem: expect.stringContaining("GEMINI_API_KEY is missing") });
    const d = brainstormProviderFromEnv({ GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-3.6-flash" });
    expect(d.ok && d.fake === false && d.provider.model).toBe("gemini-3.1-flash-lite");
    const e = brainstormProviderFromEnv({ GEMINI_API_KEY: "k", GEMINI_BRAINSTORM_MODEL: "  " });
    expect(e.ok && e.provider.model).toBe("gemini-3.1-flash-lite");
    const r = brainstormProviderFromEnv({ GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-3.6-flash", GEMINI_BRAINSTORM_MODEL: "gemini-3.6-flash" });
    expect(r.ok && r.fake === false && r.provider.model).toBe("gemini-3.6-flash");
    expect(brainstormProviderFromEnv({ GEMINI_API_KEY: "k", GEMINI_BRAINSTORM_MODEL: "gemini flash" })).toEqual({ ok: false, problem: expect.stringContaining("GEMINI_BRAINSTORM_MODEL") });
    const f = brainstormProviderFromEnv(localTest);
    expect(f.ok && f.fake && f.provider.model).toBe("fake-gemini-e2e");
  });
});
