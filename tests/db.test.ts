import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHealthCheck,
  closeMongoClient,
  ensureIndexes,
  explainDbError,
  IndexConflictError,
  passwordsIn,
  ping,
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
    ["raw @ in password", { MONGODB_URI: "mongodb+srv://u:p@ss@x.mongodb.net/" }, "must be encoded"],
    ["raw / in password", { MONGODB_URI: "mongodb+srv://u:ab/cd@x.mongodb.net/" }, "must be encoded"],
    ["raw : in password", { MONGODB_URI: "mongodb+srv://u:a:b@x.mongodb.net/" }, "must be encoded"],
    ["srv with a port", { MONGODB_URI: "mongodb+srv://u:p@x.mongodb.net:27017/" }, "can't include a port"],
    ["no user and password", { MONGODB_URI: "mongodb+srv://x.mongodb.net/" }, "no user name and password"],
  ])("explains a problem: %s", (_label, env, expected) => {
    const r = readDbConfig(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).toContain(expected);
  });

  it("accepts an encoded password", () => {
    expect(readDbConfig({ MONGODB_URI: "mongodb+srv://u:p%40ss%2Fw@x.mongodb.net/?appName=a" }).ok).toBe(true);
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

  it.each([
    ["raw @ in password", "mongodb+srv://u:p@ss@h.net/", "ss@"],
    ["raw / in password", "mongodb+srv://u:ab/cd@h.net/", "ab/cd"],
    ["replica-set host list", "mongodb://u:pw12@h1:27017,h2:27017/?replicaSet=rs0", "pw12"],
  ])("leaves nothing of the password: %s", (_label, uri, secretPart) => {
    expect(redactConnectionString(`x ${uri} y`)).not.toContain(secretPart);
  });

  it("also masks the configured password anywhere in the text", () => {
    expect(redactConnectionString("driver said: wrong pass s3cret-Pass", passwordsIn(GOOD))).toBe("driver said: wrong pass ***");
  });

  it("finds the raw and decoded password", () => {
    expect(passwordsIn("mongodb+srv://u:p%40ss@h.net/")).toEqual(["p%40ss", "p@ss"]);
    expect(passwordsIn("mongodb+srv://h.net/")).toEqual([]);
  });
});

describe("explainDbError", () => {
  const err = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(Object.assign(new Error(message), { name }), extra);

  it.each([
    [err("MongoServerError", "bad auth : authentication failed", { code: 8000 }), "auth_failed"],
    [err("MongoServerError", "Authentication failed.", { code: 18 }), "auth_failed"],
    [err("Error", "querySrv ENOTFOUND _mongodb._tcp.nope.mongodb.net"), "dns_not_found"],
    [err("MongoServerSelectionError", "Server selection timed out after 10000 ms"), "unreachable"],
    [err("MongoServerSelectionError", "SSL routines:ssl3_read_bytes:tlsv1 alert internal error"), "unreachable"],
    [err("MongoNetworkError", "SSL routines:ssl3_read_bytes:tlsv1 alert internal error"), "tls_failed"],
    [err("Error", "querySrv ECONNREFUSED _mongodb._tcp.x.mongodb.net"), "dns_not_found"],
    [err("Error", "querySrv ETIMEOUT _mongodb._tcp.x.mongodb.net"), "dns_not_found"],
    [err("MongoParseError", "Invalid connection string"), "bad_uri"],
    [err("MongoParseError", 'tls/ssl must be either "true" or "false"'), "bad_uri"],
    [new IndexConflictError("The \"user\" collection already has an index that conflicts with \"email_unique\"."), "index_conflict"],
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

  it("creates a new client after closeMongoClient", async () => {
    const a = getMongoClient({ uri: "mongodb://localhost:27017", dbName: "t" });
    await closeMongoClient();
    const b = getMongoClient({ uri: "mongodb://localhost:27017", dbName: "t" });
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

  it("fails clearly if the record can't be read back", async () => {
    const { db } = fakeDb();
    const broken = { ...db, collection: () => ({ replaceOne: async () => undefined, findOne: async () => null }) } as unknown as Db;
    await expect(runHealthCheck(broken)).rejects.toThrow("could not be read back");
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

  it("rejects an unknown feature before connecting", async () => {
    const out: string[] = [];
    expect(await runDbCommand(["indexes", "--feature", "F99", "--apply"], (l) => out.push(...l), { MONGODB_URI: GOOD })).toBe(2);
    expect(out.join("\n")).toContain("Unknown feature F99");
  });

  it("rejects an unknown option with the usage text (no crash)", async () => {
    const out: string[] = [];
    expect(await runDbCommand(["indexes", "--features", "F08"], (l) => out.push(...l), {})).toBe(2);
    expect(out.join("\n")).toContain("npm run db -- indexes");
  });

  it("explains an invalid connection string instead of crashing", async () => {
    const out: string[] = [];
    const code = await runDbCommand(["ping"], (l) => out.push(...l), { MONGODB_URI: "mongodb+srv://u:pw1234@x.mongodb.net/?tls=maybe" });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("not a valid connection string");
    expect(out.join("\n")).not.toContain("pw1234");
  });

  it("refuses --apply without a feature", async () => {
    const out: string[] = [];
    expect(await runDbCommand(["indexes", "--apply"], (l) => out.push(...l), { MONGODB_URI: GOOD })).toBe(2);
    expect(out.join("\n")).toContain("--apply needs at least one --feature");
  });
});

describe("cleanup and ping", () => {
  function dbWith(existing: string[]) {
    const dropped: string[] = [];
    const db = {
      databaseName: "bytereel",
      listCollections: (filter: { name: string }) => ({ toArray: async () => existing.filter((n) => n === filter.name).map((name) => ({ name })) }),
      collection: (name: string) => ({ drop: async () => dropped.push(name) }),
      command: async () => ({ ok: 1 }),
    } as unknown as Db;
    return { db, dropped };
  }

  it("drops the healthchecks collection when it exists", async () => {
    const { db, dropped } = dbWith(["healthchecks"]);
    expect(await cleanupHealthCheck(db)).toEqual({ dropped: true });
    expect(dropped).toEqual(["healthchecks"]);
  });

  it("does nothing when it doesn't exist", async () => {
    const { db, dropped } = dbWith([]);
    expect(await cleanupHealthCheck(db)).toEqual({ dropped: false });
    expect(dropped).toEqual([]);
  });

  it("ping reports ok without writing", async () => {
    const { db } = dbWith([]);
    expect((await ping(db)).ok).toBe(true);
  });
});

describe("ensureIndexes", () => {
  it("passes the name and options to MongoDB", async () => {
    const calls: unknown[] = [];
    const db = { databaseName: "bytereel", collection: (c: string) => ({ createIndex: async (keys: unknown, options: unknown) => calls.push([c, keys, options]) }) } as unknown as Db;
    const created = await ensureIndexes(db, indexesForFeatures(["F07"]));
    expect(created).toEqual(["allowlist.email_unique"]);
    expect(calls).toEqual([["allowlist", { email: 1 }, { unique: true, name: "email_unique" }]]);
  });

  it("explains a conflicting index instead of a raw error", async () => {
    const db = {
      databaseName: "bytereel",
      collection: () => ({ createIndex: async () => Promise.reject(Object.assign(new Error("Index already exists with a different name: email_1"), { code: 85 })) }),
    } as unknown as Db;
    await expect(ensureIndexes(db, indexesForFeatures(["F07"]))).rejects.toThrow(/already has an index that conflicts/);
  });
});
