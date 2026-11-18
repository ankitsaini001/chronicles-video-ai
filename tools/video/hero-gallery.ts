// First: keep Remotion's and Chrome's temporary files inside the project (runs/.tmp), never in /tmp.
import "../project-tmp";
import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { HERO_NAMES, isHeroName } from "@bytereel/pipeline/planning/hero-catalog";
import { VIDEO_ENTRY } from "@bytereel/pipeline/pipeline/render";

/**
 * Review the hero object library (F22b): renders the HeroGallery composition (3 x 4 grid of heroes,
 * animated) as PNG stills. Free and local.
 *
 *   npm run video:heroes -- --out <dir> [--names sun,cloud,...] [--frames 10,40,100]
 *
 * Without --names it renders every page of the library. The bundle goes next to --out; Remotion's
 * and Chrome's own temporary files go to runs/.tmp (tools/project-tmp.ts).
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const outDir = path.resolve(arg("out") ?? "");
  if (!arg("out")) throw new Error("usage: --out <dir> [--names a,b] [--frames 10,40]");
  const names = arg("names")?.split(",").filter(Boolean);
  for (const n of names ?? []) if (!isHeroName(n)) throw new Error(`unknown hero "${n}"`);
  const frames = (arg("frames") ?? "10,40").split(",").map(Number);
  await fs.mkdir(outDir, { recursive: true });
  const work = path.join(outDir, ".gallery-bundle");
  const serveUrl = await bundle({ entryPoint: VIDEO_ENTRY, outDir: work, enableCaching: true });
  const browser = await openBrowser("chrome", { logLevel: "error" });
  try {
    const pages = names ? [{ page: 0, names }] : Array.from({ length: Math.ceil(HERO_NAMES.length / 12) }, (_, page) => ({ page }));
    for (const props of pages) {
      const composition = await selectComposition({ serveUrl, id: "HeroGallery", inputProps: props, puppeteerInstance: browser, logLevel: "error" });
      for (const frame of frames) {
        const file = path.join(outDir, `${names ? "heroes" : `page-${props.page + 1}`}-f${frame}.png`);
        await renderStill({ serveUrl, composition, inputProps: props, frame, output: file, imageFormat: "png", puppeteerInstance: browser, overwrite: true, logLevel: "error" });
        console.log(file);
      }
    }
  } finally {
    await browser.close({ silent: true });
    await fs.rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
