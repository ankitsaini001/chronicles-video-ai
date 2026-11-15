import { type ClientSession, type Db, ObjectId } from "mongodb";

// Recorded narration, one document per recording (docs/DATABASE.md §4.18 `speechArtifacts`, F23).
// The audio and its timing files are in R2 (users/{ownerId}/speech/{cacheKey hex}/…); this document
// is THE LOCK that stops paying ElevenLabs twice for the same recording (ARCHITECTURE §9, F22 MUST):
//   1. claim it as `pending` with a conditional insert on the unique { ownerId, cacheKey } BEFORE
//      calling ElevenLabs (claimSpeech);
//   2. save the provider's answer here (saveSpeechResponse) BEFORE uploading the files, so a crash
//      after the upload never needs a second paid call (the saved answer + the uploaded audio are
//      reused);
//   3. upload the files create-only, then mark it `ready` (markSpeechReady).
// Whoever finds it `ready` reuses it (no call). Whoever finds a fresh claim of ANOTHER job waits and
// tries again later; a claim of the same job (a re-run of the step, or a retry) or a claim older
// than SPEECH_LOCK_STALE_MS (the holder died) is taken over. Reuse never crosses owners.
// NEEDS the unique index { ownerId, cacheKey } (npm run db -- indexes --feature F23 --apply).

export const SPEECH_ARTIFACTS_COLLECTION = "speechArtifacts";
export const SPEECH_ARTIFACT_SCHEMA_VERSION = 1;

/** A pending claim older than this is treated as abandoned (one ElevenLabs call with its retries takes at most ~6 min). */
export const SPEECH_LOCK_STALE_MS = 10 * 60_000;

/** The provider's answer, as saved before the upload (the pipeline's SpeechCacheRecord, without the audio bytes). */
export type SpeechRecordDoc = Record<string, unknown> & { audioSha256: string; charactersSent: number };

export interface SpeechArtifactDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  schemaVersion: number;
  /** "sha256:<hex>" of everything that changes the audio (text, pronunciation, voice, model, settings…). */
  cacheKey: string;
  sceneId: string;
  firstProjectId: ObjectId;
  voiceId: string;
  model: string;
  settings: Record<string, unknown>;
  audioKey: string;
  alignmentKey: string;
  normalizedAlignmentKey: string;
  /** Length from the alignment (the exact decoded length is measured again at every render). */
  durationMs: number | null;
  /** Characters sent to ElevenLabs for this recording (what it costs). */
  characters: number;
  /** "sha256:<hex>" of audio.mp3, checked when the file is downloaded for a render. */
  audioSha256: string | null;
  status: "pending" | "ready" | "failed";
  /** Who is recording it now: the job and its attempt, and when that started. Null when not pending. */
  claim: { jobId: ObjectId; attempt: number; at: Date } | null;
  /** The provider's answer, saved before the upload; cleared when ready. */
  response: SpeechRecordDoc | null;
  /** The job that paid for it (F23). */
  paidByJobId: ObjectId | null;
  error: { message: string; at: Date } | null;
  createdAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
}

export interface SpeechSetup {
  sceneId: string;
  firstProjectId: ObjectId;
  voiceId: string;
  model: string;
  settings: Record<string, unknown>;
  audioKey: string;
  alignmentKey: string;
  normalizedAlignmentKey: string;
  characters: number;
}

export type SpeechClaim =
  | { kind: "ready"; doc: SpeechArtifactDocument }
  | { kind: "claimed"; doc: SpeechArtifactDocument }
  | { kind: "busy"; doc: SpeechArtifactDocument };

/**
 * Pure: may this job take the recording over? Yes when it failed before, when the claim is this
 * same job's (a re-run of its step, or its retry: an older attempt is dead by then), or when the
 * claim is older than SPEECH_LOCK_STALE_MS.
 */
export function canTakeOverSpeech(doc: Pick<SpeechArtifactDocument, "status" | "claim">, jobId: ObjectId, now: Date): boolean {
  if (doc.status === "ready") return false;
  if (doc.status === "failed" || !doc.claim) return true;
  if (doc.claim.jobId.equals(jobId)) return true;
  return now.getTime() - doc.claim.at.getTime() >= SPEECH_LOCK_STALE_MS;
}

const collection = (db: Db) => db.collection<SpeechArtifactDocument>(SPEECH_ARTIFACTS_COLLECTION);

/** Step 1: claim the recording (conditional insert), or learn that it is ready / busy. */
export async function claimSpeech(
  db: Db,
  input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; setup: SpeechSetup; now?: Date },
): Promise<SpeechClaim> {
  const now = input.now ?? new Date();
  const claim = { jobId: input.jobId, attempt: input.attempt, at: now };
  const inserted = await collection(db).updateOne(
    { ownerId: input.ownerId, cacheKey: input.cacheKey },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        ownerId: input.ownerId,
        schemaVersion: SPEECH_ARTIFACT_SCHEMA_VERSION,
        cacheKey: input.cacheKey,
        ...input.setup,
        durationMs: null,
        audioSha256: null,
        status: "pending",
        claim,
        response: null,
        paidByJobId: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        readyAt: null,
      },
    },
    { upsert: true },
  );
  const doc = await collection(db).findOne({ ownerId: input.ownerId, cacheKey: input.cacheKey });
  if (!doc) throw new Error("speech artifact vanished right after it was claimed");
  if (inserted.upsertedCount === 1) return { kind: "claimed", doc };
  if (doc.status === "ready") return { kind: "ready", doc };
  if (!canTakeOverSpeech(doc, input.jobId, now)) return { kind: "busy", doc };
  // Take it over, only if nobody changed it since we read it (updatedAt is the version).
  const taken = await collection(db).findOneAndUpdate(
    { _id: doc._id, status: doc.status, updatedAt: doc.updatedAt },
    { $set: { status: "pending", claim, error: null, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (taken) return { kind: "claimed", doc: taken };
  const current = await collection(db).findOne({ _id: doc._id });
  return current?.status === "ready" ? { kind: "ready", doc: current } : { kind: "busy", doc: current ?? doc };
}

const claimedBy = (jobId: ObjectId, attempt: number) => ({ status: "pending" as const, "claim.jobId": jobId, "claim.attempt": attempt });

/** Step 2: save the paid answer BEFORE uploading (only while this job still holds the claim). */
export async function saveSpeechResponse(
  db: Db,
  input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; response: SpeechRecordDoc; durationMs: number | null; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await collection(db).updateOne(
    { ownerId: input.ownerId, cacheKey: input.cacheKey, ...claimedBy(input.jobId, input.attempt) },
    { $set: { response: input.response, audioSha256: input.response.audioSha256, characters: input.response.charactersSent, durationMs: input.durationMs, paidByJobId: input.jobId, "claim.at": now, updatedAt: now } },
  );
  return result.matchedCount === 1;
}

/** Step 3: the files are in R2: ready for everyone of this owner (the saved answer is no longer needed). */
export async function markSpeechReady(db: Db, input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await collection(db).updateOne(
    { ownerId: input.ownerId, cacheKey: input.cacheKey, ...claimedBy(input.jobId, input.attempt), audioSha256: { $type: "string" } },
    { $set: { status: "ready", claim: null, response: null, error: null, readyAt: now, updatedAt: now } },
  );
  return result.matchedCount === 1;
}

/**
 * The recording failed (provider refused it, upload failed…). The saved answer is KEPT: if its
 * audio already reached R2, the next try reuses it instead of paying again.
 */
export async function markSpeechFailed(db: Db, input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; message: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await collection(db).updateOne(
    { ownerId: input.ownerId, cacheKey: input.cacheKey, ...claimedBy(input.jobId, input.attempt) },
    { $set: { status: "failed", claim: null, error: { message: input.message.slice(0, 300), at: now }, updatedAt: now } },
  );
}

/** The owner's ready recordings among these cache keys (reuse never crosses owners). */
export async function readySpeech(db: Db, ownerId: ObjectId, cacheKeys: readonly string[], session?: ClientSession): Promise<SpeechArtifactDocument[]> {
  if (cacheKeys.length === 0) return [];
  return collection(db)
    .find({ ownerId, cacheKey: { $in: [...new Set(cacheKeys)] }, status: "ready" }, session ? { session } : {})
    .toArray();
}
