import { afterEach, describe, expect, it } from "vitest";
import {
  closeMongoClient,
  explainDbError,
  getMongoClient,
  HEALTHCHECK_COLLECTION,
  HEALTHCHECK_ID,
  INDEXES,
  indexesForFeatures,
  readDbConfig,
  redactConnectionString,
  runHealthCheck,
  type HealthRecord,
} from "@bytereel/db";
import { runDbCommand } from "../tools/cli/db";

// F06: database settings, shared client, plain errors, health check and the db command.
// None of these tests talks to a real database.

type Db = Parameters<typeof runHealthCheck>[0];

const GOOD = "mongodb+srv://app_user:s3cret-Pass@bytereel-dev.abcde.mongodb.net/?retryWrites=true&w=majority";

describe("readDbConfig", () => {
  it("accepts an Atlas connection string and defaults the database name", () => {
    const r = readDbConfig({ MONGODB_URI: GOOD });
    expect(r).toEqual({ ok: true, config: { uri: GOOD, dbName: "bytereel" } });
  });

  it("uses MONGODB_DB when set", () => {
    const r = readDbConfig({ MONGODB_URI: GOOD, MONGODB_DB: "bytereel_test" });
    expect(r.ok && r.config.dbName).toBe("bytereel_test");
  });

  it.each([
    ["missing", {}, "MONGODB_URI is missing"],
    ["empty", { MONGODB_URI: "  " }, "MONGODB_URI is missing"],
    ["wrong scheme", { MONGODB_URI: "https://example.com" }, 'must start with "mongodb+srv://"'],
    ["placeholder", { MONGODB_URI: "mongodb+srv://u:<db_password>@x.mongodb.net/" }, "placeholder"],
    ["space inside", { MONGODB_URI: "mongodb+srv://u:p@x.mongodb.net/ ?a=b" }, "space"],
    ["bad db name", { MONGODB_URI: GOOD, MONGODB_DB: "byte reel!" }, "MONGODB_DB must be a simple name"],
  ])("explains a problem: %s", (_label, env, expected) => {
    const r = readDbConfig(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).toContain(expected);
  });

  it("never puts the connection string in a problem message", () => {
    const r = readDbConfig({ MONGODB_URI: "mongodb+srv://u:top-secret@x.mongodb.net/ oops" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).not.toContain("top-secret");
  });
});

describe("redactConnectionString", () => {
  it("hides the user and password", () => {
    expect(redactConnectionString(`failed for ${GOOD}`)).toBe(
      "failed for mongodb+srv://***@bytereel-dev.abcde.mongodb.net/?retryWrites=true&w=majority",
    );
  });
});

describe("explainDbError", () => {
  const err = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(Object.assign(new Error(message), { name }), extra);

  it.each([
    [err("MongoServerError", "bad auth : authentication failed", { code: 8000 }), "auth_failed"],
    [err("MongoServerError", "Authentication failed.", { code: 18 }), "auth_failed"],
    [err("Error", "querySrv ENOTFOUND _mongodb._tcp.nope.mongodb.net"), "dns_not_found"],
    [err("MongoServerSelectionError", "Server selection timed out after 10000 ms"), "unreachable"],
    [err("MongoNetworkError", "SSL routines:ssl3_read_bytes:tlsv1 alert internal error"), "tls_failed"],
    [err("Error", "something else"), "unknown"],
  ])("maps %s to a plain message", (error, code) => {
    const r = explainDbError(error);
    expect(r.code).toBe(code);
    expect(r.message.length).toBeGreaterThan(20);
  });

  it("hides a connection string inside the driver's message", () => {
    const r = explainDbError(new Error(`could not connect to ${GOOD}`));
    expect(r.detail).not.toContain("s3cret-Pass");
    expect(r.detail).toContain("mongodb+srv://***@");
  });
});

describe("getMongoClient", () => {
  afterEach(async () => {
    await closeMongoClient();
  });

  it("reuses one client for the same settings (no new connections on every start)", () => {
    const a = getMongoClient({ uri: "mongodb://localhost:27017", dbName: "t" });
    const b = getMongoClient({ uri: "mongodb://localhost:27017", dbName: "t" });
    expect(a).toBe(b);
  });

  it("replaces the client when the connection string changes", () => {
    const a = getMongoClient({ uri: "mongodb://localhost:27017", dbName: "t" });
    const b = getMongoClient({ uri: "mongodb://localhost:27018", dbName: "t" });
    expect(a).not.toBe(b);
  });
});

describe("runHealthCheck", () => {
  function fakeDb() {
    const store = new Map<string, HealthRecord>();
    const calls: string[] = [];
    const db = {
      databaseName: "bytereel",
      command: async () => ({ ok: 1 }),
      collection: (name: string) => {
        calls.push(name);
        return {
          replaceOne: async (filter: { _id: string }, doc: HealthRecord, options: { upsert: boolean }) => {
            expect(options.upsert).toBe(true);
            store.set(filter._id, doc);
          },
          findOne: async (filter: { _id: string }) => store.get(filter._id) ?? null,
        };
      },
    } as unknown as Db;
    return { db, store, calls };
  }

  it("writes one fixed record and reads it back", async () => {
    const { db, store, calls } = fakeDb();
    const now = new Date("2026-11-13T10:00:00.000Z");
    const r = await runHealthCheck(db, now);
    expect(calls).toEqual([HEALTHCHECK_COLLECTION]);
    expect(store.size).toBe(1);
    expect(r.record._id).toBe(HEALTHCHECK_ID);
    expect(r.record.writtenAt).toEqual(now);
    expect(r).toMatchObject({ database: "bytereel", collection: "healthchecks" });
  });

  it("running it twice keeps a single record", async () => {
    const { db, store } = fakeDb();
    await runHealthCheck(db, new Date("2026-11-13T10:00:00.000Z"));
    await runHealthCheck(db, new Date("2026-11-13T10:05:00.000Z"));
    expect(store.size).toBe(1);
  });
});

describe("index list", () => {
  it("has the indexes phase A2 needs (DATABASE.md §8)", () => {
    const names = INDEXES.map((i) => `${i.collection}.${i.name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "allowlist.email_unique",
        "user.email_unique",
        "session.token_unique",
        "session.userId",
        "session.expiresAt_ttl",
        "account.userId_providerId",
        "verification.identifier",
        "verification.expiresAt_ttl",
        "rateLimits.expiresAt_ttl",
      ]),
    );
  });

  it("marks one-account-per-email and session tokens unique, and expiry indexes as TTL", () => {
    const find = (c: string, n: string) => INDEXES.find((i) => i.collection === c && i.name === n);
    expect(find("user", "email_unique")?.options.unique).toBe(true);
    expect(find("session", "token_unique")?.options.unique).toBe(true);
    for (const i of INDEXES.filter((x) => x.name.endsWith("_ttl"))) expect(i.options.expireAfterSeconds).toBe(0);
  });

  it("has unique names per collection and filters by feature", () => {
    const keys = INDEXES.map((i) => `${i.collection}.${i.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(indexesForFeatures(["F07"]).map((i) => i.collection)).toEqual(["allowlist"]);
    expect(indexesForFeatures(["F06"])).toEqual([]);
  });
});

describe("npm run db (command)", () => {
  it("prints usage for an unknown command", async () => {
    const out: string[] = [];
    expect(await runDbCommand(["nope"], (l) => out.push(...l), {})).toBe(2);
    expect(out.join("\n")).toContain("npm run db -- check");
  });

  it("explains a missing MONGODB_URI without contacting MongoDB", async () => {
    const out: string[] = [];
    expect(await runDbCommand(["check"], (l) => out.push(...l), {})).toBe(1);
    expect(out.join("\n")).toContain("nothing was sent to MongoDB");
    expect(out.join("\n")).toContain("MONGODB_URI is missing");
  });

  it("lists indexes without applying them", async () => {
    const out: string[] = [];
    expect(await runDbCommand(["indexes", "--feature", "F08"], (l) => out.push(...l), {})).toBe(0);
    expect(out.join("\n")).toContain("Nothing was changed");
    expect(out.join("\n")).toContain("user.email_unique");
  });

  it("refuses --apply without a feature", async () => {
    const out: string[] = [];
    expect(await runDbCommand(["indexes", "--apply"], (l) => out.push(...l), { MONGODB_URI: GOOD })).toBe(2);
    expect(out.join("\n")).toContain("--apply needs at least one --feature");
  });
});
