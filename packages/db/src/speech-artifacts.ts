import { Binary, type ClientSession, type Db, ObjectId } from "mongodb";

// Recorded narration, one document per recording (docs/DATABASE.md §4.18 `speechArtifacts`, F23).
// The audio and its timing files are in R2 (users/{ownerId}/speech/{cacheKey hex}/…); this document
// is THE LOCK that stops paying ElevenLabs twice for the same recording (ARCHITECTURE §9, F22 MUST):
//   1. claim it as `pending` with a conditional insert on the unique { ownerId, cacheKey } BEFORE
//      calling ElevenLabs (claimSpeech);
//   2. save the provider's answer AND the paid audio bytes here (saveSpeechResponse), in one write,
//      BEFORE uploading anything: from then on the recording is never paid for again; a re-run, a
//      retry or another job uploads these bytes;
//   3. upload the files create-only, then mark it `ready` (markSpeechReady), which removes the bytes.
// Whoever finds it `ready` reuses it (no call). A `failed` one is taken over at once (its saved
// answer and bytes, if any, are kept and reused). A `pending` claim is taken over:
//   - by its own job at once when the answer is saved (no call is ever made for it again);
//   - otherwise only when older than SPEECH_LOCK_STALE_MS, even by the same job: somebody may be
//     calling ElevenLabs right now (e.g. Inngest re-running a step whose first run is still alive).
// A job that ends releases its pending claims (releaseSpeechClaims), so others don't wait. An answer
// that arrives after that is still saved on the released recording (saveSpeechResponse "released").
// Reuse never crosses owners.
// NEEDS the unique index { ownerId, cacheKey } (npm run db -- indexes --feature F23 --apply).

export const SPEECH_ARTIFACTS_COLLECTION = "speechArtifacts";
export const SPEECH_ARTIFACT_SCHEMA_VERSION = 1;

/**
 * A pending claim older than this is treated as abandoned. It must stay above the longest time a
 * recording can be in flight before its answer is saved: one ElevenLabs request with its 2 quick
 * retries is at most 3 × 120 s (the request timeout) + 2 × 60 s (the longest wait honoured) = 8 min.
 */
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
  /**
   * The paid audio (MP3 bytes, about 100–250 KB), saved in the same write as `response` and removed
   * once the files are in R2 (ready). A retry uploads these instead of paying ElevenLabs again.
   */
  audio?: Binary | Uint8Array | null;
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
 * Pure: may this job take the recording over? Yes when it failed before (or has no claim); when it
 * is this same job's claim AND the paid answer is already saved (finishing it never calls
 * ElevenLabs); or when the claim is older than SPEECH_LOCK_STALE_MS. A fresh claim WITHOUT a saved
 * answer is never taken over, not even by the same job: its first run may still be calling ElevenLabs.
 */
export function canTakeOverSpeech(doc: Pick<SpeechArtifactDocument, "status" | "claim" | "response">, jobId: ObjectId, now: Date): boolean {
  if (doc.status === "ready") return false;
  if (doc.status === "failed" || !doc.claim) return true;
  if (doc.response && doc.claim.jobId.equals(jobId)) return true;
  return now.getTime() - doc.claim.at.getTime() >= SPEECH_LOCK_STALE_MS;
}

/** The saved paid audio of a recording, or null (none saved, or already in R2 and removed). */
export function savedAudioOf(doc: Pick<SpeechArtifactDocument, "audio">): Uint8Array | null {
  const audio = doc.audio;
  if (!audio) return null;
  const bytes = audio instanceof Binary ? audio.value() : audio;
  return bytes.byteLength > 0 ? new Uint8Array(bytes) : null;
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
/** A recording whose claim was released before any answer was saved (its job ended mid-request). */
const RELEASED_WITHOUT_ANSWER = { status: "failed" as const, claim: null, response: null };

/** Where a paid answer was saved: "held" = this job still holds the claim; "released" = see speechSaveTarget. */
export type SpeechSaveTarget = "held" | "released";

/**
 * Pure: where may this job save a paid answer? The same rule as saveSpeechResponse's filters.
 * "held": this job and attempt still hold the pending claim (go on and upload it).
 * "released": the claim was released while the request was in flight (the job ended: Cancel and the
 * 60-second rule, the stuck rule…), and no answer is saved yet: the answer and bytes are saved there
 * anyway, its status left `failed`, so the next job uploads them instead of paying again.
 * Null: another run holds it, it already has an answer, or it is ready.
 */
export function speechSaveTarget(doc: Pick<SpeechArtifactDocument, "status" | "claim" | "response">, jobId: ObjectId, attempt: number): SpeechSaveTarget | null {
  if (doc.status === "pending" && doc.claim?.jobId.equals(jobId) && doc.claim.attempt === attempt) return "held";
  if (doc.status === "failed" && !doc.claim && !doc.response) return "released";
  return null;
}

/**
 * Step 2: save the paid answer AND its audio bytes in ONE write, BEFORE uploading anything. From here
 * on this recording is never paid for again. Saved while this job holds the claim ("held"), or on the
 * released recording when the job ended while ElevenLabs was answering ("released": status unchanged;
 * the worker then stops). Null = nothing saved (speechSaveTarget).
 */
export async function saveSpeechResponse(
  db: Db,
  input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; response: SpeechRecordDoc; audio: Uint8Array; durationMs: number | null; now?: Date },
): Promise<SpeechSaveTarget | null> {
  const now = input.now ?? new Date();
  const key = { ownerId: input.ownerId, cacheKey: input.cacheKey };
  const answer = {
    response: input.response,
    audio: new Binary(input.audio),
    audioSha256: input.response.audioSha256,
    characters: input.response.charactersSent,
    durationMs: input.durationMs,
    paidByJobId: input.jobId,
    updatedAt: now,
  };
  const held = await collection(db).updateOne({ ...key, ...claimedBy(input.jobId, input.attempt) }, { $set: { ...answer, "claim.at": now } });
  if (held.matchedCount === 1) return "held";
  const released = await collection(db).updateOne({ ...key, ...RELEASED_WITHOUT_ANSWER }, { $set: answer });
  return released.matchedCount === 1 ? "released" : null;
}

/** Step 3: the files are in R2: ready for everyone of this owner (the saved answer and bytes are removed). */
export async function markSpeechReady(db: Db, input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await collection(db).updateOne(
    { ownerId: input.ownerId, cacheKey: input.cacheKey, ...claimedBy(input.jobId, input.attempt), audioSha256: { $type: "string" } },
    { $set: { status: "ready", claim: null, response: null, error: null, readyAt: now, updatedAt: now }, $unset: { audio: "" } },
  );
  return result.matchedCount === 1;
}

/**
 * The recording failed (provider refused it, upload failed…). The saved answer and bytes are KEPT:
 * the next try (of any job of this owner) uploads them instead of paying again. `message` is a fixed
 * plain line written by our code (the provider's own text goes to the server log only).
 */
export async function markSpeechFailed(db: Db, input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; message: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await collection(db).updateOne(
    { ownerId: input.ownerId, cacheKey: input.cacheKey, ...claimedBy(input.jobId, input.attempt) },
    { $set: { status: "failed", claim: null, error: { message: input.message.slice(0, 300), at: now }, updatedAt: now } },
  );
}

/**
 * A job ended (failed, cancelled, needs input, stuck): its pending claims become `failed` so other
 * jobs don't wait for them. Saved answers and bytes are kept (the next try uploads them, no call).
 */
export async function releaseSpeechClaims(db: Db, input: { ownerId: ObjectId; jobId: ObjectId; now?: Date }, session?: ClientSession): Promise<void> {
  const now = input.now ?? new Date();
  await collection(db).updateMany(
    { ownerId: input.ownerId, status: "pending", "claim.jobId": input.jobId },
    { $set: { status: "failed", claim: null, error: { message: "The video job ended before this recording was finished", at: now }, updatedAt: now } },
    session ? { session } : {},
  );
}

/**
 * The cache keys among these that cost nothing more: ready, or with a saved paid answer and its bytes
 * (only the upload is left). The voice limits only count recordings that are not among these.
 */
export async function paidSpeechKeys(db: Db, ownerId: ObjectId, cacheKeys: readonly string[], session?: ClientSession): Promise<string[]> {
  if (cacheKeys.length === 0) return [];
  const docs = await collection(db)
    .find(
      { ownerId, cacheKey: { $in: [...new Set(cacheKeys)] }, $or: [{ status: "ready" }, { audio: { $type: "binData" }, response: { $ne: null } }] },
      { projection: { cacheKey: 1 }, ...(session ? { session } : {}) },
    )
    .toArray();
  return docs.map((d) => d.cacheKey);
}

/** The owner's ready recordings among these cache keys (reuse never crosses owners). */
export async function readySpeech(db: Db, ownerId: ObjectId, cacheKeys: readonly string[], session?: ClientSession): Promise<SpeechArtifactDocument[]> {
  if (cacheKeys.length === 0) return [];
  return collection(db)
    .find({ ownerId, cacheKey: { $in: [...new Set(cacheKeys)] }, status: "ready" }, session ? { session } : {})
    .toArray();
}
