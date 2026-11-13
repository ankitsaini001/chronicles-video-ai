import { type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { cleanIdeaText } from "./idea-text";
import { LANGUAGES } from "./projects";
import { USAGE_COUNTERS_COLLECTION, usageCounterPeriod, type UsageCounterDocument } from "./usage-counters";
import { USAGE_LIMITS } from "./usage";

// C7 POST /api/v1/brainstorm (docs/API.md C7): the request body and the brainstorms/day count.
// Limits per creator (founder, 2026-11-13): 10 per hour (the rateLimits counter, API_RATE_LIMITS)
// AND 30 per day in the user's timezone (a `brainstorms` usageCounter, here). A refused request
// never reaches the AI.

/** The subject: 2–100 characters after the idea-text cleaning (control characters, NFC, trim). */
export const BRAINSTORM_SUBJECT_LIMITS = { min: 2, max: 100 } as const;

const subject = z
  .string({ error: "must be text" })
  .transform(cleanIdeaText)
  .pipe(
    z
      .string()
      .min(BRAINSTORM_SUBJECT_LIMITS.min, { error: `must be at least ${BRAINSTORM_SUBJECT_LIMITS.min} characters` })
      .max(BRAINSTORM_SUBJECT_LIMITS.max, { error: `must be at most ${BRAINSTORM_SUBJECT_LIMITS.max} characters` }),
  );

/** C7 request body. Strict: unknown fields → 400 INVALID_INPUT. */
export const BrainstormBodySchema = z.strictObject({
  subject,
  language: z.enum(LANGUAGES, { error: `must be one of ${LANGUAGES.join(", ")}` }),
});

export type BrainstormBody = z.output<typeof BrainstormBodySchema>;

export type BrainstormCountResult = { ok: true; used: number } | { ok: false; used: number; limit: number; resetsAt: Date };

/**
 * Count one brainstorm for today (user timezone), only while under the daily limit. One atomic
 * update: "add 1 where count < limit, create the counter if missing". At the limit the filter
 * matches nothing and the upsert's insert hits the unique { ownerId, kind, period } index (E11000):
 * that means "full", and nothing was added. Two first brainstorms of the day at the same moment
 * can also get E11000; the retry then finds the new counter and adds to it.
 */
export async function countBrainstormWithinLimit(
  db: Db,
  input: { ownerId: string; timezone: string; limit?: number; now?: Date },
): Promise<BrainstormCountResult> {
  const limit = input.limit ?? USAGE_LIMITS.brainstormsPerDay;
  const { period, resetsAt, expiresAt } = usageCounterPeriod("brainstorms", input.timezone, input.now ?? new Date());
  const ownerId = new ObjectId(input.ownerId);
  const counters = db.collection<UsageCounterDocument>(USAGE_COUNTERS_COLLECTION);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const doc = await counters.findOneAndUpdate(
        { ownerId, kind: "brainstorms", period, count: { $lt: limit } },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
        { upsert: true, returnDocument: "after" },
      );
      return { ok: true, used: doc?.count ?? 1 };
    } catch (error) {
      if ((error as { code?: unknown }).code !== 11000) throw error;
    }
    const existing = await counters.findOne({ ownerId, kind: "brainstorms", period }, { projection: { count: 1 } });
    if (existing && existing.count >= limit) return { ok: false, used: existing.count, limit, resetsAt };
  }
  const existing = await counters.findOne({ ownerId, kind: "brainstorms", period }, { projection: { count: 1 } });
  return { ok: false, used: existing?.count ?? limit, limit, resetsAt };
}
