import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CAPTION_MESSAGES, renderingMessage, type CaptionErrorCode, type CaptionJobContext, type CaptionStage, type RenderToSave, type SpeechArtifactDocument } from "@bytereel/db";
import type { Plan } from "@bytereel/pipeline/contracts";
import { BACKGROUND_MUSIC } from "@bytereel/pipeline/pipeline/music";
import { THUMBNAIL_SECONDS, type RenderJobResult, type RenderJobSpec, type RenderPhase } from "@bytereel/pipeline/pipeline/render-protocol";
import { speechCacheKey, speechConfigFromRecord, type SpeechConfig } from "@bytereel/pipeline/pipeline/speech-key";
import { SpeechCacheRecordSchema } from "@bytereel/pipeline/storage";
import { StorageKeys, type StorageKey } from "@bytereel/storage";
import { ObjectId } from "mongodb";
import { isStorageRefusal, putOnce, removeOldWorkFolders, sha256, type FileStore } from "./render-files";
import { ensureProjectTmp, isInside, type RenderRun } from "./render-process";

// The caption job (Inngest function `fix-captions`, F25; PIPELINE_DESIGN §9 "Caption display
// correction → compile captions + render, no speech"): the creator fixed caption text (API F4); the
// video is rendered again with the SAME recorded narration and the fixes applied.
//
// ZERO voice calls, by construction: this worker has no voice dependency and its whole import graph
// loads no voice or provider module (the cache key comes from pipeline/speech-key.ts, not speech.ts;
// tests/caption-fixes.test.ts walks the real import graph). It reads the recordings the video
// already used (`renders.speech` → speechArtifacts, owner scoped), downloads their audio and timing
// files from R2 and checks each one against its saved SHA-256 and cache key. If any narration is
// missing or changed, the job fails with a plain message (NARRATION_MISSING): it never records.
//
// Durable steps (kept free of Inngest and of the real database, so tests run it with fakes):
//   start   the job becomes running; the R2 bucket is checked (a refusal ends the job at once)
//   render  a NEW renderId; narration downloaded and checked; the render child compiles the timeline
//           and captions, applies the fixes (same phrase timing), renders with the same v4 style and
//           music, checks the MP4 and makes the thumbnail; the files go to R2 create-only (SHA-256
//           checked) and the new video is saved as the project's video (the next video number).
// Progress: Updating captions → Rendering. Cancel: checked at every step and every few seconds while
// rendering (the renderer is stopped). On failure or cancel the project goes back to `video_ready`
// with the previous video (packages/db/src/caption-fixes.ts endCaptionJob). Try again (E2) runs the
// same steps. What the creator sees is always a fixed plain line; renderer text goes to the log.
// It shares the one-at-a-time render queue with the generate jobs (Inngest VIDEO_CONCURRENCY).

/** One job step: Inngest's step.run in production, a plain call in tests. */
export interface CaptionStepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/** What the worker needs from the database (packages/db/src/caption-fixes.ts). No voice, no usage counters. */
export interface CaptionJobStore {
  start(input: { jobId: string; attempt: number; runId: string | null }): Promise<CaptionJobContext | null>;
  load(input: { jobId: string; attempt: number }): Promise<CaptionJobContext | null>;
  /** The recordings a video used, by id, owner scoped. */
  speechByIds(ownerId: ObjectId, ids: readonly ObjectId[]): Promise<SpeechArtifactDocument[]>;
  progress(input: { jobId: ObjectId; attempt: number; stage: CaptionStage; percent: number; message: string; stages?: Partial<Record<CaptionStage, "running" | "succeeded">> }): Promise<{ cancelRequested: boolean } | null>;
  beginRender(input: { jobId: ObjectId; attempt: number; renderId: ObjectId }): Promise<{ cancelRequested: boolean } | null>;
  complete(input: { jobId: ObjectId; attempt: number; render: RenderToSave }): Promise<boolean>;
  end(input: { jobId: ObjectId; attempt: number; outcome: "failed" | "cancelled"; code?: CaptionErrorCode; stage?: CaptionStage; detail?: string }): Promise<boolean>;
}

export interface CaptionJobDeps {
  store: CaptionJobStore;
  /** The R2 store (throws when R2 isn't set up). */
  files: () => FileStore;
  /** Starts the render child process (render-process.ts startRenderProcess). */
  render: (spec: RenderJobSpec, options: { root: string; tmp: string; onProgress: (phase: RenderPhase, percent: number) => void }) => RenderRun;
  /** The repository root (work folders go in runs/.tmp/generate/<renderId>, like the video job's). */
  root: string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** How often the render step writes progress and checks Cancel (default 2 s). */
  heartbeatMs?: number;
  /** Short in-process waits between upload tries. Tests: no real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export type CaptionJobOutcome = "done" | "failed" | "cancelled" | "skipped";
type StepResult = { status: "ok" } | { status: "ended"; outcome: CaptionJobOutcome } | { status: "stale" };

const UPLOAD_TRIES = 3;
const UPLOAD_RETRY_WAIT_MS = 1000;

/** The fixed line stored when the render step fails (the renderer's own text goes to the server log only). */
const RENDER_FAILURE: Record<"compile" | "render" | "validate", { code: CaptionErrorCode; detail: string }> = {
  compile: { code: "INTERNAL", detail: "Updating the captions failed (see the server log)" },
  render: { code: "RENDER_FAILED", detail: "The render stopped with an error (see the server log)" },
  validate: { code: "RENDER_FAILED", detail: "The finished video didn't pass its checks (see the server log)" },
};

/** The fixed line stored for a failure that would happen again on every try (FIX_NOT_APPLICABLE, not retryable). */
const NOT_APPLICABLE_LINE: Record<"caption_fix" | "caption_width", string> = {
  caption_fix: "A caption fix no longer matches its phrase (see the server log)",
  caption_width: "A fixed caption was too wide for the caption box (see the server log)",
};

/** Progress shown for each render phase: timing + captions → Updating captions; rendering + checking → Rendering. */
export function captionPhaseProgress(phase: RenderPhase, percent: number): { stage: CaptionStage; percent: number; message: string; stages?: Partial<Record<CaptionStage, "running" | "succeeded">> } {
  switch (phase) {
    case "timing":
      return { stage: "compile", percent: 10 + percent * 0.1, message: CAPTION_MESSAGES.UPDATING };
    case "captions":
      return { stage: "compile", percent: 20 + percent * 0.05, message: CAPTION_MESSAGES.UPDATING };
    case "rendering":
      return { stage: "render", percent: 25 + percent * 0.7, message: renderingMessage(percent), stages: { compile: "succeeded", render: "running" } };
    case "checking":
      return { stage: "validate", percent: 96, message: CAPTION_MESSAGES.CHECKING, stages: { render: "succeeded", validate: "running" } };
  }
}

/** The narration of the video being fixed is missing or no longer matches (never recorded again here). */
class NarrationMissing extends Error {}

export async function runCaptionJob(input: { event: { jobId: string; attempt: number }; runId: string | null; step: CaptionStepRunner }, deps: CaptionJobDeps): Promise<CaptionJobOutcome> {
  const { event, step } = input;
  const { store } = deps;
  const log = deps.log ?? ((level, message) => console[level](message));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!/^[0-9a-f]{24}$/.test(event.jobId)) return "skipped";
  const jobId = new ObjectId(event.jobId);
  const attempt = event.attempt;
  const label = `Caption job ${event.jobId}`;

  const end = async (outcome: "failed" | "cancelled", extra: { code?: CaptionErrorCode; stage?: CaptionStage; detail?: string } = {}): Promise<StepResult> => {
    const ended = await store.end({ jobId, attempt, outcome, ...extra });
    return ended ? { status: "ended", outcome } : { status: "stale" };
  };
  const outcomeOf = (result: StepResult): CaptionJobOutcome | null => (result.status === "ok" ? null : result.status === "ended" ? result.outcome : "skipped");
  const storageRefused = (error: unknown): Promise<StepResult> => {
    log("error", `${label}: file storage refused the request: ${error instanceof Error ? error.message : String(error)}`);
    return end("failed", { code: "INTERNAL", detail: "File storage refused the request (see the server log)" });
  };

  /** A few quick in-process tries per upload (a short network hiccup must not fail the job). */
  async function upload(files: FileStore, key: StorageKey, data: Uint8Array | string) {
    for (let tryNumber = 1; ; tryNumber++) {
      try {
        return await putOnce(files, key, data);
      } catch (error) {
        if (isStorageRefusal(error) || tryNumber >= UPLOAD_TRIES) throw error;
        log("warn", `${label}: uploading ${key.split("/").pop()} failed (try ${tryNumber} of ${UPLOAD_TRIES}), trying again: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(UPLOAD_RETRY_WAIT_MS * tryNumber);
      }
    }
  }

  try {
    // ---------- start: running; a wrong bucket, token or R2 setting ends the job at once ----------
    const started = await step.run("start", async (): Promise<StepResult> => {
      const ctx = await store.start({ jobId: event.jobId, attempt, runId: input.runId });
      if (!ctx) return { status: "stale" };
      let files: FileStore;
      try {
        files = deps.files();
      } catch (error) {
        log("error", `${label}: ${error instanceof Error ? error.message : String(error)}`);
        return end("failed", { code: "INTERNAL", detail: "File storage isn't set up (see the server log)" });
      }
      try {
        await files.checkBucket();
      } catch (error) {
        if (!isStorageRefusal(error)) throw error; // a network problem: the step tries again
        return storageRefused(error);
      }
      return { status: "ok" };
    });
    const stopStart = outcomeOf(started);
    if (stopStart) return stopStart;

    // ---------- render with the same narration, check, upload, save ----------
    const rendered = await step.run("render", renderFixed);
    return outcomeOf(rendered) ?? "done";
  } catch (error) {
    log("error", `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    const failed = await step.run("fail-internal", () => end("failed", { code: "INTERNAL", detail: "Unexpected error (see the server log)" }));
    return outcomeOf(failed) ?? "failed";
  }

  /** The recorded narration of every scene, exactly as the video used it (SHA-256 and cache key checked). */
  async function loadNarration(ctx: CaptionJobContext, files: FileStore, workDir: string): Promise<{ scenes: RenderJobSpec["scenes"]; config: SpeechConfig; speech: RenderToSave["speech"]; cacheKeys: string[] }> {
    const plan = ctx.version.plan as unknown as Plan;
    const used = ctx.baseRender.speech;
    const docs = new Map((await store.speechByIds(ctx.job.ownerId, used.map((s) => s.speechArtifactId))).map((d) => [d._id.toHexString(), d]));
    await mkdir(path.join(workDir, "narration"), { recursive: true });
    const scenes: RenderJobSpec["scenes"] = [];
    const speech: RenderToSave["speech"] = [];
    const cacheKeys: string[] = [];
    let config: SpeechConfig | null = null;
    for (const [index, scene] of plan.scenes.entries()) {
      const n = index + 1;
      const entry = used.find((s) => s.sceneId === scene.id);
      const doc = entry ? docs.get(entry.speechArtifactId.toHexString()) : undefined;
      if (!entry || !doc || doc.status !== "ready" || !doc.audioSha256) throw new NarrationMissing(`scene ${n}: its recording is not in the database`);
      const audio = await files.get(doc.audioKey as StorageKey);
      if (!audio || sha256(audio) !== doc.audioSha256) throw new NarrationMissing(`scene ${n}: its audio file is missing or changed`);
      const json = await files.get(doc.alignmentKey as StorageKey);
      if (!json) throw new NarrationMissing(`scene ${n}: its timing file is missing`);
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.from(json).toString("utf8"));
      } catch {
        throw new NarrationMissing(`scene ${n}: its timing file is unreadable`);
      }
      const parsed = SpeechCacheRecordSchema.safeParse(raw);
      const record = parsed.success ? parsed.data : null;
      if (!record || record.audioSha256 !== doc.audioSha256 || record.cacheKey !== doc.cacheKey) throw new NarrationMissing(`scene ${n}: its timing file is unreadable or doesn't match the audio`);
      let sceneConfig: SpeechConfig;
      try {
        sceneConfig = speechConfigFromRecord(plan, record);
      } catch (error) {
        throw new NarrationMissing(`scene ${n}: ${error instanceof Error ? error.message : String(error)}`);
      }
      // The recording must be of THIS storyboard's words with this voice (same cache key as when it was made).
      if (speechCacheKey(scene, sceneConfig) !== doc.cacheKey) throw new NarrationMissing(`scene ${n}: the recording doesn't match the storyboard`);
      if (config && JSON.stringify(config) !== JSON.stringify(sceneConfig)) throw new NarrationMissing(`scene ${n}: recorded with another voice setup than scene 1`);
      config ??= sceneConfig;
      const audioFile = path.join(workDir, "narration", `${scene.id}.mp3`);
      await writeFile(audioFile, audio);
      scenes.push({ sceneId: scene.id, audioFile, record });
      speech.push({ sceneId: scene.id, speechArtifactId: doc._id });
      cacheKeys.push(doc.cacheKey);
    }
    if (!config) throw new NarrationMissing("the storyboard has no scenes");
    return { scenes, config, speech, cacheKeys };
  }

  async function renderFixed(): Promise<StepResult> {
    const ctx = await store.load({ jobId: event.jobId, attempt });
    if (!ctx) return { status: "stale" };
    if (ctx.job.cancelRequestedAt) return end("cancelled");
    const plan = ctx.version.plan as unknown as Plan;
    const renderId = new ObjectId(); // a NEW folder for every render attempt (never reused)
    const begun = await store.beginRender({ jobId, attempt, renderId });
    if (!begun) return { status: "stale" };
    if (begun.cancelRequested) return end("cancelled");

    // F22b MUST: the process temp folder must be inside the project before the first render.
    const { tmp: processTmp, changed } = ensureProjectTmp(deps.root);
    if (changed) log("warn", `${label}: TMPDIR was outside the project; set to ${path.relative(deps.root, processTmp)}`);
    const workDir = path.join(deps.root, "runs", ".tmp", "generate", renderId.toHexString());
    if (!isInside(deps.root, workDir)) throw new Error("the render work folder must be inside the project");
    // The render process gets its OWN temp folder inside the work folder, so removing it cleans all.
    const tmp = path.join(workDir, "tmp");
    await mkdir(tmp, { recursive: true });
    await removeOldWorkFolders(path.dirname(workDir), renderId.toHexString());
    const files = deps.files();
    try {
      let narration: Awaited<ReturnType<typeof loadNarration>>;
      try {
        narration = await loadNarration(ctx, files, workDir);
      } catch (error) {
        if (!(error instanceof NarrationMissing)) throw error;
        log("error", `${label}: the video's narration can't be used: ${error.message}`);
        return end("failed", { code: "NARRATION_MISSING", stage: "compile", detail: "The video's recorded narration is missing or changed (see the server log)" });
      }

      let latest: { phase: RenderPhase; percent: number } = { phase: "timing", percent: 0 };
      let lastStage = "";
      let run: RenderRun | null = null;
      let stopping = false;
      const write = async () => {
        const update = captionPhaseProgress(latest.phase, latest.percent);
        const result = await store.progress({ jobId, attempt, ...update, ...(update.stage === lastStage ? { stages: {} } : {}) });
        lastStage = update.stage;
        if ((result === null || result.cancelRequested) && !stopping) {
          stopping = true;
          run?.cancel();
        }
      };
      const heartbeat = setInterval(() => void write().catch((e: unknown) => log("warn", `${label}: progress not saved: ${String(e)}`)), deps.heartbeatMs ?? 2000);
      let result: RenderJobResult;
      try {
        run = deps.render(
          {
            workDir,
            plan,
            planHash: ctx.version.planHash,
            speechConfig: narration.config,
            scenes: narration.scenes,
            music: BACKGROUND_MUSIC,
            thumbnailSeconds: THUMBNAIL_SECONDS,
            captionOverrides: ctx.set.overrides.map((o) => ({ sceneId: o.sceneId, phraseIndex: o.phraseIndex, text: o.text, originalText: o.originalText })),
          },
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
        // The same narration made this video before; a storyboard problem here means something else broke.
        log("error", `${label}: the render asked for a storyboard change: ${result.detail}`);
        return end("failed", { code: "INTERNAL", stage: "compile", detail: RENDER_FAILURE.compile.detail });
      }
      if (result.status === "failed") {
        log("error", `${label}: ${result.stage} failed: ${result.detail}`);
        // A fix that can't be applied, or a fixed line too wide in the browser: the same again on every try.
        if (result.reason) return end("failed", { code: "FIX_NOT_APPLICABLE", stage: result.stage, detail: NOT_APPLICABLE_LINE[result.reason] });
        return end("failed", { code: RENDER_FAILURE[result.stage].code, stage: result.stage, detail: RENDER_FAILURE[result.stage].detail });
      }

      // Upload the finished files create-only (a new renderId, so nothing can be overwritten).
      await store.progress({ jobId, attempt, stage: "validate", percent: 98, message: CAPTION_MESSAGES.SAVING });
      const ref = { ownerId: ctx.job.ownerId.toHexString(), projectId: ctx.project._id.toHexString(), renderId: renderId.toHexString() };
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
          speech: narration.speech,
          keys: { timeline: timeline.key, captions: captions.key, mp4: mp4.key, thumbnail: thumbnail.key, qa: qa.key },
          mp4Sha256: mp4.sha256,
          qa: result.qa as unknown as Record<string, unknown>,
          metrics: { renderMs: result.renderMs, bundleMs: result.bundleMs, bytes: mp4.bytes, durationMs: result.durationMs, frames: result.frames },
          cacheKeys: narration.cacheKeys,
          music: BACKGROUND_MUSIC,
        },
      });
      return saved ? { status: "ended", outcome: "done" } : { status: "stale" };
    } catch (error) {
      if (isStorageRefusal(error)) return storageRefused(error);
      throw error;
    } finally {
      // The work folder goes after success or failure; the uploaded files stay in R2.
      await rm(workDir, { recursive: true, force: true }).catch((e: unknown) => log("warn", `${label}: couldn't remove its work folder: ${String(e)}`));
    }
  }
}
