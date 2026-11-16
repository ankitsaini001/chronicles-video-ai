import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GENERATE_MESSAGES,
  recordingMessage,
  renderingMessage,
  savedAudioOf,
  SPEECH_LOCK_STALE_MS,
  type GenerateErrorCode,
  type GenerateJobContext,
  type GenerateStage,
  type JobNeedsInput,
  type RenderToSave,
  type SpeechArtifactDocument,
  type SpeechClaim,
  type SpeechRecordDoc,
  type SpeechSaveTarget,
  type SpeechSetup,
  type VoiceReservation,
  type VoiceScene,
} from "@bytereel/db";
import type { Plan } from "@bytereel/pipeline/contracts";
import { BACKGROUND_MUSIC } from "@bytereel/pipeline/pipeline/music";
import { THUMBNAIL_SECONDS, type RenderJobResult, type RenderJobSpec, type RenderPhase } from "@bytereel/pipeline/pipeline/render-protocol";
import { cacheRecordFor, countCharacters, speechCacheKey, speechRequestFor, SpeechBudgetError, type SpeechConfig } from "@bytereel/pipeline/pipeline/speech";
import { ProviderError, type SpeechCallOptions, type SpeechResponse } from "@bytereel/pipeline/providers";
import { SpeechCacheRecordSchema } from "@bytereel/pipeline/storage";
import { StorageError, StorageKeys, type ObjectInfo, type StorageKey, type StoredObject } from "@bytereel/storage";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { ensureProjectTmp, isInside, type RenderRun } from "./render-process";
import { voiceEstimatorFor, VoiceNotConfiguredError, type VoiceSetup } from "./voice";

// The video job (Inngest function `generate-video`, F23; PRD §11.2, ARCHITECTURE §13–§15), kept
// free of Inngest and of the real database so tests run it with fakes (inngest/functions/
// generate-video.ts passes the real ones). Durable steps:
//   start            the job becomes running; language and approval re-checked; R2 bucket checked
//                    (a wrong bucket/token/setting ends the job at once, before any cost)
//   reserve-voice    the voice characters of every recording still to make, reserved in ONE
//                    transaction (creator 3,000 + app 9,000 a month) BEFORE any ElevenLabs call
//   speech-1…N       one recording per scene, under the speech lock (speechArtifacts): ready → reused
//                    for free; held by another run → wait 60 s (step.sleep) and look again; else
//                    claimed, EVERY request counted right before it is sent (reserveVoiceSend) and
//                    logged in providerUsage, the answer AND its audio bytes saved in one write, then
//                    uploaded create-only (a few quick tries). A saved answer is never paid for again:
//                    a retry, a Try again or another job uploads the saved bytes. While a request is
//                    in flight the progress line is rewritten every 20 s (the stuck rule's heartbeat);
//                    an answer that arrives after the job ended is still saved (then the run stops).
//   render           a NEW renderId; narration downloaded and checked; the render child process does
//                    Timing animations → Adding captions → Rendering → Checking; results uploaded to
//                    R2 create-only; the video saved and the project made `video_ready`
// Cancel: every step starts by checking `cancelRequestedAt`; no ElevenLabs request (not even a
// provider retry) is sent after it (reserveVoiceSend refuses: the job ends as cancelled); a request
// already in flight finishes and its paid answer is kept; during the render the worker checks it
// every few seconds and stops the renderer. Characters already spent stay counted.
// Try again (E2) runs the same steps: recordings made before are reused, never paid again.
// What the creator sees is always a fixed plain line; provider text and stack traces go to the log.

/** One job step: Inngest's step.run in production, a plain call in tests. */
export interface StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  /** Wait between steps without holding the video queue or using up a step's retries (Inngest step.sleep). */
  sleep(id: string, ms: number): Promise<void>;
}

/** What the worker needs from the database (packages/db/src/generate-jobs.ts, speech-artifacts.ts, provider-usage.ts). */
export interface GenerateJobStore {
  start(input: { jobId: string; attempt: number; runId: string | null }): Promise<GenerateJobContext | null>;
  load(input: { jobId: string; attempt: number }): Promise<GenerateJobContext | null>;
  timezone(ownerId: ObjectId): Promise<string>;
  readySpeech(ownerId: ObjectId, cacheKeys: readonly string[]): Promise<SpeechArtifactDocument[]>;
  /** Keys that cost nothing more: ready, or with a saved paid answer and its bytes. */
  paidSpeechKeys(ownerId: ObjectId, cacheKeys: readonly string[]): Promise<string[]>;
  reserveVoice(input: { jobId: ObjectId; attempt: number; items: readonly VoiceScene[]; timezone: string }): Promise<VoiceReservation>;
  /** Right before EVERY ElevenLabs request: use the recording's credit or count the request now. */
  reserveVoiceSend(input: { jobId: ObjectId; attempt: number; item: VoiceScene; timezone: string }): Promise<VoiceReservation>;
  /** providerUsage: the `reserved` row written before a request; finished after it. */
  reserveUsage(input: { ownerId: string; projectId: string; jobId: string; model: string; characters: number }): Promise<unknown>;
  finishUsage(handle: unknown, input: { status: "final" | "failed"; outcome: string; model: string; characters: number; latencyMs: number }): Promise<void>;
  claimSpeech(input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; setup: SpeechSetup }): Promise<SpeechClaim>;
  /** "held": go on and upload; "released": the job ended mid-request, the answer is kept for the next try; null: not saved. */
  saveSpeechResponse(input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; response: SpeechRecordDoc; audio: Uint8Array; durationMs: number | null }): Promise<SpeechSaveTarget | null>;
  markSpeechReady(input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number }): Promise<boolean>;
  markSpeechFailed(input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; message: string }): Promise<void>;
  progress(input: { jobId: ObjectId; attempt: number; stage: GenerateStage; percent: number; message: string; stages?: Partial<Record<GenerateStage, "running" | "succeeded">> }): Promise<{ cancelRequested: boolean } | null>;
  beginRender(input: { jobId: ObjectId; attempt: number; renderId: ObjectId }): Promise<{ cancelRequested: boolean } | null>;
  complete(input: { jobId: ObjectId; attempt: number; render: RenderToSave }): Promise<boolean>;
  end(input: { jobId: ObjectId; attempt: number; outcome: "failed" | "needs_input" | "cancelled"; code?: GenerateErrorCode; stage?: GenerateStage; detail?: string; needsInput?: JobNeedsInput }): Promise<boolean>;
}

/** The R2 store's methods the worker uses (R2ArtifactStore). */
export interface FileStore {
  checkBucket(): Promise<void>;
  put(key: StorageKey, data: string | Uint8Array, options?: { createOnly?: boolean }): Promise<StoredObject>;
  get(key: StorageKey): Promise<Uint8Array | null>;
  head(key: StorageKey): Promise<ObjectInfo | null>;
}

export interface GenerateJobDeps {
  store: GenerateJobStore;
  /** The R2 store (throws when R2 isn't set up). */
  files: () => FileStore;
  voice: () => VoiceSetup;
  /** Starts the render child process (render-process.ts startRenderProcess). */
  render: (spec: RenderJobSpec, options: { root: string; tmp: string; onProgress: (phase: RenderPhase, percent: number) => void }) => RenderRun;
  /** The repository root (work folders go in runs/.tmp/generate/<renderId>). */
  root: string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** How often the render step writes progress and checks Cancel (default 2 s). */
  heartbeatMs?: number;
  /** How often a recording in flight rewrites its progress line (default SPEECH_HEARTBEAT_MS). */
  speechHeartbeatMs?: number;
  /** Short in-process waits (save/upload tries, the provider's own quick retries). Tests: no real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export type GenerateJobOutcome = "done" | "failed" | "needs_input" | "cancelled" | "skipped";
type StepResult = { status: "ok" } | { status: "ended"; outcome: GenerateJobOutcome } | { status: "stale" } | { status: "busy" };

/** A recording held by another run: look again after this long (step.sleep, no retry used up). */
export const SPEECH_BUSY_WAIT_MS = 60_000;
/** Enough waits to outlast an abandoned claim (SPEECH_LOCK_STALE_MS), then a little more. */
export const SPEECH_BUSY_MAX_WAITS = Math.ceil(SPEECH_LOCK_STALE_MS / SPEECH_BUSY_WAIT_MS) + 2;
/**
 * While an ElevenLabs request is in flight, the scene's progress line is written again this often
 * (same text), so the job's `updatedAt` stays fresh and the stuck rule's 60-second Cancel grace
 * (GENERATE_CANCEL_GRACE_MS) never ends a worker that is still waiting for a paid answer.
 */
export const SPEECH_HEARTBEAT_MS = 20_000;

/** Saving a paid answer, and each upload, is tried this many times in-process before the step fails. */
const SAVE_TRIES = 3;
const SAVE_RETRY_WAIT_MS = 500;
const UPLOAD_TRIES = 3;
const UPLOAD_RETRY_WAIT_MS = 1000;

/** A render's work folder this old was left by a render that never finished (the server restarted). */
export const OLD_WORK_FOLDER_MS = 6 * 60 * 60_000;

/** Remove work folders of renders that never finished (older than 6 h); never the current one. */
async function removeOldWorkFolders(parent: string, current: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === current || !/^[0-9a-f]{24}$/.test(entry.name)) continue;
    const folder = path.join(parent, entry.name);
    const info = await stat(folder).catch(() => null);
    if (info && Date.now() - info.mtimeMs > OLD_WORK_FOLDER_MS) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

const sha256 = (data: Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** Upload a finished file create-only; an existing file with the SAME bytes (an earlier run of this step) is fine. */
async function putOnce(files: FileStore, key: StorageKey, data: Uint8Array | string): Promise<StoredObject> {
  const bytes = typeof data === "string" ? new Uint8Array(Buffer.from(data, "utf8")) : data;
  try {
    return await files.put(key, bytes, { createOnly: true });
  } catch (error) {
    if (!(error instanceof StorageError) || error.code !== "already_exists") throw error;
    const existing = await files.head(key);
    const mine = sha256(bytes);
    if (existing?.sha256 === mine) return { key, sha256: mine, bytes: bytes.byteLength };
    throw new Error(`${key.split("/").pop()} already exists in storage with different content`);
  }
}

/** R2 refused (wrong token permissions, missing bucket): trying again can't help, the job ends at once. */
class StorageRefused extends Error {}
const isRefusal = (error: unknown) => error instanceof StorageError && (error.code === "access_denied" || error.code === "bucket_not_found");

/** The job no longer runs this attempt (ended elsewhere), or Cancel was pressed (`cancelled`): stop without sending anything. */
class JobStopped extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
  ) {
    super(message);
  }
}

/** A provider retry would pass a monthly voice limit (it is not sent). */
export class VoiceLimitDuringRecording extends SpeechBudgetError {
  constructor(readonly code: "QUOTA_EXCEEDED" | "SPEND_CEILING") {
    super(code === "QUOTA_EXCEEDED" ? "the creator's monthly voice characters are used up" : "the app's monthly voice characters are used up");
  }
}

/**
 * Which error a provider failure becomes (API.md §4.2): busy or a broken answer → retryable
 * PROVIDER_BUSY; ElevenLabs' own monthly limit → the retryable "Voice limit reached this month."
 * (SPEND_CEILING; a long rate-limit wait the retry helper turned into "quota" is just busy);
 * account, key and voice problems → PROVIDER_UNAVAILABLE (not retryable: edit the storyboard).
 */
export function speechFailureCode(error: unknown): GenerateErrorCode {
  if (error instanceof VoiceLimitDuringRecording) return error.code;
  if (error instanceof ProviderError) {
    if (error.kind === "transient" || error.kind === "bad-response") return "PROVIDER_BUSY";
    if (error.kind === "quota") return error.status === 429 || (error.status ?? 0) >= 500 ? "PROVIDER_BUSY" : "SPEND_CEILING";
    return "PROVIDER_UNAVAILABLE";
  }
  if (error instanceof VoiceNotConfiguredError) return "PROVIDER_UNAVAILABLE";
  return "INTERNAL";
}

/** The fixed line stored with a failed recording (the provider's own text goes to the server log only). */
const SPEECH_FAILURE_LINE: Partial<Record<GenerateErrorCode, string>> = {
  PROVIDER_BUSY: "the voice service was busy or its answer was unusable",
  PROVIDER_UNAVAILABLE: "the voice service refused the request (see the server log)",
  QUOTA_EXCEEDED: "the creator's monthly voice characters are used up",
  SPEND_CEILING: "the monthly voice characters are used up",
};

/** The fixed line stored when the render step fails (the renderer's own text goes to the server log only). */
const RENDER_FAILURE_LINE: Record<"compile" | "render" | "validate", string> = {
  compile: "Preparing the video failed (see the server log)",
  render: "The render stopped with an error (see the server log)",
  validate: "The finished video didn't pass its checks (see the server log)",
};

/** How a failed ElevenLabs request is logged in providerUsage. */
function usageOutcomeOf(error: unknown): string {
  if (!(error instanceof ProviderError)) return "error";
  if (error.kind === "transient") return /timeout|timed out|abort/i.test(error.message) ? "timeout" : "busy";
  if (error.kind === "bad-response") return "invalid_output";
  if (error.kind === "quota") return "quota";
  return "error";
}

/** A failed request ElevenLabs may still have billed (it did the work): a broken answer or a timeout. */
const mayHaveBilled = (error: unknown) => ["invalid_output", "timeout"].includes(usageOutcomeOf(error));

/** Progress shown for each render phase (UI mapping: API.md §8.2). */
export function renderPhaseProgress(phase: RenderPhase, percent: number): { stage: GenerateStage; percent: number; message: string; stages?: Partial<Record<GenerateStage, "running" | "succeeded">> } {
  switch (phase) {
    case "timing":
      return { stage: "compile", percent: 40 + percent * 0.05, message: GENERATE_MESSAGES.TIMING };
    case "captions":
      return { stage: "compile", percent: 47 + percent * 0.03, message: GENERATE_MESSAGES.CAPTIONS };
    case "rendering":
      return { stage: "render", percent: 50 + percent * 0.45, message: renderingMessage(percent), stages: { compile: "succeeded", render: "running" } };
    case "checking":
      return { stage: "validate", percent: 96, message: GENERATE_MESSAGES.CHECKING, stages: { render: "succeeded", validate: "running" } };
  }
}

export async function runGenerateJob(input: { event: { jobId: string; attempt: number }; runId: string | null; step: StepRunner }, deps: GenerateJobDeps): Promise<GenerateJobOutcome> {
  const { event, step } = input;
  const { store } = deps;
  const log = deps.log ?? ((level, message) => console[level](message));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!/^[0-9a-f]{24}$/.test(event.jobId)) return "skipped";
  const jobId = new ObjectId(event.jobId);
  const attempt = event.attempt;

  const end = async (outcome: "failed" | "needs_input" | "cancelled", extra: { code?: GenerateErrorCode; stage?: GenerateStage; detail?: string; needsInput?: JobNeedsInput } = {}): Promise<StepResult> => {
    const ended = await store.end({ jobId, attempt, outcome, ...extra });
    return ended ? { status: "ended", outcome } : { status: "stale" };
  };

  /** The job, still running this attempt; ends it when Cancel was pressed. */
  const loadOrStop = async (): Promise<GenerateJobContext | StepResult> => {
    const ctx = await store.load({ jobId: event.jobId, attempt });
    if (!ctx) return { status: "stale" };
    if (ctx.job.cancelRequestedAt) return end("cancelled");
    return ctx;
  };
  const isCtx = (value: GenerateJobContext | StepResult): value is GenerateJobContext => "job" in value;

  /** The voice settings for this plan, or the job ends as "Voice service unavailable". */
  const voiceFor = async (plan: Plan): Promise<{ setup: Extract<VoiceSetup, { ok: true }>; config: SpeechConfig } | StepResult> => {
    const setup = deps.voice();
    if (!setup.ok) {
      log("error", `Video job ${event.jobId}: the voice is not set up: ${setup.problem}`);
      return end("failed", { code: "PROVIDER_UNAVAILABLE", stage: "speech", detail: "Voice not set up (see the server log)" });
    }
    try {
      return { setup, config: setup.configFor(plan) };
    } catch (error) {
      log("error", `Video job ${event.jobId}: ${error instanceof Error ? error.message : String(error)}`);
      return end("failed", { code: "PROVIDER_UNAVAILABLE", stage: "speech", detail: "Voice not set up (see the server log)" });
    }
  };

  /** A few quick in-process tries (a short network or database hiccup must not cost a new recording). */
  async function withTries<T>(what: string, tries: number, waitMs: number, fn: () => Promise<T>): Promise<T> {
    for (let tryNumber = 1; ; tryNumber++) {
      try {
        return await fn();
      } catch (error) {
        if (isRefusal(error)) throw new StorageRefused(error instanceof Error ? error.message : String(error));
        if (tryNumber >= tries) throw error;
        log("warn", `Video job ${event.jobId}: ${what} failed (try ${tryNumber} of ${tries}), trying again: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(waitMs * tryNumber);
      }
    }
  }
  const upload = (files: FileStore, key: StorageKey, data: Uint8Array | string) => withTries(`uploading ${key.split("/").pop()}`, UPLOAD_TRIES, UPLOAD_RETRY_WAIT_MS, () => putOnce(files, key, data));

  /** R2 refused: the job ends now (Try again later uploads the saved narration, never paying again). */
  const storageRefused = (error: unknown, stage?: GenerateStage): Promise<StepResult> => {
    log("error", `Video job ${event.jobId}: file storage refused the request: ${error instanceof Error ? error.message : String(error)}`);
    return end("failed", { code: "INTERNAL", ...(stage ? { stage } : {}), detail: "File storage refused the request (see the server log)" });
  };
  const refused = (error: unknown) => error instanceof StorageRefused || isRefusal(error);

  const outcomeOf = (result: StepResult): GenerateJobOutcome | null => (result.status === "ok" || result.status === "busy" ? null : result.status === "ended" ? result.outcome : "skipped");

  try {
    // ---------- start: running; a wrong bucket, token or R2 setting ends the job before any cost ----------
    const started = await step.run("start", async (): Promise<{ ok: true; scenes: number } | { ok: false; outcome: GenerateJobOutcome }> => {
      const ctx = await store.start({ jobId: event.jobId, attempt, runId: input.runId });
      if (!ctx) return { ok: false, outcome: "skipped" };
      let files: FileStore;
      try {
        files = deps.files();
      } catch (error) {
        log("error", `Video job ${event.jobId}: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, outcome: outcomeOf(await end("failed", { code: "INTERNAL", detail: "File storage isn't set up (see the server log)" })) ?? "failed" };
      }
      try {
        await files.checkBucket();
      } catch (error) {
        // A network problem is thrown: the step tries again (then the job fails as INTERNAL below).
        if (!isRefusal(error)) throw error;
        return { ok: false, outcome: outcomeOf(await storageRefused(error)) ?? "failed" };
      }
      return { ok: true, scenes: (ctx.version.plan as unknown as Plan).scenes.length };
    });
    if (!started.ok) return started.outcome;

    // ---------- reserve the voice characters (all recordings still to make) ----------
    const reserved = await step.run("reserve-voice", async (): Promise<StepResult> => {
      const ctx = await loadOrStop();
      if (!isCtx(ctx)) return ctx;
      const plan = ctx.version.plan as unknown as Plan;
      const voice = await voiceFor(plan);
      if (!("setup" in voice)) return voice;
      const scenes = voiceEstimatorFor(voice.setup)(ctx.version.plan);
      // Ready recordings and saved paid answers (only the upload is left) cost nothing more.
      const free = new Set(await store.paidSpeechKeys(ctx.job.ownerId, scenes.map((s) => s.cacheKey)));
      const items = [...new Map(scenes.filter((s) => !free.has(s.cacheKey)).map((s) => [s.cacheKey, s])).values()];
      const outcome = await store.reserveVoice({ jobId, attempt, items, timezone: await store.timezone(ctx.job.ownerId) });
      if (outcome === "quota") return end("failed", { code: "QUOTA_EXCEEDED", stage: "speech", detail: "The creator's monthly voice characters are used up" });
      if (outcome === "ceiling") return end("failed", { code: "SPEND_CEILING", stage: "speech", detail: "The app's monthly voice characters are used up" });
      if (outcome === "stale") return { status: "stale" };
      if (outcome === "cancelled") return end("cancelled");
      return { status: "ok" };
    });
    const stopReserve = outcomeOf(reserved);
    if (stopReserve) return stopReserve;

    // ---------- one recording per scene (a recording held by another run: wait, look again) ----------
    for (let index = 0; index < started.scenes; index++) {
      const n = index + 1;
      for (let wait = 0; ; wait++) {
        const recorded = await step.run(wait === 0 ? `speech-${n}` : `speech-${n}-again-${wait}`, () => recordScene(index));
        if (recorded.status !== "busy") {
          const stop = outcomeOf(recorded);
          if (stop) return stop;
          break;
        }
        if (wait >= SPEECH_BUSY_MAX_WAITS) {
          log("warn", `Video job ${event.jobId}: scene ${n}'s narration stayed locked by another run for ${wait} minutes`);
          const failed = await step.run(`speech-${n}-gave-up`, () => end("failed", { code: "PROVIDER_BUSY", stage: "speech", detail: `Scene ${n}: still being recorded by another video` }));
          return outcomeOf(failed) ?? "failed";
        }
        await step.sleep(`speech-${n}-wait-${wait + 1}`, SPEECH_BUSY_WAIT_MS);
      }
    }

    // ---------- render, check, upload, save ----------
    const rendered = await step.run("render", renderVideo);
    return outcomeOf(rendered) ?? "done";
  } catch (error) {
    // A step failed for good (its retries are used up) or something unexpected broke: the job
    // fails with a retryable error instead of waiting forever (its speech claims are released).
    log("error", `Video job ${event.jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
    const failed = await step.run("fail-internal", () => end("failed", { code: "INTERNAL", detail: "Unexpected error (see the server log)" }));
    return outcomeOf(failed) ?? "failed";
  }

  async function recordScene(index: number): Promise<StepResult> {
    const ctx = await loadOrStop();
    if (!isCtx(ctx)) return ctx;
    const plan = ctx.version.plan as unknown as Plan;
    const scene = plan.scenes[index];
    if (!scene) return { status: "ok" };
    const voice = await voiceFor(plan);
    if (!("setup" in voice)) return voice;
    const { setup, config } = voice;
    const ownerId = ctx.job.ownerId;
    const n = index + 1;
    const cacheKey = speechCacheKey(scene, config);
    const keys = {
      audio: StorageKeys.speechAudio(ownerId.toHexString(), cacheKey),
      alignment: StorageKeys.speechAlignment(ownerId.toHexString(), cacheKey),
      normalized: StorageKeys.speechNormalizedAlignment(ownerId.toHexString(), cacheKey),
    };
    const request = speechRequestFor(plan, index, config);
    const characters = countCharacters(request.text);
    const sceneLine = { stage: "speech" as const, percent: 5 + (30 * index) / plan.scenes.length, message: recordingMessage(n, plan.scenes.length) };
    if ((await store.progress({ jobId, attempt, ...sceneLine })) === null) return { status: "stale" };

    // The speech lock: claimed BEFORE any call; ready → reused; held by another run → wait.
    const claim = await store.claimSpeech({
      ownerId,
      cacheKey,
      jobId,
      attempt,
      setup: { sceneId: scene.id, firstProjectId: ctx.project._id, voiceId: config.voiceId, model: config.modelId, settings: { ...config.settings }, audioKey: keys.audio, alignmentKey: keys.alignment, normalizedAlignmentKey: keys.normalized, characters },
    });
    if (claim.kind === "ready") return { status: "ok" };
    if (claim.kind === "busy") return { status: "busy" };

    const lock = { ownerId, cacheKey, jobId, attempt };
    const projectId = ctx.project._id.toHexString();
    // A paid answer saved on the document is never paid for again (here, in a retry or in another job).
    let paidAnswerKept = Boolean(claim.doc.response);
    try {
      const files = deps.files();
      let record = claim.doc.response;
      let audio = record ? savedAudioOf(claim.doc) : null;
      if (record) {
        const head = await files.head(keys.audio);
        if (head && head.sha256 !== record.audioSha256) {
          log("error", `Video job ${event.jobId}, scene ${n}: the stored audio doesn't match the saved answer (${keys.audio})`);
          await store.markSpeechFailed({ ...lock, message: "The stored audio doesn't match the saved answer" });
          return end("failed", { code: "INTERNAL", stage: "speech", detail: `Scene ${n}: the stored narration doesn't match (see the server log)` });
        }
        if (head) audio = null; // the audio is in R2 already: only the timing files may be missing
        else if (!audio) {
          // An answer saved without its bytes and no audio in R2: it must be recorded again (counted).
          record = null;
          paidAnswerKept = false;
        }
      }
      if (!record) {
        const fresh = await recordNew();
        if ("status" in fresh) return fresh;
        record = fresh.record;
        audio = fresh.audio;
        paidAnswerKept = true;
      }
      if (audio) {
        if (sha256(audio) !== record.audioSha256) throw new Error(`Scene ${n}: the saved audio doesn't match its answer`);
        await upload(files, keys.audio, audio);
      }
      // The timing files come from the saved answer (the same request as the audio).
      const parsed = SpeechCacheRecordSchema.parse(record);
      await upload(files, keys.alignment, `${JSON.stringify(parsed, null, 2)}\n`);
      await upload(files, keys.normalized, `${JSON.stringify({ schemaVersion: 1, cacheKey, audioSha256: parsed.audioSha256, normalizedAlignment: parsed.normalizedAlignment }, null, 2)}\n`);
      if (!(await store.markSpeechReady(lock))) throw new Error(`Scene ${n}: couldn't mark the narration ready`);
      return { status: "ok" };
    } catch (error) {
      if (refused(error)) return storageRefused(error, "speech");
      if (error instanceof JobStopped) {
        await store.markSpeechFailed({ ...lock, message: "The video job stopped before recording" }).catch(() => undefined);
        return error.cancelled ? end("cancelled") : { status: "stale" };
      }
      // Nothing paid is kept: free the lock now, so the step's retry doesn't wait for it to go stale.
      if (!paidAnswerKept) await store.markSpeechFailed({ ...lock, message: "The recording stopped with an error" }).catch(() => undefined);
      throw error;
    }

    /** A new paid recording: every request counted and logged BEFORE it is sent; the answer + bytes saved at once. */
    async function recordNew(): Promise<{ record: SpeechRecordDoc; audio: Uint8Array } | StepResult> {
      const timezone = await store.timezone(ownerId);
      const model = config.modelId;
      let usage: unknown = null;
      let sentAt = 0;
      const finishUsage = async (status: "final" | "failed", outcome: string, billed: number) => {
        if (usage === null) return;
        const handle = usage;
        usage = null;
        try {
          await store.finishUsage(handle, { status, outcome, model, characters: billed, latencyMs: Date.now() - sentAt });
        } catch (error) {
          log("error", `Video job ${event.jobId}: usage log failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      /** The error the provider is retrying: the previous request is logged with it. */
      let retried: unknown = null;
      const options: SpeechCallOptions = {
        beforeAttempt: async (requestNumber) => {
          // A retry: the previous request ended with the error the provider retried (busy, network, timeout).
          if (requestNumber > 1) await finishUsage("failed", usageOutcomeOf(retried), mayHaveBilled(retried) ? characters : 0);
          const counted = await store.reserveVoiceSend({ jobId, attempt, item: { cacheKey, characters }, timezone });
          if (counted === "quota") throw new VoiceLimitDuringRecording("QUOTA_EXCEEDED");
          if (counted === "ceiling") throw new VoiceLimitDuringRecording("SPEND_CEILING");
          if (counted === "stale") throw new JobStopped("the job no longer runs this attempt");
          if (counted === "cancelled") throw new JobStopped("Cancel was pressed: nothing more is sent", true);
          usage = await store.reserveUsage({ ownerId: ownerId.toHexString(), projectId, jobId: event.jobId, model, characters });
          sentAt = Date.now();
        },
        retry: { ...(deps.sleep ? { sleep: deps.sleep } : {}), onRetry: ({ error }) => void (retried = error) },
      };
      /** While the request is in flight (retries included), the same progress line is written every 20 s: the stuck rule never ends a live worker waiting for a paid answer. */
      const synthesize = async () => {
        const heartbeat = setInterval(
          () => void store.progress({ jobId, attempt, ...sceneLine }).catch((e: unknown) => log("warn", `Video job ${event.jobId}: progress not saved: ${String(e)}`)),
          deps.speechHeartbeatMs ?? SPEECH_HEARTBEAT_MS,
        );
        try {
          return await setup.provider(plan.language).synthesize(request, options);
        } finally {
          clearInterval(heartbeat);
        }
      };
      let response: SpeechResponse;
      try {
        response = await synthesize();
      } catch (error) {
        // A broken answer (bad JSON, bad timings) or a timeout may have been billed: logged with its characters.
        await finishUsage("failed", usageOutcomeOf(error), mayHaveBilled(error) ? characters : 0);
        const code = speechFailureCode(error);
        if (code === "INTERNAL") throw error;
        const line = SPEECH_FAILURE_LINE[code] ?? "the recording failed";
        log(code === "PROVIDER_UNAVAILABLE" ? "error" : "warn", `Video job ${event.jobId}, scene ${n}: ${error instanceof Error ? error.message : String(error)}`);
        await store.markSpeechFailed({ ...lock, message: line });
        return end("failed", { code, stage: "speech", detail: `Scene ${n}: ${line}` });
      }
      const cached = cacheRecordFor(cacheKey, request, response, new Date());
      const ends = cached.alignment?.character_end_times_seconds ?? [];
      const durationMs = ends.length ? Math.round(ends[ends.length - 1]! * 1000) : null;
      const fresh = cached as unknown as SpeechRecordDoc;
      // The answer AND the paid bytes in ONE write, BEFORE any upload (a few quick tries). The usage
      // row comes after it: nothing (a slow or failing usage write) stands between paying and saving.
      let saved: SpeechSaveTarget | null;
      try {
        saved = await withTries(`saving scene ${n}'s answer`, SAVE_TRIES, SAVE_RETRY_WAIT_MS, () => store.saveSpeechResponse({ ...lock, response: fresh, audio: response.audio, durationMs }));
      } finally {
        await finishUsage("final", "ok", response.characterCost ?? characters);
      }
      if (saved === "released") {
        // The job ended while ElevenLabs was answering: the answer is kept on the released recording;
        // the next try uploads it (no second payment). This run stops here.
        log("warn", `Video job ${event.jobId}, scene ${n}: the job ended while the voice was answering; the paid answer is kept for the next try`);
        return { status: "stale" };
      }
      if (saved !== "held") throw new Error(`Scene ${n}: lost the recording lock while saving`);
      return { record: fresh, audio: response.audio };
    }
  }

  async function renderVideo(): Promise<StepResult> {
    const ctx = await loadOrStop();
    if (!isCtx(ctx)) return ctx;
    const plan = ctx.version.plan as unknown as Plan;
    const voice = await voiceFor(plan);
    if (!("setup" in voice)) return voice;
    const { config } = voice;
    const ownerId = ctx.job.ownerId;
    const owner = ownerId.toHexString();
    const renderId = new ObjectId(); // a NEW folder for every render attempt (never reused)
    const begun = await store.beginRender({ jobId, attempt, renderId });
    if (!begun) return { status: "stale" };
    if (begun.cancelRequested) return end("cancelled");

    // F22b MUST: the process temp folder must be inside the project before the first render.
    const { tmp: processTmp, changed } = ensureProjectTmp(deps.root);
    if (changed) log("warn", `Video job ${event.jobId}: TMPDIR was outside the project; set to ${path.relative(deps.root, processTmp)}`);
    const workDir = path.join(deps.root, "runs", ".tmp", "generate", renderId.toHexString());
    if (!isInside(deps.root, workDir)) throw new Error("the render work folder must be inside the project");
    // The render process gets its OWN temp folder inside the work folder: Remotion and Chrome put
    // their work there (and leave it behind after a cancel), so removing the work folder cleans all.
    const tmp = path.join(workDir, "tmp");
    await mkdir(tmp, { recursive: true });
    await removeOldWorkFolders(path.dirname(workDir), renderId.toHexString());
    const files = deps.files();
    try {
      // The narration, checked against the SHA-256 saved when it was recorded.
      await mkdir(path.join(workDir, "narration"), { recursive: true });
      const keys = plan.scenes.map((scene) => speechCacheKey(scene, config));
      const recordings = new Map((await store.readySpeech(ownerId, keys)).map((d) => [d.cacheKey, d]));
      const scenes: RenderJobSpec["scenes"] = [];
      const speech: RenderToSave["speech"] = [];
      for (const [index, scene] of plan.scenes.entries()) {
        const doc = recordings.get(keys[index]!);
        if (!doc?.audioSha256) throw new Error(`Scene ${index + 1}: narration is not recorded`);
        const audio = await files.get(doc.audioKey as StorageKey);
        if (!audio || sha256(audio) !== doc.audioSha256) throw new Error(`Scene ${index + 1}: narration file is missing or changed`);
        const json = await files.get(doc.alignmentKey as StorageKey);
        const record = json ? SpeechCacheRecordSchema.parse(JSON.parse(Buffer.from(json).toString("utf8"))) : null;
        if (!record || record.audioSha256 !== doc.audioSha256) throw new Error(`Scene ${index + 1}: narration timing file is missing or doesn't match the audio`);
        const audioFile = path.join(workDir, "narration", `${scene.id}.mp3`);
        await writeFile(audioFile, audio);
        scenes.push({ sceneId: scene.id, audioFile, record });
        speech.push({ sceneId: scene.id, speechArtifactId: doc._id });
      }

      // Render in the child process; progress is written at most every heartbeat, and Cancel checked.
      // Stage statuses are written only when the stage changes (not on every percent).
      let latest: { phase: RenderPhase; percent: number } = { phase: "timing", percent: 0 };
      let lastStage = "";
      let run: RenderRun | null = null;
      let stopping = false;
      const write = async () => {
        const update = renderPhaseProgress(latest.phase, latest.percent);
        const result = await store.progress({ jobId, attempt, ...update, ...(update.stage === lastStage ? { stages: {} } : {}) });
        lastStage = update.stage;
        if ((result === null || result.cancelRequested) && !stopping) {
          stopping = true;
          run?.cancel();
        }
      };
      const heartbeat = setInterval(() => void write().catch((e: unknown) => log("warn", `Video job ${event.jobId}: progress not saved: ${String(e)}`)), deps.heartbeatMs ?? 2000);
      let result: RenderJobResult;
      try {
        run = deps.render(
          { workDir, plan, planHash: ctx.version.planHash, speechConfig: config, scenes, music: BACKGROUND_MUSIC, thumbnailSeconds: THUMBNAIL_SECONDS },
          {
            root: deps.root,
            tmp,
            onProgress: (phase, percent) => {
              const phaseChanged = phase !== latest.phase;
              latest = { phase, percent };
              if (phaseChanged) void write().catch(() => undefined);
            },
          },
        );
        // Resolves once the render process is gone (finished, failed, cancelled or killed).
        result = await run.result;
      } finally {
        clearInterval(heartbeat);
      }

      if (result.status === "cancelled" || stopping) return end("cancelled");
      if (result.status === "needs_input") {
        log("info", `Video job ${event.jobId}: needs a storyboard change: ${result.detail}`);
        return end("needs_input", { stage: "compile", needsInput: { reason: result.reason, message: result.message, sceneId: result.sceneId } });
      }
      if (result.status === "failed") {
        log("error", `Video job ${event.jobId}: ${result.stage} failed: ${result.detail}`);
        return end("failed", { code: result.stage === "compile" ? "INTERNAL" : "RENDER_FAILED", stage: result.stage, detail: RENDER_FAILURE_LINE[result.stage] });
      }

      // Upload the finished files create-only (a new renderId, so nothing can be overwritten).
      await store.progress({ jobId, attempt, stage: "validate", percent: 98, message: GENERATE_MESSAGES.SAVING });
      const ref = { ownerId: owner, projectId: ctx.project._id.toHexString(), renderId: renderId.toHexString() };
      const mp4 = await upload(files, StorageKeys.renderOutput(ref), new Uint8Array(await readFile(result.files.video)));
      if (mp4.sha256 !== result.qa.sha256) throw new Error("the uploaded video doesn't match the checked one");
      const thumbnail = await upload(files, StorageKeys.renderThumbnail(ref), new Uint8Array(await readFile(result.files.thumbnail)));
      const timeline = await upload(files, StorageKeys.renderTimeline(ref), new Uint8Array(await readFile(result.files.timeline)));
      const captions = await upload(files, StorageKeys.renderCaptions(ref), new Uint8Array(await readFile(result.files.captions)));
      const qa = await upload(files, StorageKeys.renderQa(ref), new Uint8Array(await readFile(result.files.qa)));
      const saved = await store.complete({
        jobId,
        attempt,
        render: {
          renderId,
          speech,
          keys: { timeline: timeline.key, captions: captions.key, mp4: mp4.key, thumbnail: thumbnail.key, qa: qa.key },
          mp4Sha256: mp4.sha256,
          qa: result.qa as unknown as Record<string, unknown>,
          metrics: { renderMs: result.renderMs, bundleMs: result.bundleMs, bytes: mp4.bytes, durationMs: result.durationMs, frames: result.frames },
          cacheKeys: keys,
          music: BACKGROUND_MUSIC,
        },
      });
      return saved ? { status: "ended", outcome: "done" } : { status: "stale" };
    } catch (error) {
      if (refused(error)) return storageRefused(error);
      throw error;
    } finally {
      // The work folder goes after success or failure; the uploaded files stay in R2.
      await rm(workDir, { recursive: true, force: true }).catch((e: unknown) => log("warn", `Video job ${event.jobId}: couldn't remove its work folder: ${String(e)}`));
    }
  }
}
