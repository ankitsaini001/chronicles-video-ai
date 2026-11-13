import type { Db, ObjectId } from "mongodb";
import { z } from "zod";

// The invite list (F07, docs/DATABASE.md §4.5). Only emails on this list can sign up (F08 checks
// it). In F07 it is managed with `npm run db -- invite ...`; the admin page comes in F34.

export const ALLOWLIST_COLLECTION = "allowlist";

export interface AllowlistEntry {
  _id: ObjectId;
  /** Always lowercase and trimmed. */
  email: string;
  /** Who this person is (optional, for the admin). */
  note?: string;
  /** The admin who invited them; null when added by the command (DATABASE.md Q14). */
  invitedBy: ObjectId | null;
  createdAt: Date;
  /** Filled in by sign-up (F08). */
  signedUpUserId: ObjectId | null;
}

const MAX_EMAIL = 254;
const MAX_NOTE = 200;
/**
 * zod's email check: plain ASCII addresses only, so hidden characters copied from chat apps
 * (e.g. a zero-width space), angle brackets, double dots or accents are refused. Sign-up (F08)
 * checks emails with zod as well, so the invite list and sign-up can't disagree (confirm in F08).
 */
const EMAIL = z.email();

export type NormalizedEmail = { ok: true; email: string } | { ok: false; problem: string };

/** Trim and lowercase an email, then check it looks like an email. */
export function normalizeEmail(input: string): NormalizedEmail {
  const email = input.trim().toLowerCase();
  if (email === "") return { ok: false, problem: "The email is empty." };
  if (email.length > MAX_EMAIL) return { ok: false, problem: `The email is too long (max ${MAX_EMAIL} characters).` };
  if (!EMAIL.safeParse(email).success) return { ok: false, problem: `"${input.trim()}" doesn't look like an email address (expected name@example.com).` };
  return { ok: true, email };
}

export type AddInviteResult = { status: "added"; entry: AllowlistEntry } | { status: "already_invited"; entry: AllowlistEntry };

/**
 * Invite an email. Inviting the same email again changes nothing and reports "already_invited".
 * The unique `email` index (created by `npm run db -- invite add` / the F07 setup, not here) makes
 * duplicates impossible, even for two adds at the same moment.
 */
export async function addInvite(db: Db, email: string, options: { note?: string; now?: Date } = {}): Promise<AddInviteResult> {
  const normalized = normalizeEmail(email);
  if (!normalized.ok) throw new InviteInputError(normalized.problem);
  const note = options.note?.trim();
  if (note && note.length > MAX_NOTE) throw new InviteInputError(`The note is too long (max ${MAX_NOTE} characters).`);

  const collection = db.collection<Omit<AllowlistEntry, "_id">>(ALLOWLIST_COLLECTION);
  const doc: Omit<AllowlistEntry, "_id"> = {
    email: normalized.email,
    ...(note ? { note } : {}),
    invitedBy: null,
    createdAt: options.now ?? new Date(),
    signedUpUserId: null,
  };
  // Insert only if missing; an existing entry is left exactly as it is.
  let added: boolean;
  try {
    added = (await collection.updateOne({ email: normalized.email }, { $setOnInsert: doc }, { upsert: true })).upsertedCount === 1;
  } catch (error) {
    // Two adds at the same moment: the unique index refuses the second (E11000). Same result as
    // "already invited".
    if ((error as { code?: unknown }).code !== 11000) throw error;
    added = false;
  }
  const entry = (await collection.findOne({ email: normalized.email })) as AllowlistEntry | null;
  if (!entry) throw new Error("The invite was saved but could not be read back.");
  return added ? { status: "added", entry } : { status: "already_invited", entry };
}

/** All invites, oldest first. */
export async function listInvites(db: Db): Promise<AllowlistEntry[]> {
  return db.collection<AllowlistEntry>(ALLOWLIST_COLLECTION).find({}).sort({ createdAt: 1, _id: 1 }).toArray();
}

/**
 * Remove an invite. Only stops FUTURE sign-ups: an account that already exists keeps working
 * (suspend it instead, F34). Returns whether an entry was removed.
 */
export async function removeInvite(db: Db, email: string): Promise<{ removed: boolean; email: string }> {
  const normalized = normalizeEmail(email);
  if (!normalized.ok) throw new InviteInputError(normalized.problem);
  const result = await db.collection(ALLOWLIST_COLLECTION).deleteOne({ email: normalized.email });
  return { removed: result.deletedCount === 1, email: normalized.email };
}

/** Is this email invited? (Used by sign-up in F08.) */
export async function isInvited(db: Db, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized.ok) return false;
  return (await db.collection(ALLOWLIST_COLLECTION).countDocuments({ email: normalized.email }, { limit: 1 })) === 1;
}

/** Bad input from the person running the command (not a database problem). */
export class InviteInputError extends Error {
  override name = "InviteInputError";
}
