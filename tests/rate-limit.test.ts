import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTH_RATE_LIMITS, hashRateLimitSubject, hitRateLimit, INDEXES, ping, RATE_LIMITS_COLLECTION, rateLimitId, rateLimitWindow, type RateLimitRule } from "@bytereel/db";

// F08: the "too many attempts" counters (DATABASE.md §4.6). Uses a small in-memory stand-in for
// the rateLimits collection (no network).

type Db = Parameters<typeof ping>[0];
type Doc = { _id: string; count: number; expiresAt: Date };

function fakeDb(options: { duplicateOnFirstInsert?: boolean } = {}) {
  const docs = new Map<string, Doc>();
  let failNext = options.duplicateOnFirstInsert ?? false;
  const calls: { filter: unknown; update: unknown; options: unknown }[] = [];
  const collection = {
    findOneAndUpdate: async (filter: { _id: string }, update: { $inc: { count: number }; $setOnInsert: { expiresAt: Date } }, opts: unknown) => {
      calls.push({ filter, update, options: opts });
      if (failNext) {
        // Simulate another request creating the counter at the same moment.
        failNext = false;
        docs.set(filter._id, { _id: filter._id, count: 1, ...update.$setOnInsert });
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      }
      const existing = docs.get(filter._id);
      const doc = existing ? { ...existing, count: existing.count + update.$inc.count } : { _id: filter._id, count: update.$inc.count, ...update.$setOnInsert };
      docs.set(filter._id, doc);
      return doc;
    },
  };
  const db = {
    collection: (name: string) => {
      expect(name).toBe(RATE_LIMITS_COLLECTION);
      return collection;
    },
  } as unknown as Db;
  return { db, docs, calls };
}

const rule: RateLimitRule = { name: "test-rule", limit: 3, windowSeconds: 60 };

describe("rate limiter", () => {
  it("sign-up rule matches API.md §3.7 (5 per 15 minutes per IP)", () => {
    expect(AUTH_RATE_LIMITS.signUpPerIp).toEqual({ name: "signup-ip", limit: 5, windowSeconds: 900 });
  });

  it("uses fixed windows aligned to the window length", () => {
    const w = rateLimitWindow(AUTH_RATE_LIMITS.signUpPerIp, new Date("2026-11-13T04:37:12.345Z"));
    expect(w.start.toISOString()).toBe("2026-11-13T04:30:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-13T04:45:00.000Z");
  });

  it("stores only a SHA-256 hash of the subject, never the raw IP or email", async () => {
    const { db, docs } = fakeDb();
    await hitRateLimit(db, rule, "203.0.113.24", new Date("2026-11-13T04:30:10Z"));
    const [id] = [...docs.keys()];
    const hash = createHash("sha256").update("203.0.113.24").digest("hex");
    expect(hashRateLimitSubject("203.0.113.24")).toBe(hash);
    expect(id).toBe(`test-rule:sha256:${hash}:2026-11-13T04:30:00.000Z`);
    expect(id).not.toContain("203.0.113.24");
    expect(JSON.stringify([...docs.values()])).not.toContain("203.0.113.24");
  });

  it("sets the TTL field expiresAt to the end of the window, only when the counter is created", async () => {
    const { db, docs, calls } = fakeDb();
    await hitRateLimit(db, rule, "x", new Date("2026-11-13T04:30:10Z"));
    expect([...docs.values()][0]?.expiresAt.toISOString()).toBe("2026-11-13T04:31:00.000Z");
    expect(calls[0]?.update).toEqual({ $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date("2026-11-13T04:31:00.000Z") } });
    expect(calls[0]?.options).toMatchObject({ upsert: true, returnDocument: "after" });
    // The TTL index exists in the index list (created by `npm run db -- indexes --feature F08 --apply`).
    expect(INDEXES.find((i) => i.collection === RATE_LIMITS_COLLECTION)).toMatchObject({ keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 }, feature: "F08" });
  });

  it("allows up to the limit, then refuses, with Retry-After until the window ends", async () => {
    const { db } = fakeDb();
    const now = new Date("2026-11-13T04:30:15Z");
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hitRateLimit(db, rule, "1.2.3.4", now));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
    expect(results[3]).toMatchObject({ limit: 3, retryAfterSeconds: 45, resetsAt: new Date("2026-11-13T04:31:00.000Z") });
  });

  it("starts again in the next window and keeps subjects and rules apart", async () => {
    const { db } = fakeDb();
    const t1 = new Date("2026-11-13T04:30:59Z");
    for (let i = 0; i < 3; i++) await hitRateLimit(db, rule, "a", t1);
    expect((await hitRateLimit(db, rule, "a", t1)).allowed).toBe(false);
    expect((await hitRateLimit(db, rule, "b", t1)).allowed).toBe(true);
    expect((await hitRateLimit(db, { ...rule, name: "other" }, "a", t1)).allowed).toBe(true);
    expect((await hitRateLimit(db, rule, "a", new Date("2026-11-13T04:31:00Z"))).count).toBe(1);
  });

  it("retries once when two first attempts create the counter at the same moment", async () => {
    const { db } = fakeDb({ duplicateOnFirstInsert: true });
    const r = await hitRateLimit(db, rule, "a", new Date("2026-11-13T04:30:00Z"));
    expect(r.count).toBe(2);
  });

  it("Retry-After is at least 1 second", async () => {
    const { db } = fakeDb();
    const r = await hitRateLimit(db, rule, "a", new Date("2026-11-13T04:30:59.999Z"));
    expect(r.retryAfterSeconds).toBe(1);
  });

  it("ids differ per window", () => {
    expect(rateLimitId(rule, "a", new Date("2026-11-13T04:30:00Z"))).not.toBe(rateLimitId(rule, "a", new Date("2026-11-13T04:31:00Z")));
  });
});
