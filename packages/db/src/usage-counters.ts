import { type ClientSession, type Db, ObjectId } from "mongodb";
import { usagePeriods } from "./usage";

// Daily / monthly counts behind the product limits (docs/DATABASE.md §4.14 `usageCounters`,
// docs/API.md §10.1). One document per user, kind and period (the day or month in the user's
// timezone). F12 counts and enforces `projects` (5 per day); F14 `brainstorms` (30 per day, outside
// a transaction: brainstorm.ts); videos and voice characters follow with generation (F23/F27).

export const USAGE_COUNTERS_COLLECTION = "usageCounters";

export type UsageKind = "videos" | "projects" | "voiceChars" | "brainstorms";

export interface UsageCounterDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  kind: UsageKind;
  /** "2026-11-13" for daily kinds, "2026-11" for voiceChars, in the user's timezone. */
  period: string;
  count: number;
  /** A week after the period ends; the TTL index then deletes the counter. */
  expiresAt: Date;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The counter's period and its expiry (a week after the period ends). */
export function usageCounterPeriod(kind: UsageKind, timezone: string, now: Date = new Date()): { period: string; resetsAt: Date; expiresAt: Date } {
  const p = usagePeriods(timezone, now);
  const resetsAt = kind === "voiceChars" ? p.monthResetsAt : p.dayResetsAt;
  return { period: kind === "voiceChars" ? p.month : p.day, resetsAt, expiresAt: new Date(resetsAt.getTime() + WEEK_MS) };
}

/** How much this user used in the current period (0 when there is no counter yet). */
export async function readUsageCount(db: Db, ownerId: string, kind: UsageKind, timezone: string, now: Date = new Date()): Promise<number> {
  const { period } = usageCounterPeriod(kind, timezone, now);
  const doc = await db.collection<UsageCounterDocument>(USAGE_COUNTERS_COLLECTION).findOne({ ownerId: new ObjectId(ownerId), kind, period }, { projection: { count: 1 } });
  return doc?.count ?? 0;
}

export type UsageAddResult = { ok: true; used: number } | { ok: false; used: number; limit: number; resetsAt: Date };

/**
 * Add `amount` to the counter, only if the total stays within `limit`. MUST run inside the
 * transaction of the action it counts (DATABASE.md §7.2 #1): when the limit is reached, the caller
 * throws, the transaction rolls back, and the +1 never happened. Two requests at the same moment
 * both write the same counter document, so MongoDB lets one commit and re-runs the other
 * (a write conflict, retried by withTransaction), which then sees the new count: nobody gets past
 * the limit. Needs the unique { ownerId, kind, period } index so two first requests of the day
 * can't create two counters.
 */
export async function addUsageWithinLimit(
  db: Db,
  session: ClientSession,
  input: { ownerId: string; kind: UsageKind; timezone: string; limit: number; amount?: number; now?: Date },
): Promise<UsageAddResult> {
  const amount = input.amount ?? 1;
  const { period, resetsAt, expiresAt } = usageCounterPeriod(input.kind, input.timezone, input.now ?? new Date());
  const doc = await db
    .collection<UsageCounterDocument>(USAGE_COUNTERS_COLLECTION)
    .findOneAndUpdate(
      { ownerId: new ObjectId(input.ownerId), kind: input.kind, period },
      { $inc: { count: amount }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: "after", session },
    );
  const used = doc?.count ?? amount;
  if (used > input.limit) return { ok: false, used: used - amount, limit: input.limit, resetsAt };
  return { ok: true, used };
}
