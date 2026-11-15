import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GENERATE_MESSAGES,
  recordingMessage,
  renderingMessage,
  type GenerateErrorCode,
  type GenerateJobContext,
  type GenerateStage,
  type JobNeedsInput,
  type RenderToSave,
  type SpeechArtifactDocument,
  type SpeechClaim,
  type SpeechRecordDoc,
  type SpeechSetup,
  type VoiceScene,
} from "@bytereel/db";
import type { Plan } from "@bytereel/pipeline/contracts";
import { BACKGROUND_MUSIC } from "@bytereel/pipeline/pipeline/music";
import { THUMBNAIL_SECONDS, type RenderJobResult, type RenderJobSpec, type RenderPhase } from "@bytereel/pipeline/pipeline/render-protocol";
import { cacheRecordFor, countCharacters, speechCacheKey, speechRequestFor, SpeechBudgetError, type SpeechConfig } from "@bytereel/pipeline/pipeline/speech";
import { ProviderError } from "@bytereel/pipeline/providers";
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
//   reserve-voice    the voice characters of every recording still to make, reserved in ONE
//                    transaction (creator 3,000 + app 9,000 a month) BEFORE any ElevenLabs call
//   speech-1…N       one recording per scene, under the speech lock (speechArtifacts): ready → reused
//                    for free; else claimed, recorded, its answer saved, files uploaded create-only
//   render           a NEW renderId; narration downloaded and checked; the render child process does
//                    Timing animations → Adding captions → Rendering → Checking; results uploaded to
//                    R2 create-only; the video saved and the project made `video_ready`
// Cancel: every step starts by checking `cancelRequestedAt`; during the render the worker checks it
// every few seconds and stops the renderer. Characters already spent stay counted.
// Try again (E2) runs the same steps: recordings made before are reused, never paid again.

/** One job step: Inngest's step.run in production, a plain call in tests. */
export interface StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/** What the worker needs from the database (packages/db/src/generate-jobs.ts, speech-artifacts.ts). */
export interface GenerateJobStore {
  start(input: { jobId: string; attempt: number; runId: string | null }): Promise<GenerateJobContext | null>;
  load(input: { jobId: string; attempt: number }): Promise<GenerateJobContext | null>;
  timezone(ownerId: ObjectId): Promise<string>;
  readySpeech(ownerId: ObjectId, cacheKeys: readonly string[]): Promise<SpeechArtifactDocument[]>;
  reserveVoice(input: { jobId: ObjectId; attempt: number; items: readonly VoiceScene[]; timezone: string; extra?: boolean }): Promise<"ok" | "quota" | "ceiling" | "stale">;
  claimSpeech(input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; setup: SpeechSetup }): Promise<SpeechClaim>;
  saveSpeechResponse(input: { ownerId: ObjectId; cacheKey: string; jobId: ObjectId; attempt: number; response: SpeechRecordDoc; durationMs: number | null }): Promise<boolean>;
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
  /** Thrown inside a step to try it again after `waitMs` (Inngest RetryAfterError). */
  retryLater: (message: string, waitMs: number) => Error;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** How often the render step writes progress and checks Cancel (default 2 s). */
  heartbeatMs?: number;
}

export type GenerateJobOutcome = "done" | "failed" | "needs_input" | "cancelled" | "skipped";
type StepResult = { status: "ok" } | { status: "ended"; outcome: GenerateJobOutcome } | { status: "stale" };

/** A recording held by another job: try this step again after this long. */
export const SPEECH_BUSY_WAIT_MS = 60_000;

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

/** A provider retry would pass a monthly voice limit (it is not sent). */
export class VoiceLimitDuringRecording extends SpeechBudgetError {
  constructor(readonly code: "QUOTA_EXCEEDED" | "SPEND_CEILING") {
    super(code === "QUOTA_EXCEEDED" ? "the creator's monthly voice characters are used up" : "the app's monthly voice characters are used up");
  }
}

/** Which error a provider failure becomes (API.md §4.2): busy → retryable; account/voice problems → not. */
export function speechFailureCode(error: unknown): GenerateErrorCode {
  if (error instanceof VoiceLimitDuringRecording) return error.code;
  if (error instanceof ProviderError) return error.kind === "transient" || error.kind === "bad-response" ? "PROVIDER_BUSY" : "PROVIDER_UNAVAILABLE";
  if (error instanceof VoiceNotConfiguredError) return "PROVIDER_UNAVAILABLE";
  return "INTERNAL";
}

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

  // ---------- start ----------
  const started = await step.run("start", async () => {
    const ctx = await store.start({ jobId: event.jobId, attempt, runId: input.runId });
    if (!ctx) return { ok: false as const, scenes: 0 };
    await deps.files().checkBucket(); // a wrong bucket or token fails loudly here, before any cost
    return { ok: true as const, scenes: (ctx.version.plan as unknown as Plan).scenes.length };
  });
  if (!started.ok) return "skipped";

  const outcomeOf = (result: StepResult): GenerateJobOutcome | null => (result.status === "ok" ? null : result.status === "ended" ? result.outcome : "skipped");

  try {
    // ---------- reserve the voice characters (all recordings still to make) ----------
    const reserved = await step.run("reserve-voice", async (): Promise<StepResult> => {
      const ctx = await loadOrStop();
      if (!isCtx(ctx)) return ctx;
      const plan = ctx.version.plan as unknown as Plan;
      const voice = await voiceFor(plan);
      if (!("setup" in voice)) return voice;
      const scenes = voiceEstimatorFor(voice.setup)(ctx.version.plan);
      const ready = new Set((await store.readySpeech(ctx.job.ownerId, scenes.map((s) => s.cacheKey))).map((d) => d.cacheKey));
      const items = [...new Map(scenes.filter((s) => !ready.has(s.cacheKey)).map((s) => [s.cacheKey, s])).values()];
      const outcome = await store.reserveVoice({ jobId, attempt, items, timezone: await store.timezone(ctx.job.ownerId) });
      if (outcome === "quota") return end("failed", { code: "QUOTA_EXCEEDED", stage: "speech", detail: "The creator's monthly voice characters are used up" });
      if (outcome === "ceiling") return end("failed", { code: "SPEND_CEILING", stage: "speech", detail: "The app's monthly voice characters are used up" });
      if (outcome === "stale") return { status: "stale" };
      return { status: "ok" };
    });
    const stopReserve = outcomeOf(reserved);
    if (stopReserve) return stopReserve;

    // ---------- one recording per scene ----------
    for (let index = 0; index < started.scenes; index++) {
      const recorded = await step.run(`speech-${index + 1}`, () => recordScene(index));
      const stop = outcomeOf(recorded);
      if (stop) return stop;
    }

    // ---------- render, check, upload, save ----------
    const rendered = await step.run("render", renderVideo);
    return outcomeOf(rendered) ?? "done";
  } catch (error) {
    // A step failed for good (its retries are used up) or something unexpected broke: the job
    // fails with a retryable error instead of waiting forever.
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
    const cacheKey = speechCacheKey(scene, config);
    const keys = {
      audio: StorageKeys.speechAudio(ownerId.toHexString(), cacheKey),
      alignment: StorageKeys.speechAlignment(ownerId.toHexString(), cacheKey),
      normalized: StorageKeys.speechNormalizedAlignment(ownerId.toHexString(), cacheKey),
    };
    const request = speechRequestFor(plan, index, config);
    const characters = countCharacters(request.text);
    if ((await store.progress({ jobId, attempt, stage: "speech", percent: 5 + (30 * index) / plan.scenes.length, message: recordingMessage(index + 1, plan.scenes.length) })) === null) return { status: "stale" };

    // The speech lock: claimed BEFORE any call; ready → reused; held by another job → later.
    const claim = await store.claimSpeech({
      ownerId,
      cacheKey,
      jobId,
      attempt,
      setup: { sceneId: scene.id, firstProjectId: ctx.project._id, voiceId: config.voiceId, model: config.modelId, settings: { ...config.settings }, audioKey: keys.audio, alignmentKey: keys.alignment, normalizedAlignmentKey: keys.normalized, characters },
    });
    if (claim.kind === "ready") return { status: "ok" };
    if (claim.kind === "busy") throw deps.retryLater(`Scene ${index + 1}'s narration is being recorded by another job`, SPEECH_BUSY_WAIT_MS);

    const files = deps.files();
    let record = claim.doc.response;
    let audio: Uint8Array | null = null;
    if (record) {
      // An earlier run of this job saved a paid answer: reuse it if its audio reached R2.
      const head = await files.head(keys.audio);
      if (head && head.sha256 !== record.audioSha256) {
        await store.markSpeechFailed({ ownerId, cacheKey, jobId, attempt, message: "stored audio doesn't match the saved answer" });
        return end("failed", { code: "INTERNAL", stage: "speech", detail: `Scene ${index + 1}: stored audio doesn't match the saved answer` });
      }
      if (!head) record = null; // the audio never reached R2: it has to be recorded again
    }
    if (!record) {
      const timezone = await store.timezone(ownerId);
      let response;
      try {
        response = await setup.provider(plan.language).synthesize(request, {
          // The first attempt was reserved by reserve-voice; a provider retry may be billed again,
          // so it is reserved too (and refused at the limit).
          beforeAttempt: async (n) => {
            if (n === 1) return;
            const extra = await store.reserveVoice({ jobId, attempt, items: [{ cacheKey, characters }], timezone, extra: true });
            if (extra === "quota") throw new VoiceLimitDuringRecording("QUOTA_EXCEEDED");
            if (extra === "ceiling") throw new VoiceLimitDuringRecording("SPEND_CEILING");
            if (extra === "stale") throw new Error("the job stopped while recording");
          },
        });
      } catch (error) {
        const code = speechFailureCode(error);
        const message = error instanceof Error ? error.message : String(error);
        await store.markSpeechFailed({ ownerId, cacheKey, jobId, attempt, message });
        if (code === "INTERNAL") throw error;
        log(code === "PROVIDER_UNAVAILABLE" ? "error" : "warn", `Video job ${event.jobId}, scene ${index + 1}: ${message}`);
        return end("failed", { code, stage: "speech", detail: `Scene ${index + 1}: ${message}` });
      }
      const fresh = cacheRecordFor(cacheKey, request, response, new Date());
      const ends = fresh.alignment?.character_end_times_seconds ?? [];
      const durationMs = ends.length ? Math.round(ends[ends.length - 1]! * 1000) : null;
      // Saved BEFORE the upload: if anything fails from here on, the paid answer is kept.
      const saved = await store.saveSpeechResponse({ ownerId, cacheKey, jobId, attempt, response: fresh as unknown as SpeechRecordDoc, durationMs });
      if (!saved) throw new Error(`Scene ${index + 1}: lost the recording lock while saving`);
      record = fresh as unknown as SpeechRecordDoc;
      audio = response.audio;
      if (sha256(audio) !== record.audioSha256) throw new Error(`Scene ${index + 1}: audio checksum mismatch`);
      await putOnce(files, keys.audio, audio);
    }
    // The timing files come from the saved answer (the same request as the audio).
    const parsed = SpeechCacheRecordSchema.parse(record);
    await putOnce(files, keys.alignment, `${JSON.stringify(parsed, null, 2)}\n`);
    await putOnce(files, keys.normalized, `${JSON.stringify({ schemaVersion: 1, cacheKey, audioSha256: parsed.audioSha256, normalizedAlignment: parsed.normalizedAlignment }, null, 2)}\n`);
    if (!(await store.markSpeechReady({ ownerId, cacheKey, jobId, attempt }))) throw new Error(`Scene ${index + 1}: couldn't mark the narration ready`);
    return { status: "ok" };
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
      let latest: { phase: RenderPhase; percent: number } = { phase: "timing", percent: 0 };
      let lastWritten = "";
      let run: RenderRun | null = null;
      let stopping = false;
      const write = async () => {
        const update = renderPhaseProgress(latest.phase, latest.percent);
        const key = `${update.stage}:${update.message}`;
        const result = await store.progress({ jobId, attempt, ...update, ...(key === lastWritten ? { stages: {} } : {}) });
        lastWritten = key;
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
        result = await run.result;
      } finally {
        clearInterval(heartbeat);
      }

      if (result.status === "cancelled" || stopping) return end("cancelled");
      if (result.status === "needs_input") {
        log("info", `Video job ${event.jobId}: needs a storyboard change: ${result.detail}`);
        return end("needs_input", { stage: "compile", detail: result.detail, needsInput: { reason: result.reason, message: result.message, sceneId: result.sceneId } });
      }
      if (result.status === "failed") {
        log("error", `Video job ${event.jobId}: ${result.stage} failed: ${result.detail}`);
        return end("failed", { code: result.stage === "compile" ? "INTERNAL" : "RENDER_FAILED", stage: result.stage, detail: result.detail });
      }

      // Upload the finished files create-only (a new renderId, so nothing can be overwritten).
      await store.progress({ jobId, attempt, stage: "validate", percent: 98, message: GENERATE_MESSAGES.SAVING });
      const ref = { ownerId: owner, projectId: ctx.project._id.toHexString(), renderId: renderId.toHexString() };
      const mp4 = await putOnce(files, StorageKeys.renderOutput(ref), new Uint8Array(await readFile(result.files.video)));
      if (mp4.sha256 !== result.qa.sha256) throw new Error("the uploaded video doesn't match the checked one");
      const thumbnail = await putOnce(files, StorageKeys.renderThumbnail(ref), new Uint8Array(await readFile(result.files.thumbnail)));
      const timeline = await putOnce(files, StorageKeys.renderTimeline(ref), new Uint8Array(await readFile(result.files.timeline)));
      const captions = await putOnce(files, StorageKeys.renderCaptions(ref), new Uint8Array(await readFile(result.files.captions)));
      const qa = await putOnce(files, StorageKeys.renderQa(ref), new Uint8Array(await readFile(result.files.qa)));
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
    } finally {
      // The work folder goes after success or failure; the uploaded files stay in R2.
      await rm(workDir, { recursive: true, force: true }).catch((e: unknown) => log("warn", `Video job ${event.jobId}: couldn't remove its work folder: ${String(e)}`));
    }
  }
}
