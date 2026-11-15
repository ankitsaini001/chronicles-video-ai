import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { CaptionTrack, Timeline } from "../contracts";
import { MUSIC_FILE, musicInputFor, synthMusicBed } from "./music";

/**
 * Local Remotion rendering (PIPELINE_DESIGN.md §8 "Render" stage). Uses Remotion's own
 * chrome-headless-shell (downloaded once into node_modules/.remotion) and its bundled ffmpeg.
 * Rendering never calls AI providers; the composition draws only the compiled timeline.
 * Video style v4 (F22b): packages/video/src/Explainer.tsx.
 */

export const VIDEO_ENTRY = path.resolve(import.meta.dirname, "../../../video/src/index.ts");
export const COMPOSITION_ID = "Explainer";

/**
 * Encoding settings, tuned for render time and file size on 2026-11-15 (F22b, measurements in
 * docs/features/F22b-video-style-v4.md): JPEG frames from the browser, H.264 at CRF 26, which looked
 * the same as CRF 23 in full-size stills of this dark style at about 30% less file size.
 */
export const RENDER_SETTINGS = {
  crf: 26,
  jpegQuality: 85,
  x264Preset: "medium",
  audioBitrate: "160k",
} as const;

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
  /** Add the generated music bed (needs `publicDir`). Default false. */
  music?: boolean;
  /**
   * Folder for this render's temporary files (the Remotion bundle), inside the project. Required:
   * nothing may go to the system temp folder (shared on the founder's machine). Remotion and Chrome
   * also use the process temp folder (TMPDIR) for their own work, so every process that renders
   * sets TMPDIR inside the project too (tools/project-tmp.ts, the npm scripts, apps/web/scripts/dev.mjs).
   */
  workDir: string;
  /** Frames rendered in parallel. Default: Remotion's (half the CPU threads). */
  concurrency?: number | null;
  onProgress?: (message: string) => void;
}

export interface RenderReport {
  musicMs: number;
  bundleMs: number;
  renderMs: number;
  stillsMs: number;
  previews: { id: string; frame: number; path: string }[];
}

export async function renderExplainer(job: RenderJob): Promise<RenderReport> {
  const log = job.onProgress ?? (() => undefined);
  const music = job.music ?? false;
  if (music && !job.publicDir) throw new Error("the music bed needs a public folder");
  const inputProps = { timeline: job.timeline, captions: job.captions, music };
  await fs.mkdir(job.workDir, { recursive: true });
  const bundleDir = await fs.mkdtemp(path.join(job.workDir, "bytereel-bundle-"));

  try {
    let started = Date.now();
    if (music) {
      log("Generating the music bed...");
      await fs.writeFile(path.join(job.publicDir!, MUSIC_FILE), synthMusicBed(musicInputFor(job.timeline, job.captions)));
    }
    const musicMs = Date.now() - started;
    started = Date.now();
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
        crf: RENDER_SETTINGS.crf,
        x264Preset: RENDER_SETTINGS.x264Preset,
        imageFormat: "jpeg",
        jpegQuality: RENDER_SETTINGS.jpegQuality,
        // Narration is decoded once from the scene MP3s, mixed at each scene start (with the music bed) and encoded once to AAC.
        audioCodec: "aac",
        audioBitrate: RENDER_SETTINGS.audioBitrate,
        outputLocation: job.outputPath,
        puppeteerInstance: browser,
        concurrency: job.concurrency ?? null,
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
      return { musicMs, bundleMs, renderMs, stillsMs: Date.now() - started, previews };
    } finally {
      await browser.close({ silent: true });
    }
  } finally {
    await fs.rm(bundleDir, { recursive: true, force: true });
  }
}
