import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  beginIdempotency,
  finishIdempotency,
  finishIdempotencyInTransaction,
  IDEMPOTENCY_LOCK_MS,
  IdempotencyLockLostError,
  releaseIdempotency,
  type IdempotencyLock,
} from "@bytereel/db";

// F12 review: Idempotency-Key records (DATABASE.md §4.13). Each check-in gets its own lockId, so a
// very slow first request can't save its answer or delete the record after a repeat took it over.
// Uses a small in-memory stand-in for the idempotencyKeys collection (no network).

type Doc = Record<string, unknown> & { _id: ObjectId };
type Db = Parameters<typeof beginIdempotency>[0];

function same(a: unknown, b: unknown): boolean {
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function fakeDb() {
  const docs: Doc[] = [];
  const matches = (doc: Doc, filter: Record<string, unknown>) => Object.entries(filter).every(([k, v]) => same(doc[k] ?? null, v));
  const collection = {
    insertOne: async (doc: Doc) => {
      if (docs.some((d) => same(d.ownerId, doc.ownerId) && d.key === doc.key)) throw Object.assign(new Error("E11000"), { code: 11000 });
      docs.push({ ...doc });
    },
    findOne: async (filter: Record<string, unknown>) => docs.find((d) => matches(d, filter)) ?? null,
    findOneAndUpdate: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      const doc = docs.find((d) => matches(d, filter));
      if (!doc) return null;
      Object.assign(doc, update.$set);
      return doc;
    },
    updateOne: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      const doc = docs.find((d) => matches(d, filter));
      if (doc) Object.assign(doc, update.$set);
      return { matchedCount: doc ? 1 : 0 };
    },
    deleteOne: async (filter: Record<string, unknown>) => {
      const i = docs.findIndex((d) => matches(d, filter));
      if (i >= 0) docs.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
  };
  return { docs, db: { collection: () => collection } as unknown as Db };
}

const OWNER = "67330c1a9f1e4b2a7c0d1e01";
const KEY = "9b2f4c1e-7d3a-4e8b-a1c5-2f6d8e0b4a71";
const FP = "sha256:aaaa";
const t0 = new Date("2026-11-13T10:00:00.000Z");
const later = new Date(t0.getTime() + IDEMPOTENCY_LOCK_MS + 1000);

async function newLock(db: Db, at = t0): Promise<IdempotencyLock> {
  const r = await beginIdempotency(db, OWNER, KEY, FP, at);
  if (r.kind !== "new") throw new Error(`expected new, got ${r.kind}`);
  return { recordId: r.recordId, lockId: r.lockId };
}

describe("beginIdempotency", () => {
  it("first check-in: a new record with its own random lockId", async () => {
    const { db, docs } = fakeDb();
    const lock = await newLock(db);
    expect(lock.lockId).toMatch(/^[0-9a-f]{32}$/);
    expect(docs[0]).toMatchObject({ key: KEY, status: "in_progress", lockId: lock.lockId });
  });

  it("a repeat before the lock expires → in_progress; a different request → reused", async () => {
    const { db } = fakeDb();
    await newLock(db);
    expect((await beginIdempotency(db, OWNER, KEY, FP, t0)).kind).toBe("in_progress");
    expect((await beginIdempotency(db, OWNER, KEY, "sha256:other", t0)).kind).toBe("reused");
  });

  it("after finishing → replay with the saved answer", async () => {
    const { db } = fakeDb();
    const lock = await newLock(db);
    expect(await finishIdempotency(db, lock, 201, { project: { id: "p1" }, job: null })).toBe(true);
    expect(await beginIdempotency(db, OWNER, KEY, FP, later)).toEqual({ kind: "replay", status: 201, body: { project: { id: "p1" }, job: null } });
  });
});

describe("slow request A, takeover by B (F12 review)", () => {
  it("B takes over an abandoned marker with a NEW lockId", async () => {
    const { db } = fakeDb();
    const a = await newLock(db);
    const b = await newLock(db, later);
    expect(b.recordId).toBe(a.recordId);
    expect(b.lockId).not.toBe(a.lockId);
  });

  it("A can no longer save its answer; B can, and B's answer is what repeats get", async () => {
    const { db, docs } = fakeDb();
    const a = await newLock(db);
    const b = await newLock(db, later);
    expect(await finishIdempotency(db, a, 201, { from: "A" })).toBe(false);
    expect(docs[0]!.status).toBe("in_progress");
    expect(await finishIdempotency(db, b, 201, { from: "B" })).toBe(true);
    expect(await finishIdempotency(db, a, 201, { from: "A" })).toBe(false);
    expect(docs[0]).toMatchObject({ status: "done", responseBody: { from: "B" }, lockId: null });
  });

  it("inside a transaction, A's lost lock throws IdempotencyLockLostError (so the transaction rolls back)", async () => {
    const { db } = fakeDb();
    const a = await newLock(db);
    await newLock(db, later);
    await expect(finishIdempotencyInTransaction(db, a, 201, {}, {} as never)).rejects.toBeInstanceOf(IdempotencyLockLostError);
  });

  it("A's release (after its 5xx) does not delete B's record", async () => {
    const { db, docs } = fakeDb();
    const a = await newLock(db);
    const b = await newLock(db, later);
    await releaseIdempotency(db, a);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.lockId).toBe(b.lockId);
    await releaseIdempotency(db, b);
    expect(docs).toHaveLength(0);
  });

  it("two takeovers at the same moment: only one wins", async () => {
    const { db } = fakeDb();
    await newLock(db);
    const [x, y] = await Promise.all([beginIdempotency(db, OWNER, KEY, FP, later), beginIdempotency(db, OWNER, KEY, FP, later)]);
    expect([x.kind, y.kind].sort()).toEqual(["in_progress", "new"]);
  });
});
