import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { CaptionTrack, Timeline } from "../contracts";

/**
 * Local Remotion rendering (PIPELINE_DESIGN.md §8 "Render" stage). Uses Remotion's own
 * chrome-headless-shell (downloaded once into node_modules/.remotion) and its bundled ffmpeg.
 * Rendering never calls AI providers; the composition draws only the compiled timeline.
 */

export const VIDEO_ENTRY = path.resolve(import.meta.dirname, "../../../../src/video/index.ts");
export const COMPOSITION_ID = "Explainer";

export interface RenderJob {
  timeline: Timeline;
  captions: CaptionTrack;
  /** Final MP4 path (written by Remotion; the caller moves it into the artifact store). */
  outputPath: string;
  /** Frames to save as PNG previews: id -> absolute frame. */
  previewFrames: { id: string; frame: number }[];
  previewDir: string;
  /**
   * Folder whose files are served to the composition (Remotion publicDir). For live runs it holds
   * `audio/<scene-id>.mp3`, which the composition plays via staticFile(scene.audioKey). null = none.
   */
  publicDir?: string | null;
  onProgress?: (message: string) => void;
}

export interface RenderReport {
  bundleMs: number;
  renderMs: number;
  stillsMs: number;
  previews: { id: string; frame: number; path: string }[];
}

export async function renderExplainer(job: RenderJob): Promise<RenderReport> {
  const log = job.onProgress ?? (() => undefined);
  const inputProps = { timeline: job.timeline, captions: job.captions };
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "bytereel-bundle-"));

  try {
    let started = Date.now();
    log("Bundling the Remotion composition...");
    const serveUrl = await bundle({ entryPoint: VIDEO_ENTRY, outDir: bundleDir, enableCaching: true, publicDir: job.publicDir ?? null });
    const bundleMs = Date.now() - started;

    const browser = await openBrowser("chrome", { logLevel: "error" });
    try {
      const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, puppeteerInstance: browser, logLevel: "error" });
      if (composition.durationInFrames !== job.timeline.totalFrames) {
        throw new Error(`composition is ${composition.durationInFrames} frames but the timeline has ${job.timeline.totalFrames}`);
      }

      started = Date.now();
      let lastReported = -1;
      await renderMedia({
        serveUrl,
        composition,
        inputProps,
        codec: "h264",
        pixelFormat: "yuv420p",
        crf: 20,
        // Narration is decoded once from the scene MP3s, mixed at each scene start and encoded once to AAC.
        audioCodec: "aac",
        audioBitrate: "192k",
        outputLocation: job.outputPath,
        puppeteerInstance: browser,
        overwrite: true,
        logLevel: "error",
        onProgress: ({ progress }) => {
          const percent = Math.floor(progress * 10) * 10;
          if (percent > lastReported) {
            lastReported = percent;
            log(`Rendering video: ${percent}%`);
          }
        },
      });
      const renderMs = Date.now() - started;

      started = Date.now();
      await fs.mkdir(job.previewDir, { recursive: true });
      const previews: RenderReport["previews"] = [];
      for (const { id, frame } of job.previewFrames) {
        const output = path.join(job.previewDir, `${id}.png`);
        await renderStill({ serveUrl, composition, inputProps, frame, output, imageFormat: "png", puppeteerInstance: browser, overwrite: true, logLevel: "error" });
        previews.push({ id, frame, path: output });
      }
      log(`Saved ${previews.length} preview frames.`);
      return { bundleMs, renderMs, stillsMs: Date.now() - started, previews };
    } finally {
      await browser.close({ silent: true });
    }
  } finally {
    await fs.rm(bundleDir, { recursive: true, force: true });
  }
}
