import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatIssue } from "../planning";
import { runFixture } from "../pipeline";
import { LocalArtifactStore, RunLockedError } from "../storage";

/**
 * `fixture --file <plan.json>`: validate a fixture plan and create its run folder.
 * Output contains no timestamps, so the same fixture always prints the same report.
 */
export async function runFixtureCommand(opts: { file: string; projectRoot: string; runsDir: string }): Promise<{ ok: boolean; lines: string[] }> {
  const lines = ["ByteReel fixture run (FIXTURE DATA: not a live generation result)", `File: ${opts.file}`];

  let input: unknown;
  try {
    input = JSON.parse(await readFile(path.resolve(opts.projectRoot, opts.file), "utf8"));
  } catch (error) {
    lines.push(`ERROR: could not read the fixture as JSON: ${(error as Error).message}`);
    return { ok: false, lines };
  }

  const store = new LocalArtifactStore(opts.runsDir);
  let result;
  try {
    result = await runFixture({ input, store });
  } catch (error) {
    if (error instanceof RunLockedError) {
      lines.push(`ERROR: ${error.message}`);
      return { ok: false, lines };
    }
    throw error;
  }

  if (result.status === "invalid") {
    const kind = result.stage === "schema" ? "schema validation" : "semantic validation";
    lines.push(`Plan: INVALID (${kind}, ${result.issues.length} problem${result.issues.length === 1 ? "" : "s"})`);
    result.issues.forEach((issue, i) => lines.push(`  ${i + 1}. ${formatIssue(issue)}`));
    if (result.stats) lines.push(`Estimate: ${result.stats.wordCount} words, about ${result.stats.estimatedSeconds} s`);
    lines.push("Nothing was written.");
    return { ok: false, lines };
  }

  const relDir = path.relative(opts.projectRoot, result.runDir);
  if (result.status === "conflict") {
    lines.push(
      `ERROR: ${relDir} already holds a different plan (${result.existingPlanHash ?? "no hash"}).`,
      `  Plan versions are immutable. Give the edited plan a new versionId (with parentVersionId "${result.run.versionId}"),`,
      "  or delete that run folder if it was only a local experiment.",
    );
    return { ok: false, lines };
  }

  const { stats, manifest } = result;
  lines.push(
    `Plan: valid (${stats.sceneCount} scenes, ${stats.wordCount} words, about ${stats.estimatedSeconds} s estimated)`,
    `Plan hash: ${result.planHash}`,
    `Run folder: ${relDir}/ (${result.status === "created" ? "created" : "already existed with the same plan; nothing changed"})`,
    `Manifest: state "${manifest.state}", stages: preflight ${manifest.stages.preflight.status}, plan ${manifest.stages.plan.status}, approve ${manifest.stages.approve.status}`,
    `Artifacts: ${Object.keys(manifest.artifacts).sort().join(", ")} (+ manifest.json)`,
    "Next: explicit approval of this hash (approve command arrives in P2). No provider was called.",
  );
  return { ok: true, lines };
}
