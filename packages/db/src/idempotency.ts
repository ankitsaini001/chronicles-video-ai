import { type ClientSession, type Db, ObjectId } from "mongodb";

// "Did we already handle this click?" (docs/DATABASE.md §4.13, docs/API.md §6).
// Buttons that create something (C2 Create storyboard, later approve, publish …) send a random
// Idempotency-Key. The first request with a key leaves an `in_progress` marker; when it finishes,
// the answer is saved on the marker (`done`). A repeat with the same key and the same request gets
// the saved answer again instead of creating a second project. Records delete themselves after
// 24 hours (TTL index on createdAt). Scoped per user: the same key from two users is two records.

export const IDEMPOTENCY_COLLECTION = "idempotencyKeys";

/** How long an `in_progress` marker blocks repeats before it counts as abandoned (a crashed request). */
export const IDEMPOTENCY_LOCK_MS = 60_000;

export interface IdempotencyDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  key: string;
  fingerprint: string;
  status: "in_progress" | "done";
  lockedUntil: Date | null;
  responseStatus?: number;
  responseBody?: unknown;
  createdAt: Date;
}

export type IdempotencyBeginResult =
  | { kind: "new"; recordId: string }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "reused" }
  | { kind: "in_progress" };

/**
 * Check a key in. `new`: go ahead (and later call finishIdempotency / releaseIdempotency).
 * `replay`: answer with the saved status and body. `reused`: the key came with a different request.
 * `in_progress`: the first request is still running.
 */
export async function beginIdempotency(db: Db, ownerId: string, key: string, fingerprint: string, now: Date = new Date()): Promise<IdempotencyBeginResult> {
  const collection = db.collection<IdempotencyDocument>(IDEMPOTENCY_COLLECTION);
  const owner = new ObjectId(ownerId);
  const lockedUntil = new Date(now.getTime() + IDEMPOTENCY_LOCK_MS);
  // Two tries: if the existing record disappears between our insert and our read (its 5xx release
  // or the TTL), the second insert simply works.
  for (let attempt = 0; attempt < 2; attempt++) {
    const _id = new ObjectId();
    try {
      await collection.insertOne({ _id, ownerId: owner, key, fingerprint, status: "in_progress", lockedUntil, createdAt: now });
      return { kind: "new", recordId: _id.toHexString() };
    } catch (error) {
      // Needs the unique { ownerId, key } index (F12); without it a repeat would be a new record.
      if ((error as { code?: unknown }).code !== 11000) throw error;
    }
    const existing = await collection.findOne({ ownerId: owner, key });
    if (!existing) continue;
    if (existing.fingerprint !== fingerprint) return { kind: "reused" };
    if (existing.status === "done") return { kind: "replay", status: existing.responseStatus ?? 200, body: existing.responseBody ?? null };
    if (existing.lockedUntil && existing.lockedUntil > now) return { kind: "in_progress" };
    // Abandoned marker (the first request crashed): take it over, unless someone else just did.
    const taken = await collection.findOneAndUpdate(
      { _id: existing._id, status: "in_progress", lockedUntil: existing.lockedUntil },
      { $set: { lockedUntil } },
      { returnDocument: "after" },
    );
    return taken ? { kind: "new", recordId: taken._id.toHexString() } : { kind: "in_progress" };
  }
  return { kind: "in_progress" };
}

/**
 * Save the answer on the record. Only an `in_progress` record changes, so calling this twice (once
 * inside the handler's transaction, once by the API pipeline) keeps the first answer.
 */
export async function finishIdempotency(db: Db, recordId: string, status: number, body: unknown, session?: ClientSession): Promise<void> {
  await db
    .collection<IdempotencyDocument>(IDEMPOTENCY_COLLECTION)
    .updateOne(
      { _id: new ObjectId(recordId), status: "in_progress" },
      { $set: { status: "done", lockedUntil: null, responseStatus: status, responseBody: body } },
      session ? { session } : {},
    );
}

/** Forget an unfinished record (after a 5xx), so the client may retry with the same key. */
export async function releaseIdempotency(db: Db, recordId: string): Promise<void> {
  await db.collection<IdempotencyDocument>(IDEMPOTENCY_COLLECTION).deleteOne({ _id: new ObjectId(recordId), status: "in_progress" });
}
