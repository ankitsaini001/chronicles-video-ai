import { describe, expect, it } from "vitest";
import { addInvite, InviteInputError, isInvited, listInvites, normalizeEmail, ping, removeInvite } from "@bytereel/db";
import { runDbCommand } from "../tools/cli/db";

// F07: the invite list. Uses a small in-memory stand-in for the database (no network).

type Db = Parameters<typeof ping>[0];
type Doc = Record<string, unknown> & { email: string };

function fakeDb() {
  const docs: Doc[] = [];
  const indexes: string[] = [];
  let nextId = 1;
  const allowlist = {
    createIndex: async (_keys: unknown, options: { name: string }) => indexes.push(options.name),
    updateOne: async (filter: { email: string }, update: { $setOnInsert: Doc }, options: { upsert: boolean }) => {
      expect(options.upsert).toBe(true);
      if (docs.some((d) => d.email === filter.email)) return { upsertedCount: 0 };
      docs.push({ _id: nextId++, ...update.$setOnInsert });
      return { upsertedCount: 1 };
    },
    findOne: async (filter: { email: string }) => docs.find((d) => d.email === filter.email) ?? null,
    find: () => ({ sort: () => ({ toArray: async () => [...docs] }) }),
    deleteOne: async (filter: { email: string }) => {
      const i = docs.findIndex((d) => d.email === filter.email);
      if (i === -1) return { deletedCount: 0 };
      docs.splice(i, 1);
      return { deletedCount: 1 };
    },
    countDocuments: async (filter: { email: string }) => docs.filter((d) => d.email === filter.email).length,
  };
  const db = {
    databaseName: "bytereel",
    collection: (name: string) => {
      expect(name).toBe("allowlist");
      return allowlist;
    },
  } as unknown as Db;
  return { db, docs, indexes };
}

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Priya.Sharma@Example.COM ")).toEqual({ ok: true, email: "priya.sharma@example.com" });
  });

  it.each(["", "   ", "priya", "priya@", "@example.com", "priya@example", "pri ya@example.com", "a@b@c.com"])("rejects %j", (input) => {
    expect(normalizeEmail(input).ok).toBe(false);
  });

  it("rejects emails longer than 254 characters", () => {
    expect(normalizeEmail(`${"a".repeat(250)}@example.com`).ok).toBe(false);
  });
});

describe("addInvite", () => {
  const now = new Date("2026-11-13T10:00:00.000Z");

  it("saves a lowercase entry with the fields from DATABASE.md §4.5 and makes sure the unique index exists", async () => {
    const { db, docs, indexes } = fakeDb();
    const r = await addInvite(db, " Priya@Example.com ", { note: " Physics teacher ", now });
    expect(r.status).toBe("added");
    expect(indexes).toEqual(["email_unique"]);
    expect(docs).toEqual([{ _id: 1, email: "priya@example.com", note: "Physics teacher", invitedBy: null, createdAt: now, signedUpUserId: null }]);
  });

  it("leaves out an empty note", async () => {
    const { db, docs } = fakeDb();
    await addInvite(db, "priya@example.com", { note: "   ", now });
    expect(docs[0]).not.toHaveProperty("note");
  });

  it("inviting the same email twice (any case) keeps one entry and reports it", async () => {
    const { db, docs } = fakeDb();
    await addInvite(db, "priya@example.com", { now });
    const again = await addInvite(db, "PRIYA@example.com", { note: "changed?", now: new Date("2026-11-14T00:00:00.000Z") });
    expect(again.status).toBe("already_invited");
    expect(docs).toHaveLength(1);
    expect(docs[0]?.createdAt).toEqual(now);
    expect(docs[0]).not.toHaveProperty("note");
  });

  it("refuses a bad email or a too-long note before touching the database", async () => {
    const { db, docs, indexes } = fakeDb();
    await expect(addInvite(db, "priya@")).rejects.toBeInstanceOf(InviteInputError);
    await expect(addInvite(db, "priya@example.com", { note: "x".repeat(201) })).rejects.toThrow("note is too long");
    expect(docs).toHaveLength(0);
    expect(indexes).toHaveLength(0);
  });
});

describe("removeInvite, listInvites, isInvited", () => {
  it("removes by email in any case and reports when nothing was there", async () => {
    const { db } = fakeDb();
    await addInvite(db, "priya@example.com");
    expect(await isInvited(db, "Priya@Example.com")).toBe(true);
    expect(await removeInvite(db, "PRIYA@example.com")).toEqual({ removed: true, email: "priya@example.com" });
    expect(await removeInvite(db, "priya@example.com")).toEqual({ removed: false, email: "priya@example.com" });
    expect(await isInvited(db, "priya@example.com")).toBe(false);
  });

  it("isInvited is false for a malformed email (sign-up will refuse it)", async () => {
    const { db } = fakeDb();
    expect(await isInvited(db, "not-an-email")).toBe(false);
  });

  it("lists every entry", async () => {
    const { db } = fakeDb();
    await addInvite(db, "a@example.com");
    await addInvite(db, "b@example.com");
    expect((await listInvites(db)).map((e) => e.email)).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("npm run db -- invite (input checks, no database)", () => {
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const code = await runDbCommand(argv, (l) => out.push(...l), {});
    return { code, text: out.join("\n") };
  };

  it.each([
    [["invite"], 'Use "invite add"'],
    [["invite", "add"], "needs exactly one email"],
    [["invite", "add", "a@example.com", "b@example.com"], "needs exactly one email"],
    [["invite", "add", "priya@"], "doesn't look like an email"],
    [["invite", "remove", "a@example.com", "--note", "x"], "takes no --note"],
    [["invite", "list", "extra"], "takes no options"],
    [["invite", "add", "a@example.com", "--nite", "x"], "Unknown option"],
  ])("explains bad input %j with the usage text", async (argv, expected) => {
    const r = await run(argv);
    expect(r.code).toBe(2);
    expect(r.text).toContain(expected);
    expect(r.text).toContain("npm run db -- invite add <email>");
  });

  it("needs the database settings for a valid command", async () => {
    const r = await run(["invite", "add", "a@example.com"]);
    expect(r.code).toBe(1);
    expect(r.text).toContain("MONGODB_URI is missing");
  });
});
