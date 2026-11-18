import { type Db, ObjectId } from "mongodb";

// A record of every paid AI/render call (docs/DATABASE.md §4.15 `providerUsage`). Written BEFORE
// the call (`reserved`) and finished after it (`final` / `failed`), so a crash can't hide spending:
// a `reserved` row still counts toward the spend ceilings (F27). F14 logs the C7 brainstorm calls.
// Never stores what the creator typed (no subject, prompt or answer text): only who, which
// service, how much and how it ended.

export const PROVIDER_USAGE_COLLECTION = "providerUsage";
export const PROVIDER_USAGE_SCHEMA_VERSION = 1;

export type UsageProvider = "gemini" | "elevenlabs" | "vercel-sandbox" | "meta";

export interface ProviderUsageUnits {
  promptTokens: number;
  /** Billed output tokens: the answer plus the model's thinking tokens. */
  outputTokens: number;
  characters: number;
  renderSeconds: number;
}

export interface ProviderUsageDocument {
  _id: ObjectId;
  /** Removed when the account is deleted (anonymized, DATABASE.md §6.7). */
  ownerId?: ObjectId;
  /** Not set for calls without a project (brainstorm). */
  projectId?: ObjectId;
  jobId?: ObjectId;
  schemaVersion: number;
  provider: UsageProvider;
  operation: string;
  model: string;
  units: ProviderUsageUnits;
  estCostInr: number;
  status: "reserved" | "final" | "failed";
  /** How the call ended, e.g. "ok", "invalid_output", "busy", "timeout", "rejected" (null while reserved). */
  outcome: string | null;
  /** Milliseconds from sending the request to its end (null while reserved). */
  latencyMs: number | null;
  /**
   * Why a failed call failed, as a short fixed code (F26, Gemini storyboard and change requests):
   * e.g. "transient 503 UNAVAILABLE", "quota 429 RESOURCE_EXHAUSTED", "transient timeout". Never the
   * provider's free text. Absent on rows written before F26 and on calls that didn't fail.
   */
  errorCode?: string;
  at: Date;
}

const NO_UNITS: ProviderUsageUnits = { promptTokens: 0, outputTokens: 0, characters: 0, renderSeconds: 0 };

/** Write the `reserved` row before calling the provider. Returns its id. */
export async function reserveProviderUsage(
  db: Db,
  input: { ownerId: string; provider: UsageProvider; operation: string; model: string; estCostInr?: number; units?: Partial<ProviderUsageUnits>; projectId?: string; jobId?: string; now?: Date },
): Promise<ObjectId> {
  const doc: ProviderUsageDocument = {
    _id: new ObjectId(),
    ownerId: new ObjectId(input.ownerId),
    ...(input.projectId ? { projectId: new ObjectId(input.projectId) } : {}),
    ...(input.jobId ? { jobId: new ObjectId(input.jobId) } : {}),
    schemaVersion: PROVIDER_USAGE_SCHEMA_VERSION,
    provider: input.provider,
    operation: input.operation,
    model: input.model,
    // The estimate while reserved (ElevenLabs, F23: the characters about to be sent).
    units: { ...NO_UNITS, ...input.units },
    estCostInr: input.estCostInr ?? 0,
    status: "reserved",
    outcome: null,
    latencyMs: null,
    at: input.now ?? new Date(),
  };
  await db.collection<ProviderUsageDocument>(PROVIDER_USAGE_COLLECTION).insertOne(doc);
  return doc._id;
}

/** Finish a `reserved` row with what the call really used. Only a still-reserved row is changed. */
export async function finishProviderUsage(
  db: Db,
  id: ObjectId,
  input: { status: "final" | "failed"; outcome: string; model: string; units?: Partial<ProviderUsageUnits>; estCostInr?: number; latencyMs: number; errorCode?: string },
): Promise<void> {
  const units: ProviderUsageUnits = { ...NO_UNITS, ...input.units };
  const errorCode = input.errorCode ? input.errorCode.slice(0, 80) : null;
  await db.collection<ProviderUsageDocument>(PROVIDER_USAGE_COLLECTION).updateOne(
    { _id: id, status: "reserved" },
    {
      $set: {
        status: input.status,
        outcome: input.outcome,
        model: input.model,
        units,
        estCostInr: input.estCostInr ?? 0,
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
        ...(errorCode ? { errorCode } : {}),
      },
    },
  );
}
