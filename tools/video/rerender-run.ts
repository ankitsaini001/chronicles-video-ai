import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { PlanSchema, SceneAlignmentSchema } from "@bytereel/pipeline/contracts";
import { hashPlan } from "@bytereel/pipeline/planning";
import { COMPOSITION_ID, renderExplainer, RENDER_SETTINGS, VIDEO_ENTRY } from "@bytereel/pipeline/pipeline/render";
import { MUSIC_FILE, musicInputFor, synthMusicBed } from "@bytereel/pipeline/pipeline/music";
import { compileTimeline, DEFAULT_HOLDS } from "@bytereel/pipeline/timing";

/**
 * Re-render a recorded run in the current video style (F22b). FREE: no Gemini, no ElevenLabs. It
 * reads the run's approved plan.json, its recorded alignment/<scene>.json and audio/<scene>.mp3
 * (never changes them), compiles a fresh timeline (deterministic: same frames as the original), and
 * renders with the real render stage (packages/pipeline/src/pipeline/render.ts).
 *
 *   npx tsx tools/video/rerender-run.ts --run <runDir> --out <file.mp4> [--sheet <file.png>]
 *        [--no-music] [--concurrency N] [--work <dir>]
 *   Benchmarks / quick looks (same settings, no MP4 checks):
 *        --frames 0-599          render only these frames
 *        --stills 30,470,960     only PNG stills (next to --out)
 *
 * Temporary files go to --work (default: <run>/.rerender-tmp, inside the git-ignored runs/ folder).
 */

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const runDir = path.resolve(arg("run") ?? "");
  const out = path.resolve(arg("out") ?? "");
  if (!arg("run") || !arg("out")) throw new Error("usage: --run <runDir> --out <file.mp4> [--sheet <file.png>]");
  const work = path.resolve(arg("work") ?? path.join(runDir, ".rerender-tmp"));
  const music = !flag("no-music");
  const concurrency = arg("concurrency") ? Number(arg("concurrency")) : null;

  const plan = PlanSchema.parse(JSON.parse(await fs.readFile(path.join(runDir, "plan.json"), "utf8")));
  const alignments = Object.fromEntries(
    await Promise.all(plan.scenes.map(async (s) => [s.id, SceneAlignmentSchema.parse(JSON.parse(await fs.readFile(path.join(runDir, "alignment", `${s.id}.json`), "utf8")))] as const)),
  );
  const { timeline, captions } = compileTimeline({ plan, planHash: hashPlan(plan), alignments, holds: DEFAULT_HOLDS });
  try {
    const stored = JSON.parse(await fs.readFile(path.join(runDir, "timeline.json"), "utf8")) as { totalFrames: number };
    if (stored.totalFrames !== timeline.totalFrames) throw new Error(`compiled ${timeline.totalFrames} frames but the run's timeline.json has ${stored.totalFrames}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  console.log(`compiled: ${timeline.totalFrames} frames, ${timeline.scenes.length} scenes, ${captions.captions.length} captions`);
  for (const s of timeline.scenes) console.log(`  ${s.sceneId} (${s.type}): heroes ${s.heroes.map((h) => `${h.startFrame}:${h.hero ?? `icon ${h.icon}`}/${h.source}`).join(" ")}`);

  await fs.rm(work, { recursive: true, force: true });
  const publicDir = path.join(work, "public");
  await fs.mkdir(path.join(publicDir, "audio"), { recursive: true });
  for (const scene of timeline.scenes) {
    if (scene.audioKey) await fs.copyFile(path.join(runDir, scene.audioKey), path.join(publicDir, scene.audioKey));
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  const started = Date.now();
  try {
    if (arg("stills") || arg("frames")) {
      await quick({ timeline, captions, out, work, publicDir, music, concurrency });
    } else {
      const report = await renderExplainer({ timeline, captions, outputPath: out, previewFrames: [], previewDir: path.join(work, "previews"), publicDir, music, workDir: work, concurrency, onProgress: (m) => console.log(`  ${m}`) });
      const bytes = (await fs.stat(out)).size;
      console.log(`render: ${(report.renderMs / 1000).toFixed(1)} s (bundle ${(report.bundleMs / 1000).toFixed(1)} s, music ${(report.musicMs / 1000).toFixed(1)} s); total ${((Date.now() - started) / 1000).toFixed(1)} s`);
      console.log(`output: ${path.relative(ROOT, out)} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
      const sheet = arg("sheet");
      if (sheet) {
        await fs.mkdir(path.dirname(path.resolve(sheet)), { recursive: true });
        const { stdout } = await exec("python3", [path.join(ROOT, "tools/video/contact_sheet.py"), out, path.resolve(sheet)]);
        process.stdout.write(stdout);
      }
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Stills or a frame range with the same entry, settings and music as the render stage. */
async function quick(o: { timeline: ReturnType<typeof compileTimeline>["timeline"]; captions: ReturnType<typeof compileTimeline>["captions"]; out: string; work: string; publicDir: string; music: boolean; concurrency: number | null }) {
  if (o.music) await fs.writeFile(path.join(o.publicDir, MUSIC_FILE), synthMusicBed(musicInputFor(o.timeline, o.captions)));
  const inputProps = { timeline: o.timeline, captions: o.captions, music: o.music };
  let t = Date.now();
  const serveUrl = await bundle({ entryPoint: VIDEO_ENTRY, outDir: path.join(o.work, "bundle"), enableCaching: true, publicDir: o.publicDir });
  console.log(`bundle: ${((Date.now() - t) / 1000).toFixed(1)} s`);
  const browser = await openBrowser("chrome", { logLevel: "error" });
  try {
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, puppeteerInstance: browser, logLevel: "error" });
    const stills = arg("stills");
    if (stills) {
      for (const frame of stills.split(",").map(Number)) {
        const file = o.out.replace(/\.mp4$/, "") + `-${String(frame).padStart(4, "0")}.png`;
        await renderStill({ serveUrl, composition, inputProps, frame, output: file, imageFormat: "png", puppeteerInstance: browser, overwrite: true, logLevel: "error" });
        console.log(`still ${frame} -> ${path.relative(ROOT, file)}`);
      }
      return;
    }
    const [a, b] = arg("frames")!.split("-").map(Number) as [number, number];
    t = Date.now();
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
      audioCodec: "aac",
      audioBitrate: RENDER_SETTINGS.audioBitrate,
      outputLocation: o.out,
      frameRange: [a, b],
      puppeteerInstance: browser,
      concurrency: o.concurrency,
      overwrite: true,
      logLevel: "error",
    });
    const bytes = (await fs.stat(o.out)).size;
    console.log(`frames ${a}-${b}: ${((Date.now() - t) / 1000).toFixed(1)} s, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    await browser.close({ silent: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
