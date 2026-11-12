import fs from "node:fs/promises";
import path from "node:path";
import { SceneAlignmentSchema, type Manifest, type Plan, type SceneAlignment, type StageName } from "../contracts";
import { adviceFor, ProviderError, type SpeechProvider } from "../providers";
import { ArtifactKeys, type LocalArtifactStore, type RunRef, type RunWriter, type SpeechCache } from "../storage";
import {
  AlignmentMappingError,
  AlignmentValidationError,
  CompileInputError,
  compileTimeline,
  DEFAULT_HOLDS,
  DurationOutOfRangeError,
  speechInputForScene,
  type CompileResult,
} from "../timing";
import { evaluateProbe, probeMp4, PROBED_WITH, type Mp4Probe, type QaReport } from "../validation";
import { AudioProbeError, probeAudioFile, type AudioProbe } from "../validation/audio";
import { checkGenerationGate } from "./approval-gate";
import { loadManifest, recordArtifact, saveManifest, transitionRun, updateSceneSpeech, updateStage } from "./manifest";
import type { RenderJob, RenderReport } from "./render";
import { previewFramesFor } from "./render-fixture";
import {
  buildSceneAlignment,
  cacheRecordFor,
  countCharacters,
  speechCacheKey,
  speechRequestFor,
  SpeechBudgetError,
  type SpeechConfig,
} from "./speech";

/**
 * Live generation (PIPELINE_DESIGN.md §8): approval gate -> Speech (per scene) -> Compile -> Render
 * (with audio) -> Validate -> `ready-for-review`. `resume` runs the same stages after a failure.
 *
 * Reuse rules (never call the provider twice for the same input):
 * - a scene whose alignment/<scene>.json in this run has the same speech cache key, and whose audio
 *   and alignment still match their recorded hashes, is reused as is;
 * - otherwise the owner-scoped content-addressed speech cache is checked;
 * - only then is the provider called, and its response goes into the cache immediately.
 * Render/validate failures therefore resume without any speech call.
 *
 * Character budget: every attempt (retries included) is counted in manifest.speechUsage and saved
 * BEFORE the request is sent; a request that would exceed `maxCharacters` is never sent.
 */

export type GenerateMode = "generate" | "resume";

export type SceneSpeechSource = "run" | "cache" | "provider";

export interface SceneSpeechReport {
  sceneId: string;
  source: SceneSpeechSource;
  characters: number;
  characterCost: number | null;
  audioSeconds: number;
  mappedFrom: "original" | "normalized";
  retries: number;
}

interface Base {
  runDir: string;
  manifest: Manifest;
  scenes: SceneSpeechReport[];
}

export type GenerateResult =
  | { status: "refused"; message: string }
  | (Base & { status: "speech-only"; pendingScenes: string[] })
  | (Base & { status: "already-done" })
  | (Base & { status: "needs-input"; stage: StageName; message: string })
  | (Base & { status: "failed"; stage: StageName; message: string; qa?: QaReport })
  | (Base & { status: "ready-for-review"; qa: QaReport; render: RenderReport; compiled: CompileResult });

export interface GenerateOptions {
  store: LocalArtifactStore;
  run: RunRef;
  mode: GenerateMode;
  /** Created lazily, only when a scene actually needs synthesis. */
  speechProvider: () => SpeechProvider;
  /** Voice/model/settings for the plan (voice from the plan's voicePreset; no fallback). */
  speechConfig: (plan: Plan) => SpeechConfig;
  speechCache: SpeechCache;
  /** Synthesize (or reuse) only these scenes, then stop before compile (a budget-friendly probe). */
  onlyScenes?: readonly string[];
  /**
   * Max total text-to-speech characters for this run (all requests and retries so far included).
   * Default: 1.5 x the plan's narration characters (one full synthesis plus a little retry room).
   */
  maxCharacters?: number;
  now?: () => Date;
  onProgress?: (message: string) => void;
  render?: (job: RenderJob) => Promise<RenderReport>;
  probe?: (filePath: string) => Promise<Mp4Probe>;
  probeAudio?: (filePath: string) => Promise<AudioProbe>;
}

export async function generateRun(options: GenerateOptions): Promise<GenerateResult> {
  const { store, run, mode, now = () => new Date(), onProgress = () => undefined } = options;
  const render = options.render ?? (async (job: RenderJob) => (await import("./render")).renderExplainer(job));
  const probe = options.probe ?? probeMp4;
  const probeAudio = options.probeAudio ?? probeAudioFile;
  const runDir = store.describeRun(run);

  const gate = await checkGenerationGate(store, run);
  if (!gate.allowed) return { status: "refused", message: gate.reason };
  if (gate.fixture) return { status: "refused", message: "this is a fixture run; fixtures are rendered with `render-fixture` (synthetic silent timing), never with live speech" };
  const { plan, planHash } = gate;

  const maxCharacters = options.maxCharacters ?? defaultCharacterBudget(plan);
  const onlyScenes = options.onlyScenes ? [...new Set(options.onlyScenes)] : null;
  if (onlyScenes) {
    const unknown = onlyScenes.filter((id) => !plan.scenes.some((s) => s.id === id));
    if (unknown.length) return { status: "refused", message: `unknown scene(s): ${unknown.join(", ")}; scenes: ${plan.scenes.map((s) => s.id).join(", ")}` };
  }
  let config: SpeechConfig;
  try {
    config = options.speechConfig(plan);
  } catch (error) {
    return { status: "refused", message: (error as Error).message };
  }

  const writer = await store.acquireWriter(run);
  let manifest = (await loadManifest(store, run))!;
  const save = async () => saveManifest(writer, manifest);
  const scenes: SceneSpeechReport[] = [];
  const base = () => ({ runDir, manifest, scenes });

  try {
    // ---------- state checks ----------
    if (manifest.state === "ready-for-review" && !onlyScenes) {
      if (await outputsVerify(store, run, manifest)) return { status: "already-done", ...base() };
      manifest = transitionRun(manifest, "needs-input", "stored output no longer matches its hash; regenerating from saved artifacts", now());
    }
    if (manifest.state === "running") {
      // We hold the writer lock, so the process that set "running" is gone (crash or kill).
      manifest = transitionRun(manifest, "failed", "previous generate/resume was interrupted", now());
    }
    if (mode === "generate" && !onlyScenes && manifest.state !== "plan-approved") {
      return { status: "refused", message: `run is "${manifest.state}"; use \`resume\` to continue it (saved speech is reused, nothing is re-synthesized)` };
    }
    if (!["plan-approved", "failed", "needs-input"].includes(manifest.state)) {
      return { status: "refused", message: `run is "${manifest.state}"; it cannot be generated from this state` };
    }
    if (onlyScenes && manifest.state !== "plan-approved") {
      return { status: "refused", message: `--scene probes are only for a freshly approved run; this run is "${manifest.state}" (use resume)` };
    }

    // ---------- Speech ----------
    const targetIndexes = plan.scenes.map((s, i) => ({ s, i })).filter(({ s }) => !onlyScenes || onlyScenes.includes(s.id));
    if (!onlyScenes) {
      for (const stage of ["compile", "render", "validate"] as const) {
        if (manifest.stages[stage].status === "succeeded" || manifest.stages[stage].status === "failed") {
          manifest = updateStage(manifest, stage, "pending", now(), "reset for a new attempt");
        }
      }
      manifest = transitionRun(manifest, "running", `${mode}: speech -> compile -> render -> validate`, now());
      if (manifest.stages.speech.status !== "succeeded") {
        manifest = updateStage(manifest, "speech", "running", now(), `voice ${config.voicePreset} (${config.voiceId}), model ${config.modelId}, ${config.outputFormat}`);
      }
      await save();
    }

    const alignments: Record<string, SceneAlignment> = {};
    for (const { s: scene, i: index } of targetIndexes) {
      try {
        const { alignment, report } = await ensureSceneSpeech(index);
        alignments[scene.id] = alignment;
        scenes.push(report);
      } catch (error) {
        const message = (error as Error).message;
        const providerError = error instanceof ProviderError ? error : null;
        const alignmentProblem = error instanceof AlignmentMappingError || error instanceof AlignmentValidationError || error instanceof AudioProbeError;
        const full = providerError ? `${message.replace(/\.+$/, "")}. ${adviceFor(providerError)}` : alignmentProblem ? `recoverable alignment error: ${message}` : message;
        if (manifest.scenes.find((s) => s.id === scene.id)?.speech.status === "running") {
          manifest = updateSceneSpeech(manifest, scene.id, "failed", now(), full);
        }
        if (onlyScenes) {
          await save();
          return { status: "failed", stage: "speech", message: full, ...base() };
        }
        manifest = updateStage(manifest, "speech", "failed", now(), `scene "${scene.id}": ${full}`);
        const needsInput = alignmentProblem || providerError?.kind === "budget";
        manifest = transitionRun(manifest, needsInput ? "needs-input" : "failed", `speech failed for scene "${scene.id}" (${providerError?.kind ?? (alignmentProblem ? "alignment" : "error")})`, now());
        await save();
        return needsInput ? { status: "needs-input", stage: "speech", message: full, ...base() } : { status: "failed", stage: "speech", message: full, ...base() };
      }
    }

    if (onlyScenes) {
      await save();
      const pendingScenes = manifest.scenes.filter((s) => s.speech.status !== "succeeded").map((s) => s.id);
      return { status: "speech-only", pendingScenes, ...base() };
    }
    if (manifest.stages.speech.status !== "succeeded") {
      const total = scenes.reduce((sum, s) => sum + s.audioSeconds, 0);
      manifest = updateStage(
        manifest,
        "speech",
        "succeeded",
        now(),
        `${scenes.length} scenes, ${total.toFixed(2)} s of narration; sources: ${scenes.map((s) => `${s.sceneId}=${s.source}`).join(", ")}; ` +
          `run usage ${manifest.speechUsage.requests} request(s), ${manifest.speechUsage.charactersSent} characters sent` +
          (manifest.speechUsage.charactersReported ? `, ${manifest.speechUsage.charactersReported} reported by the provider` : ""),
      );
    }
    await save();

    // ---------- Compile ----------
    onProgress("Compile: real narration timing -> timeline + captions");
    manifest = updateStage(manifest, "compile", "running", now());
    await save();
    let compiled: CompileResult;
    try {
      compiled = compileTimeline({ plan, planHash, alignments, holds: DEFAULT_HOLDS });
    } catch (error) {
      const message = (error as Error).message;
      const planProblem =
        error instanceof DurationOutOfRangeError || error instanceof AlignmentMappingError ||
        error instanceof AlignmentValidationError || error instanceof CompileInputError;
      manifest = updateStage(manifest, "compile", "failed", now(), message);
      manifest = transitionRun(manifest, planProblem ? "needs-input" : "failed", planProblem ? `return for plan adjustment: ${message}` : message, now());
      await save();
      return planProblem ? { status: "needs-input", stage: "compile", message, ...base() } : { status: "failed", stage: "compile", message, ...base() };
    }
    manifest = recordArtifact(manifest, await writer.writeJson(ArtifactKeys.timeline, compiled.timeline), now());
    manifest = recordArtifact(manifest, await writer.writeJson(ArtifactKeys.captions, compiled.captions), now());
    manifest = { ...manifest, timingSource: compiled.timeline.timingSource };
    manifest = updateStage(
      manifest,
      "compile",
      "succeeded",
      now(),
      `${compiled.timeline.totalFrames} frames (${(compiled.timeline.totalFrames / compiled.timeline.fps).toFixed(2)} s), ${compiled.timeline.scenes.length} scenes, ` +
        `${compiled.captions.captions.length} captions; ElevenLabs timing; holds ${DEFAULT_HOLDS.sceneHoldMs} ms/scene, ${DEFAULT_HOLDS.takeawayHoldMs} ms takeaway`,
    );
    await save();

    // ---------- Render ----------
    onProgress("Render: Remotion (with narration) -> output.mp4 + preview frames");
    manifest = updateStage(manifest, "render", "running", now());
    await save();
    const tempDir = path.join(store.runDir(run), ".render-tmp");
    let report: RenderReport;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      const publicDir = path.join(tempDir, "public");
      await fs.mkdir(path.join(publicDir, "audio"), { recursive: true });
      for (const scene of compiled.timeline.scenes) {
        if (!scene.audioKey) throw new Error(`scene "${scene.sceneId}" has no audio`);
        const record = manifest.artifacts[scene.audioKey];
        if (!record || !(await store.verify(run, scene.audioKey, record.sha256))) throw new Error(`${scene.audioKey} is missing or changed on disk`);
        await fs.copyFile(path.join(store.runDir(run), scene.audioKey), path.join(publicDir, scene.audioKey));
      }
      const tempVideo = path.join(tempDir, "output.mp4");
      report = await render({
        timeline: compiled.timeline,
        captions: compiled.captions,
        outputPath: tempVideo,
        previewFrames: previewFramesFor(compiled),
        previewDir: path.join(tempDir, "preview-frames"),
        publicDir,
        onProgress,
      });
      manifest = recordArtifact(manifest, await moveIntoStore(writer, ArtifactKeys.output, tempVideo), now());
      for (const preview of report.previews) {
        manifest = recordArtifact(manifest, await moveIntoStore(writer, ArtifactKeys.previewFrame(preview.id), preview.path), now());
      }
    } catch (error) {
      const message = `render failed: ${(error as Error).message}. Speech is saved; \`resume\` re-renders without any new speech call.`;
      manifest = updateStage(manifest, "render", "failed", now(), message);
      manifest = transitionRun(manifest, "failed", message, now());
      await save();
      return { status: "failed", stage: "render", message, ...base() };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    manifest = updateStage(
      manifest,
      "render",
      "succeeded",
      now(),
      `rendered ${compiled.timeline.totalFrames} frames with narration in ${(report.renderMs / 1000).toFixed(1)} s (bundle ${(report.bundleMs / 1000).toFixed(1)} s, ` +
        `${report.previews.length} preview frames ${(report.stillsMs / 1000).toFixed(1)} s)`,
    );
    await save();

    // ---------- Validate ----------
    onProgress("Validate: probing output.mp4 (video + audio)");
    manifest = updateStage(manifest, "validate", "running", now());
    await save();
    let qa: QaReport;
    try {
      const measured = await probe(path.join(store.runDir(run), ArtifactKeys.output));
      const checks = evaluateProbe(measured, compiled.timeline);
      const output = manifest.artifacts[ArtifactKeys.output]!;
      qa = {
        schemaVersion: 1,
        ok: checks.every((c) => c.ok),
        file: ArtifactKeys.output,
        sha256: output.sha256,
        bytes: output.bytes,
        timingSource: compiled.timeline.timingSource,
        liveResult: true,
        probedWith: PROBED_WITH,
        measured,
        checks,
      };
      manifest = recordArtifact(manifest, await writer.writeJson(ArtifactKeys.qa, qa), now());
    } catch (error) {
      const message = `validation could not run: ${(error as Error).message}`;
      manifest = updateStage(manifest, "validate", "failed", now(), message);
      manifest = transitionRun(manifest, "failed", message, now());
      await save();
      return { status: "failed", stage: "validate", message, ...base() };
    }
    if (!qa.ok) {
      const failed = qa.checks.filter((c) => !c.ok).map((c) => `${c.name}: expected ${c.expected}, got ${c.actual}`).join("; ");
      manifest = updateStage(manifest, "validate", "failed", now(), `MP4 checks failed: ${failed}`);
      manifest = transitionRun(manifest, "failed", "output video failed validation; it cannot be marked ready for review", now());
      await save();
      return { status: "failed", stage: "validate", message: failed, qa, ...base() };
    }
    manifest = updateStage(manifest, "validate", "succeeded", now(), `all ${qa.checks.length} MP4 checks passed (${PROBED_WITH})`);
    manifest = transitionRun(manifest, "ready-for-review", "MP4 with narration valid; human review still required", now());
    await save();
    return { status: "ready-for-review", qa, render: report, compiled, ...base() };
  } finally {
    await writer.release();
  }

  // ---------- per-scene speech (closure over manifest/writer) ----------
  async function ensureSceneSpeech(index: number): Promise<{ alignment: SceneAlignment; report: SceneSpeechReport }> {
    const scene = plan.scenes[index]!;
    const cacheKey = speechCacheKey(scene, config);
    const audioKey = ArtifactKeys.audio(scene.id);
    const alignmentKey = ArtifactKeys.alignment(scene.id);
    const reportFor = (alignment: SceneAlignment, source: SceneSpeechSource, retries = 0): SceneSpeechReport => ({
      sceneId: scene.id,
      source,
      characters: alignment.speech?.charactersSent ?? countCharacters(alignment.speechText),
      characterCost: alignment.speech?.characterCost ?? null,
      audioSeconds: alignment.audioDurationSeconds,
      mappedFrom: alignment.speech?.mappedFrom ?? "original",
      retries,
    });

    // 1. Already in this run, unchanged on disk, same speech input.
    const sceneRecord = manifest.scenes.find((s) => s.id === scene.id);
    const audioRecord = manifest.artifacts[audioKey];
    const alignmentRecord = manifest.artifacts[alignmentKey];
    if (sceneRecord?.speech.status === "succeeded" && audioRecord && alignmentRecord &&
        (await store.verify(run, audioKey, audioRecord.sha256)) && (await store.verify(run, alignmentKey, alignmentRecord.sha256))) {
      const parsed = SceneAlignmentSchema.safeParse(await store.readJson(run, alignmentKey));
      if (parsed.success && parsed.data.speech?.cacheKey === cacheKey && parsed.data.audio?.sha256 === audioRecord.sha256) {
        onProgress(`Speech ${scene.id}: reusing saved audio (no provider call)`);
        return { alignment: parsed.data, report: reportFor(parsed.data, "run") };
      }
    }

    if (sceneRecord && sceneRecord.speech.status !== "running") {
      if (sceneRecord.speech.status === "succeeded" || sceneRecord.speech.status === "skipped") {
        manifest = updateSceneSpeech(manifest, scene.id, "pending", now(), "saved speech missing or changed; rebuilding");
      }
      manifest = updateSceneSpeech(manifest, scene.id, "running", now());
    }

    // 2. Owner-scoped content-addressed cache.
    let source: SceneSpeechSource = "cache";
    let retries = 0;
    let hit = await options.speechCache.get(run.ownerId, cacheKey);
    if (hit) {
      onProgress(`Speech ${scene.id}: reusing cached audio ${cacheKey.slice(0, 19)}... (no provider call)`);
    } else {
      // 3. Provider call, within the character budget.
      source = "provider";
      const request = speechRequestFor(plan, index, config);
      const characters = countCharacters(request.text);
      onProgress(`Speech ${scene.id}: synthesizing ${characters} characters with ElevenLabs (${config.modelId})...`);
      const provider = options.speechProvider();
      const response = await provider.synthesize(request, {
        beforeAttempt: async (attempt) => {
          const projected = manifest.speechUsage.charactersSent + characters;
          if (projected > maxCharacters) {
            throw new SpeechBudgetError(
              `sending scene "${scene.id}" (${characters} characters${attempt > 1 ? `, retry ${attempt - 1}` : ""}) would bring this run to ${projected} characters, ` +
                `over the budget of ${maxCharacters} (already sent: ${manifest.speechUsage.charactersSent})`,
            );
          }
          manifest = {
            ...manifest,
            speechUsage: { ...manifest.speechUsage, requests: manifest.speechUsage.requests + 1, charactersSent: projected },
          };
          await save(); // counted before sending: a crash can never under-count
        },
        retry: { onRetry: ({ waitMs, error }) => onProgress(`Speech ${scene.id}: transient error (${error.message}); retrying in ${Math.ceil(waitMs / 1000)} s`) },
      });
      retries = response.retries;
      const record = cacheRecordFor(cacheKey, request, response, now());
      await options.speechCache.put(run.ownerId, record, response.audio); // saved before anything else can fail
      if (response.characterCost !== null) {
        manifest = { ...manifest, speechUsage: { ...manifest.speechUsage, charactersReported: manifest.speechUsage.charactersReported + response.characterCost } };
      }
      hit = { record, audio: response.audio };
    }

    // Write audio into the run, probe the real file, validate + map the alignment, then save it.
    manifest = recordArtifact(manifest, await writer.write(audioKey, hit.audio), now());
    const audioProbe = await probeAudio(path.join(store.runDir(run), audioKey));
    const alignment = buildSceneAlignment({ plan, scene, config, record: hit.record, probe: audioProbe });
    manifest = recordArtifact(manifest, await writer.writeJson(alignmentKey, alignment), now());
    const sent = speechInputForScene(scene).speechText;
    manifest = updateSceneSpeech(
      manifest,
      scene.id,
      "succeeded",
      now(),
      `${source === "provider" ? "synthesized" : "reused from speech cache"}: ${countCharacters(sent)} characters, audio ${audioProbe.decodedSeconds.toFixed(3)} s ` +
        `(${audioProbe.codec ?? "?"} ${audioProbe.sampleRate ?? "?"} Hz), timing from ${alignment.speech!.mappedFrom} alignment` +
        (hit.record.characterCost !== null ? `, provider charged ${hit.record.characterCost}` : "") +
        (hit.record.requestId ? `, request ${hit.record.requestId}` : ""),
    );
    await save();
    return { alignment, report: reportFor(alignment, source, retries) };
  }
}

export const DEFAULT_BUDGET_FACTOR = 1.5;

/** Characters one full synthesis of the plan sends (sum of every scene's speech text). */
export function planSpeechCharacters(plan: Plan): number {
  return plan.scenes.reduce((sum, scene) => sum + countCharacters(speechInputForScene(scene).speechText), 0);
}

export function defaultCharacterBudget(plan: Plan): number {
  return Math.ceil(planSpeechCharacters(plan) * DEFAULT_BUDGET_FACTOR);
}

async function moveIntoStore(writer: RunWriter, key: string, sourcePath: string) {
  const written = await writer.write(key, await fs.readFile(sourcePath));
  await fs.rm(sourcePath, { force: true });
  return written;
}

async function outputsVerify(store: LocalArtifactStore, run: RunRef, manifest: Manifest): Promise<boolean> {
  for (const key of [ArtifactKeys.output, ArtifactKeys.timeline, ArtifactKeys.captions, ArtifactKeys.qa]) {
    const record = manifest.artifacts[key];
    if (!record || !(await store.verify(run, key, record.sha256))) return false;
  }
  return true;
}

