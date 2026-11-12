import fs from "node:fs/promises";
import path from "node:path";
import type { Manifest, StageName } from "../contracts";
import { hashPlan, validatePlan } from "../planning";
import { ArtifactKeys, type LocalArtifactStore, type RunRef, type RunWriter } from "../storage";
import {
  AlignmentMappingError,
  AlignmentValidationError,
  CompileInputError,
  compileTimeline,
  DEFAULT_HOLDS,
  DEFAULT_SYNTHETIC_TIMING,
  DurationOutOfRangeError,
  synthesizeSceneAlignment,
  type CompileResult,
  type SyntheticTimingOptions,
} from "../timing";
import { evaluateProbe, probeMp4, PROBED_WITH, type Mp4Probe, type QaReport } from "../validation";
import { checkGenerationGate } from "./approval-gate";
import { runFixture } from "./fixture-run";
import { loadManifest, recordArtifact, saveManifest, transitionRun, updateSceneSpeech, updateStage } from "./manifest";
import type { RenderJob, RenderReport } from "./render";

/**
 * P1 fixture render: Compile -> Render -> Validate (PIPELINE_DESIGN.md §8) for a fixture plan,
 * using a SYNTHETIC, SILENT timing fixture instead of real speech.
 *
 * - Everything is written through the artifact store (atomic writes, single writer lock).
 * - The manifest records every stage; the run is marked `timingSource: "synthetic-silent-fixture"`.
 * - Approval and speech are recorded as *skipped* (fixture plan, no audio). This command never
 *   calls a provider, and its output is never a live result.
 * - Compile problems that need a plan change (duration outside 60-90 s, unmappable text) move the
 *   run to `needs-input`; render/validation problems move it to `failed`.
 * - Only output that passes MP4 validation is marked `ready-for-review`.
 */

export type RenderFixtureResult =
  | { status: "invalid"; message: string; details: string[] }
  | { status: "already-rendered"; runDir: string; manifest: Manifest }
  | { status: "needs-input"; runDir: string; message: string; manifest: Manifest }
  | { status: "failed"; runDir: string; stage: StageName; message: string; manifest: Manifest; qa?: QaReport }
  | { status: "ready-for-review"; runDir: string; manifest: Manifest; qa: QaReport; render: RenderReport; compiled: CompileResult };

export interface RenderFixtureOptions {
  input: unknown;
  store: LocalArtifactStore;
  /** Re-render a run that is already ready-for-review. */
  force?: boolean;
  now?: () => Date;
  onProgress?: (message: string) => void;
  /** Synthetic timing settings (defaults to DEFAULT_SYNTHETIC_TIMING). */
  syntheticTiming?: SyntheticTimingOptions;
  /** Injectable for tests. */
  render?: (job: RenderJob) => Promise<RenderReport>;
  probe?: (filePath: string) => Promise<Mp4Probe>;
}

const FIXTURE_NOTE = "FIXTURE: synthetic silent timing, not a live result";

export async function renderFixtureRun(options: RenderFixtureOptions): Promise<RenderFixtureResult> {
  const { store, now = () => new Date(), onProgress = () => undefined } = options;
  // Loaded lazily: the Remotion bundler is heavy and only needed when actually rendering.
  const render = options.render ?? (async (job: RenderJob) => (await import("./render")).renderExplainer(job));
  const probe = options.probe ?? probeMp4;
  const timing = options.syntheticTiming ?? DEFAULT_SYNTHETIC_TIMING;

  // P0 step: validate the plan and create (or reuse) the run folder.
  const created = await runFixture({ input: options.input, store, now });
  if (created.status === "invalid") {
    return { status: "invalid", message: `plan failed ${created.stage} validation`, details: created.issues.map((i) => `${i.path}: ${i.message}`) };
  }
  if (created.status === "conflict") {
    return { status: "invalid", message: `run ${created.runDir} already holds a different plan; give the edited plan a new versionId`, details: [] };
  }
  const validation = validatePlan(options.input);
  if (!validation.ok) throw new Error("internal: plan validated once but not twice");
  const plan = validation.plan;
  const run: RunRef = created.run;
  const runDir = created.runDir;

  const writer = await store.acquireWriter(run);
  let manifest = (await loadManifest(store, run))!;
  const save = async () => saveManifest(writer, manifest);
  try {
    // Render gating: a live (non-fixture) run is never rendered here, and never without approval.
    if (!manifest.fixture) {
      const gate = await checkGenerationGate(store, run);
      const reason = gate.allowed
        ? "approved live runs are generated with `generate` (real speech), never with synthetic fixture timing"
        : gate.reason;
      return { status: "invalid", message: `refusing to render live run ${runDir}: ${reason}`, details: [] };
    }
    if (manifest.state === "ready-for-review") {
      if (!options.force && (await outputStillValid(store, run, manifest))) {
        return { status: "already-rendered", runDir, manifest };
      }
      manifest = transitionRun(manifest, "needs-input", options.force ? "re-render requested (--force)" : "stored output no longer matches its hash; re-rendering", now());
    }
    if (!["awaiting-approval", "needs-input", "failed"].includes(manifest.state)) {
      return { status: "failed", runDir, stage: "compile", message: `run is "${manifest.state}"; it cannot be rendered from this state`, manifest };
    }

    // Fixture runs have no approval and no speech: record that explicitly, never as success.
    if (manifest.stages.approve.status === "pending") {
      manifest = updateStage(manifest, "approve", "skipped", now(), "fixture mode: hand-written fixture plan, no creator approval (approve command arrives in P2)");
    }
    if (manifest.stages.speech.status === "pending") {
      manifest = updateStage(manifest, "speech", "skipped", now(), "no speech: SYNTHETIC SILENT timing fixture (no audio, invented timings)");
      for (const scene of manifest.scenes) {
        if (scene.speech.status === "pending") manifest = updateSceneSpeech(manifest, scene.id, "skipped", now(), "synthetic silent timing fixture");
      }
    }
    for (const stage of ["compile", "render", "validate"] as const) {
      if (manifest.stages[stage].status === "succeeded" || manifest.stages[stage].status === "failed") {
        manifest = updateStage(manifest, stage, "pending", now(), "reset for a new render attempt");
      }
    }
    manifest = transitionRun(manifest, "running", `fixture render: compile -> render -> validate (${FIXTURE_NOTE})`, now());
    await save();

    // ---------- Compile ----------
    onProgress("Compile: synthetic silent timing -> timeline + captions");
    manifest = updateStage(manifest, "compile", "running", now());
    await save();
    let compiled: CompileResult;
    try {
      const alignments = Object.fromEntries(plan.scenes.map((scene) => [scene.id, synthesizeSceneAlignment(scene, plan.language, timing)]));
      for (const alignment of Object.values(alignments)) {
        manifest = recordArtifact(manifest, await writer.writeJson(ArtifactKeys.syntheticAlignment(alignment.sceneId), alignment), now());
      }
      compiled = compileTimeline({ plan, planHash: hashPlan(plan), alignments, holds: DEFAULT_HOLDS });
    } catch (error) {
      const message = (error as Error).message;
      const planProblem =
        error instanceof DurationOutOfRangeError || error instanceof AlignmentMappingError ||
        error instanceof AlignmentValidationError || error instanceof CompileInputError;
      manifest = updateStage(manifest, "compile", "failed", now(), message);
      manifest = transitionRun(manifest, planProblem ? "needs-input" : "failed", planProblem ? `return for plan adjustment: ${message}` : message, now());
      await save();
      return planProblem ? { status: "needs-input", runDir, message, manifest } : { status: "failed", runDir, stage: "compile", message, manifest };
    }
    manifest = recordArtifact(manifest, await writer.writeJson(ArtifactKeys.timeline, compiled.timeline), now());
    manifest = recordArtifact(manifest, await writer.writeJson(ArtifactKeys.captions, compiled.captions), now());
    manifest = { ...manifest, timingSource: compiled.timeline.timingSource };
    const seconds = (compiled.timeline.totalFrames / compiled.timeline.fps).toFixed(2);
    manifest = updateStage(
      manifest,
      "compile",
      "succeeded",
      now(),
      `${compiled.timeline.totalFrames} frames (${seconds} s), ${compiled.timeline.scenes.length} scenes, ${compiled.captions.captions.length} captions; ` +
        `SYNTHETIC SILENT timing at ${timing.wordsPerSecond} words/s; holds ${DEFAULT_HOLDS.sceneHoldMs} ms/scene, ${DEFAULT_HOLDS.takeawayHoldMs} ms takeaway`,
    );
    await save();

    // ---------- Render ----------
    onProgress("Render: Remotion -> output.mp4 + preview frames");
    manifest = updateStage(manifest, "render", "running", now());
    await save();
    const tempDir = path.join(store.runDir(run), ".render-tmp");
    let report: RenderReport;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.mkdir(tempDir, { recursive: true });
      const tempVideo = path.join(tempDir, "output.mp4");
      report = await render({
        timeline: compiled.timeline,
        captions: compiled.captions,
        outputPath: tempVideo,
        previewFrames: previewFramesFor(compiled),
        previewDir: path.join(tempDir, "preview-frames"),
        onProgress,
      });
      manifest = recordArtifact(manifest, await moveIntoStore(writer, ArtifactKeys.output, tempVideo), now());
      for (const preview of report.previews) {
        manifest = recordArtifact(manifest, await moveIntoStore(writer, ArtifactKeys.previewFrame(preview.id), preview.path), now());
      }
    } catch (error) {
      const message = `render failed: ${(error as Error).message}`;
      manifest = updateStage(manifest, "render", "failed", now(), message);
      manifest = transitionRun(manifest, "failed", message, now());
      await save();
      return { status: "failed", runDir, stage: "render", message, manifest };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    manifest = updateStage(
      manifest,
      "render",
      "succeeded",
      now(),
      `rendered ${compiled.timeline.totalFrames} frames in ${(report.renderMs / 1000).toFixed(1)} s (bundle ${(report.bundleMs / 1000).toFixed(1)} s, ` +
        `${report.previews.length} preview frames ${(report.stillsMs / 1000).toFixed(1)} s); ${FIXTURE_NOTE}`,
    );
    await save();

    // ---------- Validate ----------
    onProgress("Validate: probing output.mp4");
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
        liveResult: false,
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
      return { status: "failed", runDir, stage: "validate", message, manifest };
    }
    if (!qa.ok) {
      const failed = qa.checks.filter((c) => !c.ok).map((c) => `${c.name}: expected ${c.expected}, got ${c.actual}`).join("; ");
      manifest = updateStage(manifest, "validate", "failed", now(), `MP4 checks failed: ${failed}`);
      manifest = transitionRun(manifest, "failed", "output video failed validation; it cannot be marked ready for review", now());
      await save();
      return { status: "failed", runDir, stage: "validate", message: failed, manifest, qa };
    }
    manifest = updateStage(manifest, "validate", "succeeded", now(), `all ${qa.checks.length} MP4 checks passed (${PROBED_WITH})`);
    manifest = transitionRun(manifest, "ready-for-review", `MP4 valid. ${FIXTURE_NOTE}; human review still required`, now());
    await save();
    return { status: "ready-for-review", runDir, manifest, qa, render: report, compiled };
  } finally {
    await writer.release();
  }
}

/**
 * One preview per scene: shortly after its last event (or at 80% of a scene without events),
 * moved back if needed so a caption is on screen.
 */
export function previewFramesFor(compiled: CompileResult): { id: string; frame: number }[] {
  return compiled.timeline.scenes.map((scene, index) => {
    const sceneEnd = scene.startFrame + scene.durationFrames;
    const lastEvent = scene.events.reduce((max, e) => Math.max(max, e.endFrame), scene.startFrame);
    let frame = Math.min(sceneEnd - 1, scene.events.length ? lastEvent + 10 : scene.startFrame + Math.floor(scene.durationFrames * 0.8));
    const caption = compiled.captions.captions.filter((c) => c.sceneId === scene.sceneId && c.startFrame <= frame).at(-1);
    if (caption && frame >= caption.endFrame) frame = caption.endFrame - 1;
    return { id: `${String(index + 1).padStart(2, "0")}-${scene.sceneId}`.slice(0, 64), frame };
  });
}

async function moveIntoStore(writer: RunWriter, key: string, sourcePath: string) {
  const written = await writer.write(key, await fs.readFile(sourcePath));
  await fs.rm(sourcePath, { force: true });
  return written;
}

async function outputStillValid(store: LocalArtifactStore, run: RunRef, manifest: Manifest): Promise<boolean> {
  for (const key of [ArtifactKeys.output, ArtifactKeys.timeline, ArtifactKeys.captions, ArtifactKeys.qa]) {
    const record = manifest.artifacts[key];
    if (!record || !(await store.verify(run, key, record.sha256))) return false;
  }
  return true;
}
