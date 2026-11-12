import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderFixtureRun } from "../pipeline/render-fixture";
import { ArtifactKeys, LocalArtifactStore, RunLockedError } from "../storage";

/**
 * `render-fixture --file <plan.json> [--force]`: compile, render and validate a fixture plan with
 * SYNTHETIC SILENT timing. Prints progress while it works. Never calls a provider.
 */
export async function runRenderFixtureCommand(opts: {
  file: string;
  force: boolean;
  projectRoot: string;
  runsDir: string;
  print: (lines: string[]) => void;
}): Promise<{ ok: boolean; lines: string[] }> {
  const lines = [
    "ByteReel fixture render (FIXTURE · SILENT · SYNTHETIC TIMING: not a live generation result)",
    `File: ${opts.file}`,
  ];
  opts.print(lines.splice(0));

  let input: unknown;
  try {
    input = JSON.parse(await readFile(path.resolve(opts.projectRoot, opts.file), "utf8"));
  } catch (error) {
    return { ok: false, lines: [`ERROR: could not read the fixture as JSON: ${(error as Error).message}`] };
  }

  const store = new LocalArtifactStore(opts.runsDir);
  const started = Date.now();
  let result;
  try {
    result = await renderFixtureRun({ input, store, force: opts.force, onProgress: (message) => opts.print([`  ... ${message}`]) });
  } catch (error) {
    if (error instanceof RunLockedError) return { ok: false, lines: [`ERROR: ${error.message}`] };
    throw error;
  }

  if (result.status === "invalid") {
    return { ok: false, lines: [`Plan: INVALID (${result.message})`, ...result.details.map((d, i) => `  ${i + 1}. ${d}`), "Nothing was rendered."] };
  }
  const relDir = path.relative(opts.projectRoot, result.runDir);
  if (result.status === "already-rendered") {
    return {
      ok: true,
      lines: [`Run ${relDir}/ is already rendered and its artifacts match their hashes (state "${result.manifest.state}").`, "Nothing to do. Use --force to render again."],
    };
  }
  if (result.status === "needs-input") {
    return { ok: false, lines: [`NEEDS INPUT (compile): ${result.message}`, `Run state: "${result.manifest.state}". See ${relDir}/manifest.json.`] };
  }
  if (result.status === "failed") {
    const qaLines = result.qa ? result.qa.checks.map((c) => `  [${c.ok ? "ok" : "fail"}] ${c.name}: expected ${c.expected}, got ${c.actual}`) : [];
    return { ok: false, lines: [`FAILED at ${result.stage}: ${result.message}`, ...qaLines, `Run state: "${result.manifest.state}". See ${relDir}/manifest.json.`] };
  }

  const { timeline } = result.compiled;
  const { measured } = result.qa;
  const output = result.manifest.artifacts[ArtifactKeys.output]!;
  return {
    ok: true,
    lines: [
      `Compile: ${timeline.totalFrames} frames = ${(timeline.totalFrames / timeline.fps).toFixed(2)} s, ${timeline.scenes.length} scenes, ${result.compiled.captions.captions.length} captions`,
      `Render: ${(result.render.renderMs / 1000).toFixed(1)} s (bundle ${(result.render.bundleMs / 1000).toFixed(1)} s, previews ${(result.render.stillsMs / 1000).toFixed(1)} s); total ${((Date.now() - started) / 1000).toFixed(1)} s`,
      "Validate:",
      ...result.qa.checks.map((c) => `  [${c.ok ? "ok" : "fail"}] ${c.name}: ${c.actual}`),
      `Output: ${relDir}/${ArtifactKeys.output} (${(output.bytes / 1024 / 1024).toFixed(2)} MB, ${measured.codec}, ${measured.width}x${measured.height}, ${measured.frameRate} fps)`,
      `Previews: ${relDir}/preview-frames/ (${result.render.previews.length} PNGs)`,
      `Run state: "${result.manifest.state}" (timing source: ${result.manifest.timingSource}). Human review still required; this is NOT a live result.`,
    ],
  };
}
