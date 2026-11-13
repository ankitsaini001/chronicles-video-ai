import type { Db } from "mongodb";

// Account lockout after repeated wrong passwords (docs/API.md §3.7, DATABASE.md §4.1).
// The counters live on the Better Auth `user` document: `failedLoginCount`, `lockedUntil`,
// `lastLoginAt`. Every change is ONE atomic update on the server, so two logins at the same moment
// can never lose a count. All lookups use the lowercased email, which has a unique index (F08).
// An email without an account simply matches nothing: nothing is stored for it.

export const USER_COLLECTION = "user";

export const LOGIN_LOCKOUT = {
  /** Wrong passwords in a row that lock the account. */
  maxFailures: 10,
  /** How long the account stays locked. */
  lockSeconds: 15 * 60,
} as const;

export interface LoginGuardUser {
  email: string;
  failedLoginCount?: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date | null;
}

export type LoginLock = { locked: false } | { locked: true; until: Date; retryAfterSeconds: number };

/** Is this email's account locked right now? (Unknown email: not locked.) */
export async function getLoginLock(db: Db, email: string, now: Date = new Date()): Promise<LoginLock> {
  const user = await db
    .collection<LoginGuardUser>(USER_COLLECTION)
    .findOne({ email, lockedUntil: { $gt: now } }, { projection: { _id: 0, lockedUntil: 1 } });
  const until = user?.lockedUntil;
  if (!(until instanceof Date)) return { locked: false };
  return { locked: true, until, retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)) };
}

/**
 * Count one wrong password. Every 10th wrong password in a row (10, 20, …) locks the account for
 * 15 minutes. The count keeps growing until a successful login, so the admin can see it, and after
 * a lock ends the next 10 wrong passwords lock it again.
 * Returns the new count, or null when no account has this email.
 */
export async function recordFailedLogin(db: Db, email: string, now: Date = new Date()): Promise<{ failedLoginCount: number; locked: boolean } | null> {
  const lockUntil = new Date(now.getTime() + LOGIN_LOCKOUT.lockSeconds * 1000);
  const user = await db.collection<LoginGuardUser>(USER_COLLECTION).findOneAndUpdate(
    { email },
    // An update pipeline: the second stage sees the count after the first stage added 1.
    [
      { $set: { failedLoginCount: { $add: [{ $ifNull: ["$failedLoginCount", 0] }, 1] } } },
      {
        $set: {
          lockedUntil: {
            $cond: [{ $eq: [{ $mod: ["$failedLoginCount", LOGIN_LOCKOUT.maxFailures] }, 0] }, lockUntil, { $ifNull: ["$lockedUntil", null] }],
          },
        },
      },
    ],
    { returnDocument: "after", projection: { _id: 0, failedLoginCount: 1, lockedUntil: 1 } },
  );
  if (!user) return null;
  const failedLoginCount = user.failedLoginCount ?? 0;
  return { failedLoginCount, locked: user.lockedUntil instanceof Date && user.lockedUntil.getTime() > now.getTime() };
}

/** A successful login: count back to 0, lock cleared, `lastLoginAt` = now. */
export async function recordSuccessfulLogin(db: Db, email: string, now: Date = new Date()): Promise<void> {
  await db.collection<LoginGuardUser>(USER_COLLECTION).updateOne({ email }, { $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
}
