import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ManifestSchema } from "../src/contracts";
import { loadManifest } from "../src/pipeline";
import { previewFramesFor, renderFixtureRun } from "../src/pipeline/render-fixture";
import type { RenderJob, RenderReport } from "../src/pipeline/render";
import { ArtifactKeys, isValidArtifactKey, LocalArtifactStore } from "../src/storage";
import { DEFAULT_SYNTHETIC_TIMING } from "../src/timing";
import { evaluateProbe, parseFfprobe, type Mp4Probe } from "../src/validation";
import { loadFixture, withTempDir } from "./helpers";

/** A fake renderer: writes placeholder bytes instead of running Remotion (fast, deterministic). */
async function fakeRender(job: RenderJob): Promise<RenderReport> {
  await writeFile(job.outputPath, "not really an mp4");
  const previews = [];
  for (const p of job.previewFrames) {
    const path = `${job.previewDir}/${p.id}.png`;
    await import("node:fs/promises").then((fs) => fs.mkdir(job.previewDir, { recursive: true }));
    await writeFile(path, `png ${p.frame}`);
    previews.push({ ...p, path });
  }
  return { bundleMs: 1, renderMs: 2, stillsMs: 3, previews };
}

const RUN = { ownerId: "fixture-owner", projectId: "fixture-water-cycle", versionId: "v1" };

const goodProbe = (frames: number): Mp4Probe => ({
  codec: "h264",
  width: 1080,
  height: 1920,
  frameRate: "30/1",
  decodedFrames: frames,
  durationSeconds: frames / 30,
  pixelFormat: "yuv420p",
  audioStreams: 0,
  audioCodec: null,
  audioDurationSeconds: null,
  audioSampleRate: null,
});

describe("render-fixture stage orchestration", () => {
  it("runs compile -> render -> validate, labels the run synthetic, and marks valid output ready-for-review", async () => {
    await withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      let probedFrames = 0;
      const result = await renderFixtureRun({
        input: loadFixture("water-cycle.plan.json"),
        store,
        render: fakeRender,
        probe: async () => goodProbe(probedFrames),
        onProgress: () => undefined,
      });
      // First run: the probe returned 0 frames, so validation must fail and the run must not be ready.
      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.stage).toBe("validate");
      expect(result.manifest.state).toBe("failed");
      expect(result.manifest.stages.validate.status).toBe("failed");
      expect(result.qa?.ok).toBe(false);

      // Retry from "failed" with a correct probe.
      const timeline = (await store.readJson(RUN, ArtifactKeys.timeline)) as { totalFrames: number };
      probedFrames = timeline.totalFrames;
      const retry = await renderFixtureRun({ input: loadFixture("water-cycle.plan.json"), store, render: fakeRender, probe: async () => goodProbe(probedFrames) });
      expect(retry.status).toBe("ready-for-review");
      const manifest = ManifestSchema.parse(await loadManifest(store, RUN));
      expect(manifest.state).toBe("ready-for-review");
      expect(manifest.fixture).toBe(true);
      expect(manifest.timingSource).toBe("synthetic-silent-fixture");
      expect(manifest.stages.approve.status).toBe("skipped");
      expect(manifest.stages.speech.status).toBe("skipped");
      expect(manifest.stages.compile.status).toBe("succeeded");
      expect(manifest.stages.render.status).toBe("succeeded");
      expect(manifest.stages.validate.status).toBe("succeeded");
      expect(manifest.stages.compile.attempts).toBe(2);
      expect(manifest.scenes.every((s) => s.speech.status === "skipped")).toBe(true);
      const keys = Object.keys(manifest.artifacts);
      expect(keys).toContain("alignment/scene-hook.synthetic.json");
      expect(keys).toEqual(expect.arrayContaining(["timeline.json", "captions.json", "output.mp4", "qa.json", "preview-frames/01-scene-hook.png"]));
      expect(keys.every(isValidArtifactKey)).toBe(true);
      const qa = (await store.readJson(RUN, ArtifactKeys.qa)) as { ok: boolean; liveResult: boolean; timingSource: string };
      expect(qa).toMatchObject({ ok: true, liveResult: false, timingSource: "synthetic-silent-fixture" });

      // Same input again: nothing to do (artifacts verified by hash).
      const again = await renderFixtureRun({ input: loadFixture("water-cycle.plan.json"), store, render: fakeRender, probe: async () => goodProbe(probedFrames) });
      expect(again.status).toBe("already-rendered");
    });
  });

  it("moves the run to needs-input (no filler) when the compiled duration is out of range", async () => {
    await withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const plan = loadFixture("water-cycle.plan.json");
      // A slow (synthetic) narrator makes the same plan longer than 90 s.
      const slow = { ...DEFAULT_SYNTHETIC_TIMING, wordsPerSecond: 2.0 };
      const result = await renderFixtureRun({ input: plan, store, syntheticTiming: slow, render: fakeRender, probe: async () => goodProbe(0) });
      expect(result.status).toBe("needs-input");
      if (result.status !== "needs-input") return;
      expect(result.message).toMatch(/too long.*Return the plan for adjustment/);
      expect(result.manifest.stages.compile.status).toBe("failed");
      expect(result.manifest.state).toBe("needs-input");
      expect(result.manifest.stages.render.status).toBe("pending");
      expect(result.manifest.artifacts["output.mp4"]).toBeUndefined();
    });
  });
});

describe("MP4 validation", () => {
  const timeline = { fps: 30, width: 1080, height: 1920, totalFrames: 2555, timingSource: "synthetic-silent-fixture" } as const;

  it("parses ffprobe JSON", () => {
    const probe = parseFfprobe(
      JSON.stringify({
        streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, r_frame_rate: "30/1", nb_read_frames: "2555", pix_fmt: "yuv420p", duration: "85.166667" }],
        format: { duration: "85.166667" },
      }),
    );
    expect(probe).toEqual({ ...goodProbe(2555), durationSeconds: 85.166667 });
  });

  it("passes a correct file and names every failed check", () => {
    const ok = evaluateProbe(goodProbe(2555), timeline as never);
    expect(ok.every((c) => c.ok)).toBe(true);
    const bad = evaluateProbe({ ...goodProbe(2554), codec: "hevc", width: 720, frameRate: "25/1", durationSeconds: 85.3, audioStreams: 1 }, timeline as never);
    const failed = bad.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(["codec", "resolution", "frame rate", "frame count", "duration matches timeline (±1 frame)", "audio (silent fixture has none)"]));
  });

  it("accepts a duration within one frame and rejects one beyond it", () => {
    const within = evaluateProbe({ ...goodProbe(2555), durationSeconds: 2555 / 30 + 0.03 }, timeline as never);
    expect(within.find((c) => c.name.startsWith("duration matches"))!.ok).toBe(true);
    const beyond = evaluateProbe({ ...goodProbe(2555), durationSeconds: 2555 / 30 + 0.04 }, timeline as never);
    expect(beyond.find((c) => c.name.startsWith("duration matches"))!.ok).toBe(false);
  });
});

describe("preview frames", () => {
  it("picks one frame per scene, inside the scene", async () => {
    const { compileTimeline, synthesizeSceneAlignment } = await import("../src/timing");
    const { validPlan } = await import("./helpers");
    const { hashPlan } = await import("../src/planning");
    const plan = validPlan();
    const compiled = compileTimeline({ plan, planHash: hashPlan(plan), alignments: Object.fromEntries(plan.scenes.map((s) => [s.id, synthesizeSceneAlignment(s, "en")])) });
    const frames = previewFramesFor(compiled);
    expect(frames).toHaveLength(plan.scenes.length);
    frames.forEach((f, i) => {
      const scene = compiled.timeline.scenes[i]!;
      expect(f.frame).toBeGreaterThanOrEqual(scene.startFrame);
      expect(f.frame).toBeLessThan(scene.startFrame + scene.durationFrames);
      expect(isValidArtifactKey(`preview-frames/${f.id}.png`)).toBe(true);
    });
  });
});
