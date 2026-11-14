import { randomBytes } from "node:crypto";
import { type ClientSession, type Db, ObjectId } from "mongodb";

// "Did we already handle this click?" (docs/DATABASE.md §4.13, docs/API.md §6).
// Buttons that create something (C2 Create storyboard, later approve, publish …) send a random
// Idempotency-Key. The first request with a key leaves an `in_progress` marker; when it finishes,
// the answer is saved on the marker (`done`). A repeat with the same key and the same request gets
// the saved answer again instead of creating a second project. Records delete themselves after
// 24 hours (TTL index on createdAt). Scoped per user: the same key from two users is two records.
//
// Every check-in gets its own random `lockId` (F12 review). If a request is so slow that its marker
// counts as abandoned and a repeat takes it over, the takeover writes a NEW lockId: from then on
// the slow request can neither save its answer nor delete the record (both filter on its lockId).
// An action that saves its answer inside its own transaction (C2) treats "nothing matched" as
// "someone else owns this click now" and rolls the whole transaction back (IdempotencyLockLostError),
// so the same click can never create two projects.

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
  /** Who owns the record while `in_progress`: a new random value for every check-in or takeover. */
  lockId: string | null;
  responseStatus?: number;
  responseBody?: unknown;
  createdAt: Date;
}

/** Proof that this request owns the record: needed to save the answer or release it. */
export type IdempotencyLock = { recordId: string; lockId: string };

/** The record is no longer ours (an abandoned-lock takeover happened). Nothing may be saved. */
export class IdempotencyLockLostError extends Error {
  constructor() {
    super("This click is now being handled by a newer request.");
    this.name = "IdempotencyLockLostError";
  }
}

export type IdempotencyBeginResult =
  | ({ kind: "new" } & IdempotencyLock)
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
    const lockId = newLockId();
    try {
      await collection.insertOne({ _id, ownerId: owner, key, fingerprint, status: "in_progress", lockedUntil, lockId, createdAt: now });
      return { kind: "new", recordId: _id.toHexString(), lockId };
    } catch (error) {
      // Needs the unique { ownerId, key } index (F12); without it a repeat would be a new record.
      if ((error as { code?: unknown }).code !== 11000) throw error;
    }
    const existing = await collection.findOne({ ownerId: owner, key });
    if (!existing) continue;
    if (existing.fingerprint !== fingerprint) return { kind: "reused" };
    if (existing.status === "done") return { kind: "replay", status: existing.responseStatus ?? 200, body: existing.responseBody ?? null };
    if (existing.lockedUntil && existing.lockedUntil > now) return { kind: "in_progress" };
    // Abandoned marker (the first request crashed or is very slow): take it over with a new lockId,
    // unless someone else just did.
    const takeoverLockId = newLockId();
    const taken = await collection.findOneAndUpdate(
      { _id: existing._id, status: "in_progress", lockId: existing.lockId },
      { $set: { lockedUntil, lockId: takeoverLockId } },
      { returnDocument: "after" },
    );
    return taken ? { kind: "new", recordId: taken._id.toHexString(), lockId: takeoverLockId } : { kind: "in_progress" };
  }
  return { kind: "in_progress" };
}

function newLockId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Save the answer on the record, only while this request still owns it (`in_progress` with its
 * lockId). Returns false when nothing matched: the answer was already saved by this request (the
 * handler's transaction, then the API pipeline), or a takeover owns the record now.
 */
export async function finishIdempotency(db: Db, lock: IdempotencyLock, status: number, body: unknown, session?: ClientSession): Promise<boolean> {
  const result = await db
    .collection<IdempotencyDocument>(IDEMPOTENCY_COLLECTION)
    .updateOne(
      { _id: new ObjectId(lock.recordId), status: "in_progress", lockId: lock.lockId },
      { $set: { status: "done", lockedUntil: null, lockId: null, responseStatus: status, responseBody: body } },
      session ? { session } : {},
    );
  return result.matchedCount === 1;
}

/**
 * Inside the transaction of the action itself: save the answer, or throw IdempotencyLockLostError
 * (the caller lets it roll the transaction back) when another request owns the click now.
 */
export async function finishIdempotencyInTransaction(db: Db, lock: IdempotencyLock, status: number, body: unknown, session: ClientSession): Promise<void> {
  if (!(await finishIdempotency(db, lock, status, body, session))) throw new IdempotencyLockLostError();
}

/** Forget an unfinished record (after a 5xx), so the client may retry with the same key. Only our own. */
export async function releaseIdempotency(db: Db, lock: IdempotencyLock): Promise<void> {
  await db.collection<IdempotencyDocument>(IDEMPOTENCY_COLLECTION).deleteOne({ _id: new ObjectId(lock.recordId), status: "in_progress", lockId: lock.lockId });
}
