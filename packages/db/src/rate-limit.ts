import { createHash } from "node:crypto";
import type { Db } from "mongodb";

// "Too many attempts" counters (docs/DATABASE.md §4.6, Q13; docs/API.md §3.7).
// One collection for every limit. Each attempt does one atomic "add 1, create if missing" on the
// counter for the current FIXED window (e.g. 04:30:00–04:45:00). A new window gets a new document,
// so old counters are simply never read again, and the TTL index on `expiresAt` deletes them.
// No raw IP address or email is stored: only a SHA-256 hash of it.
// Better Auth's own limiter is off (it counts in server memory, which is useless on Vercel).

export const RATE_LIMITS_COLLECTION = "rateLimits";

export interface RateLimitRule {
  /** Short name, part of the counter id (e.g. "signup-ip"). Letters, digits and "-" only. */
  name: string;
  /** Attempts allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/** The auth limits from API.md §3.7. A5/A6 limits come with F33/F35. */
export const AUTH_RATE_LIMITS = {
  /** A1 sign-up: 5 requests per 15 minutes per IP address. */
  signUpPerIp: { name: "signup-ip", limit: 5, windowSeconds: 15 * 60 },
  /** A2 sign-in: 5 attempts per 15 minutes per IP address. */
  signInPerIp: { name: "signin-ip", limit: 5, windowSeconds: 15 * 60 },
  /** A2 sign-in: 5 attempts per 15 minutes per (lowercased) email. Checked as well as the IP. */
  signInPerEmail: { name: "signin-email", limit: 5, windowSeconds: 15 * 60 },
  /** A4 get-session: 120 requests per minute per IP address. */
  getSessionPerIp: { name: "session-ip", limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

/** The /api/v1 limits from API.md §10.3, per signed-in user. More arrive with each endpoint. */
export const API_RATE_LIMITS = {
  /** "Other reads (GET)": 300 requests per minute per user, shared by all plain GET endpoints. */
  readsPerUser: { name: "v1-read-user", limit: 300, windowSeconds: 60 },
  /** C2 create project: 10 per hour per user (plus the 5 projects/day quota). */
  createProjectPerUser: { name: "create-project", limit: 10, windowSeconds: 60 * 60 },
  /** C7 brainstorm: 10 per hour per user (plus 30 per day, USAGE_LIMITS.brainstormsPerDay; F14). */
  brainstormPerUser: { name: "brainstorm", limit: 10, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitDocument {
  /** `<rule>:sha256:<hash of the subject>:<window start, ISO>` */
  _id: string;
  count: number;
  /** End of the window. The TTL index deletes the counter soon after. */
  expiresAt: Date;
}

export interface RateLimitResult {
  /** False once this attempt is over the limit. */
  allowed: boolean;
  /** Attempts in this window, including this one. */
  count: number;
  limit: number;
  /** When the window ends. */
  resetsAt: Date;
  /** Whole seconds until the window ends (at least 1), for the Retry-After header. */
  retryAfterSeconds: number;
}

/** SHA-256 of the subject (IP address, lowercased email or user id), as lowercase hex. */
export function hashRateLimitSubject(subject: string): string {
  return createHash("sha256").update(subject, "utf8").digest("hex");
}

/** The fixed window that `now` falls into. */
export function rateLimitWindow(rule: RateLimitRule, now: Date): { start: Date; end: Date } {
  const length = rule.windowSeconds * 1000;
  const start = Math.floor(now.getTime() / length) * length;
  return { start: new Date(start), end: new Date(start + length) };
}

/** The counter id for this rule, subject and window. */
export function rateLimitId(rule: RateLimitRule, subject: string, now: Date): string {
  return `${rule.name}:sha256:${hashRateLimitSubject(subject)}:${rateLimitWindow(rule, now).start.toISOString()}`;
}

/**
 * Count one attempt and say whether it is still within the limit. Every call counts, also the ones
 * that end up refused, so hammering the endpoint never resets the window.
 */
export async function hitRateLimit(db: Db, rule: RateLimitRule, subject: string, now: Date = new Date()): Promise<RateLimitResult> {
  const { end } = rateLimitWindow(rule, now);
  const _id = rateLimitId(rule, subject, now);
  const collection = db.collection<RateLimitDocument>(RATE_LIMITS_COLLECTION);
  const increment = () =>
    collection.findOneAndUpdate({ _id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: end } }, { upsert: true, returnDocument: "after" });

  let doc: RateLimitDocument | null;
  try {
    doc = await increment();
  } catch (error) {
    // Two first attempts at the same moment: both try to create the counter and MongoDB refuses
    // the second (duplicate _id, E11000). The counter exists now, so adding 1 again works.
    if ((error as { code?: unknown }).code !== 11000) throw error;
    doc = await increment();
  }
  const count = doc?.count ?? 1;
  return {
    allowed: count <= rule.limit,
    count,
    limit: rule.limit,
    resetsAt: end,
    retryAfterSeconds: Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000)),
  };
}
