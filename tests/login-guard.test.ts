import { describe, expect, it } from "vitest";
import { AUTH_RATE_LIMITS, getLoginLock, LOGIN_LOCKOUT, ping, recordFailedLogin, recordSuccessfulLogin, USER_COLLECTION } from "@bytereel/db";

// F09: sign-in limits and the account lockout (API.md §3.7). A stand-in records what is sent to
// the `user` collection (no network). The real update pipeline runs against MongoDB in
// tools/e2e/f09-login.ts (including 12 wrong passwords at the same moment).

type Db = Parameters<typeof ping>[0];

function fakeDb(answers: { findOne?: unknown; findOneAndUpdate?: unknown } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const collection = {
    findOne: async (...args: unknown[]) => {
      calls.push({ op: "findOne", args });
      return answers.findOne ?? null;
    },
    findOneAndUpdate: async (...args: unknown[]) => {
      calls.push({ op: "findOneAndUpdate", args });
      return answers.findOneAndUpdate ?? null;
    },
    updateOne: async (...args: unknown[]) => {
      calls.push({ op: "updateOne", args });
      return { matchedCount: 1 };
    },
  };
  const db = {
    collection: (name: string) => {
      expect(name).toBe(USER_COLLECTION);
      return collection;
    },
  } as unknown as Db;
  return { db, calls };
}

const now = new Date("2026-11-13T10:00:00.000Z");

describe("sign-in rules (API.md §3.7)", () => {
  it("5 per 15 minutes per IP and per email; get-session 120 per minute per IP", () => {
    expect(AUTH_RATE_LIMITS.signInPerIp).toEqual({ name: "signin-ip", limit: 5, windowSeconds: 900 });
    expect(AUTH_RATE_LIMITS.signInPerEmail).toEqual({ name: "signin-email", limit: 5, windowSeconds: 900 });
    expect(AUTH_RATE_LIMITS.getSessionPerIp).toEqual({ name: "session-ip", limit: 120, windowSeconds: 60 });
  });

  it("every rule has its own counter name", () => {
    const names = Object.values(AUTH_RATE_LIMITS).map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("lockout: 10 wrong passwords in a row → 15 minutes", () => {
    expect(LOGIN_LOCKOUT).toEqual({ maxFailures: 10, lockSeconds: 900 });
  });
});

describe("getLoginLock", () => {
  it("looks up only a lock that is still running, by the email", async () => {
    const { db, calls } = fakeDb();
    expect(await getLoginLock(db, "priya@example.com", now)).toEqual({ locked: false });
    expect(calls[0]?.args[0]).toEqual({ email: "priya@example.com", lockedUntil: { $gt: now } });
  });

  it("reports the time left as Retry-After seconds", async () => {
    const until = new Date(now.getTime() + 600_500);
    const { db } = fakeDb({ findOne: { lockedUntil: until } });
    expect(await getLoginLock(db, "priya@example.com", now)).toEqual({ locked: true, until, retryAfterSeconds: 601 });
  });
});

describe("recordFailedLogin", () => {
  it("is one atomic pipeline update on the email (add 1; every 10th sets lockedUntil = now + 15 min)", async () => {
    const { db, calls } = fakeDb({ findOneAndUpdate: { failedLoginCount: 3, lockedUntil: null } });
    expect(await recordFailedLogin(db, "priya@example.com", now)).toEqual({ failedLoginCount: 3, locked: false });
    const [filter, pipeline, options] = calls[0]?.args ?? [];
    expect(calls).toHaveLength(1);
    expect(filter).toEqual({ email: "priya@example.com" });
    expect(Array.isArray(pipeline)).toBe(true);
    expect(JSON.stringify(pipeline)).toContain(new Date(now.getTime() + 900_000).toISOString());
    expect(JSON.stringify(pipeline)).toContain('"$mod":["$failedLoginCount",10]');
    expect(options).toMatchObject({ returnDocument: "after" });
  });

  it("says locked when the update set a future lockedUntil", async () => {
    const { db } = fakeDb({ findOneAndUpdate: { failedLoginCount: 10, lockedUntil: new Date(now.getTime() + 900_000) } });
    expect(await recordFailedLogin(db, "priya@example.com", now)).toEqual({ failedLoginCount: 10, locked: true });
  });

  it("returns null for an email without an account (nothing stored)", async () => {
    const { db } = fakeDb();
    expect(await recordFailedLogin(db, "nobody@example.com", now)).toBeNull();
  });
});

describe("recordSuccessfulLogin", () => {
  it("resets the count, clears the lock and sets lastLoginAt", async () => {
    const { db, calls } = fakeDb();
    await recordSuccessfulLogin(db, "priya@example.com", now);
    expect(calls[0]).toEqual({ op: "updateOne", args: [{ email: "priya@example.com" }, { $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } }] });
  });
});
