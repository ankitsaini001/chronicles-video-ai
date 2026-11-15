import fs from "node:fs/promises";
import path from "node:path";
import type { CancelSignal } from "@remotion/renderer";
import type { SceneAlignment } from "../contracts";
import { sha256 } from "../shared/hash";
import {
  AlignmentMappingError,
  AlignmentValidationError,
  CompileInputError,
  compileTimeline,
  DEFAULT_HOLDS,
  DurationOutOfRangeError,
  type CompileResult,
} from "../timing";
import { evaluateProbe, probeMp4, PROBED_WITH, type Mp4Probe, type QaReport } from "../validation";
import { AudioProbeError, probeAudioFile, type AudioProbe } from "../validation/audio";
import type { RenderJob, RenderReport } from "./render";
import type { RenderJobResult, RenderJobSpec, RenderPhase } from "./render-protocol";
import { buildSceneAlignment } from "./speech";

/**
 * One render attempt of the web app's generate job (F23), on local files only (the render child
 * process runs it; packages/pipeline/src/pipeline/render-child.ts):
 *   Timing animations (probe each narration MP3, check its alignment)
 *   → Adding captions (compileTimeline: timeline.json + captions.json, schema v2)
 *   → Rendering (the v4 engine with the music bed and a JPEG thumbnail)
 *   → Checking (the MP4 validator).
 * Everything is written inside `spec.workDir`. Plan problems found here (the video would be outside
 * 60–90 s, or a scene's words can't be timed with certainty) come back as `needs_input`; nothing is
 * guessed. A render problem comes back as `failed`. No AI or voice call is ever made here.
 */

export interface RenderJobHooks {
  onProgress?: (phase: RenderPhase, percent: number) => void;
  cancelSignal?: CancelSignal;
  /** True once Cancel was pressed: a render error after that is reported as `cancelled`. */
  isCancelled?: () => boolean;
  render?: (job: RenderJob) => Promise<RenderReport>;
  probe?: (filePath: string) => Promise<Mp4Probe>;
  probeAudio?: (filePath: string) => Promise<AudioProbe>;
}

const FPS = 30;

/** "Your narration runs about 97 seconds; videos must be 60–90 s. …" (API.md §4.3 NEEDS_INPUT duration). */
export function durationMessage(error: DurationOutOfRangeError): string {
  const seconds = Math.round(error.totalFrames / error.fps);
  const advice = error.totalFrames > error.maxFrames ? 'Try asking: "make it shorter".' : 'Try asking: "explain a bit more".';
  return `Your narration runs about ${seconds} seconds; videos must be ${error.minFrames / error.fps}–${error.maxFrames / error.fps} s. ${advice}`;
}

export async function runRenderJob(spec: RenderJobSpec, hooks: RenderJobHooks = {}): Promise<RenderJobResult> {
  const progress = hooks.onProgress ?? (() => undefined);
  const render = hooks.render ?? (async (job: RenderJob) => (await import("./render")).renderExplainer(job));
  const probe = hooks.probe ?? probeMp4;
  const probeAudio = hooks.probeAudio ?? probeAudioFile;
  const cancelled = hooks.isCancelled ?? (() => false);
  const { plan } = spec;
  const outDir = path.join(spec.workDir, "out");
  const publicDir = path.join(spec.workDir, "public");
  await fs.mkdir(path.join(publicDir, "audio"), { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  // ---------- Timing animations: the real narration length and word timings ----------
  progress("timing", 0);
  const alignments: Record<string, SceneAlignment> = {};
  for (const [index, scene] of plan.scenes.entries()) {
    const input = spec.scenes.find((s) => s.sceneId === scene.id);
    if (!input) return { status: "failed", stage: "compile", detail: `scene "${scene.id}" has no narration file` };
    try {
      const measured = await probeAudio(input.audioFile);
      alignments[scene.id] = buildSceneAlignment({ plan, scene, config: spec.speechConfig, record: input.record, probe: measured });
    } catch (error) {
      if (error instanceof AlignmentMappingError || error instanceof AlignmentValidationError || error instanceof AudioProbeError) {
        return { status: "needs_input", reason: "alignment_uncertain", sceneId: scene.id, message: `Please adjust the wording in scene ${index + 1}.`, detail: error.message };
      }
      throw error;
    }
    // The composition plays `audio/<scene id>.mp3` from the public folder (timeline audioKey).
    await fs.copyFile(input.audioFile, path.join(publicDir, "audio", `${scene.id}.mp3`));
    progress("timing", Math.round(((index + 1) / plan.scenes.length) * 100));
  }

  // ---------- Adding captions: timeline + captions (deterministic) ----------
  progress("captions", 0);
  let compiled: CompileResult;
  try {
    compiled = compileTimeline({ plan, planHash: spec.planHash, alignments, holds: DEFAULT_HOLDS });
  } catch (error) {
    if (error instanceof DurationOutOfRangeError) return { status: "needs_input", reason: "duration_out_of_range", sceneId: null, message: durationMessage(error), detail: error.message };
    if (error instanceof AlignmentMappingError || error instanceof AlignmentValidationError) {
      const index = plan.scenes.findIndex((s) => s.id === error.sceneId);
      return { status: "needs_input", reason: "alignment_uncertain", sceneId: error.sceneId, message: `Please adjust the wording in scene ${index + 1}.`, detail: error.message };
    }
    if (error instanceof CompileInputError) return { status: "failed", stage: "compile", detail: error.message };
    throw error;
  }
  const files = {
    video: path.join(outDir, "output.mp4"),
    thumbnail: path.join(outDir, "thumbnail.jpg"),
    timeline: path.join(outDir, "timeline.json"),
    captions: path.join(outDir, "captions.json"),
    qa: path.join(outDir, "qa.json"),
  };
  await fs.writeFile(files.timeline, `${JSON.stringify(compiled.timeline, null, 2)}\n`);
  await fs.writeFile(files.captions, `${JSON.stringify(compiled.captions, null, 2)}\n`);
  progress("captions", 100);

  // ---------- Rendering: the v4 engine, music bed, thumbnail ----------
  progress("rendering", 0);
  let report: RenderReport;
  try {
    report = await render({
      timeline: compiled.timeline,
      captions: compiled.captions,
      outputPath: files.video,
      previewFrames: [],
      previewDir: path.join(spec.workDir, "preview"),
      publicDir,
      music: spec.music,
      workDir: path.join(spec.workDir, "remotion"),
      thumbnail: { frame: Math.round(spec.thumbnailSeconds * FPS), outputPath: files.thumbnail },
      onFrameProgress: (share) => progress("rendering", Math.min(100, Math.floor(share * 100))),
      ...(hooks.cancelSignal ? { cancelSignal: hooks.cancelSignal } : {}),
    });
  } catch (error) {
    if (cancelled()) return { status: "cancelled" };
    return { status: "failed", stage: "render", detail: error instanceof Error ? error.message : String(error) };
  }
  if (cancelled()) return { status: "cancelled" };

  // ---------- Checking: probe the real file ----------
  progress("checking", 0);
  let qa: QaReport;
  try {
    const bytes = await fs.readFile(files.video);
    const measured = await probe(files.video);
    const checks = evaluateProbe(measured, compiled.timeline);
    qa = {
      schemaVersion: 1,
      ok: checks.every((c) => c.ok),
      file: "output.mp4",
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      timingSource: compiled.timeline.timingSource,
      liveResult: true,
      probedWith: PROBED_WITH,
      measured,
      checks,
    };
  } catch (error) {
    return { status: "failed", stage: "validate", detail: `validation could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
  await fs.writeFile(files.qa, `${JSON.stringify(qa, null, 2)}\n`);
  if (!qa.ok) {
    const failed = qa.checks.filter((c) => !c.ok).map((c) => `${c.name}: expected ${c.expected}, got ${c.actual}`).join("; ");
    return { status: "failed", stage: "validate", detail: `MP4 checks failed: ${failed}` };
  }
  try {
    await fs.access(files.thumbnail);
  } catch {
    return { status: "failed", stage: "render", detail: "the thumbnail was not written" };
  }
  progress("checking", 100);
  return {
    status: "ready",
    files,
    qa,
    durationMs: Math.round((compiled.timeline.totalFrames / compiled.timeline.fps) * 1000),
    frames: compiled.timeline.totalFrames,
    renderMs: report.renderMs,
    bundleMs: report.bundleMs,
  };
}
