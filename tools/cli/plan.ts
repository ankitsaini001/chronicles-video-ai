import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadLocalEnvFile, readConfig } from "@bytereel/pipeline/config/config";
import { VOICE_PRESETS, type VoicePreset } from "@bytereel/pipeline/contracts";
import { formatIssue, parseTopicFile, TopicFileError, validatePlanSemantics } from "@bytereel/pipeline/planning";
import { approveCommandFor, formatUsage, runPlanStage } from "@bytereel/pipeline/pipeline";
import { GeminiPlanner, type PlannerProvider } from "@bytereel/pipeline/providers";
import { ArtifactKeys, LocalArtifactStore, RunLockedError } from "@bytereel/pipeline/storage";

/**
 * `plan --topic-file <file.md> --voice <preset>`: create a new run, ask the live planner (Gemini)
 * for a storyboard (one bounded repair), validate it, and write plan.json + plan-review.html.
 * The run is left awaiting approval; nothing is generated.
 */
export async function runPlanCommand(opts: {
  topicFile: string;
  voice: string;
  projectRoot: string;
  runsDir: string;
  print: (lines: string[]) => void;
  /** Injectable for tests (a mock planner); defaults to Gemini from .env. */
  provider?: PlannerProvider;
}): Promise<{ ok: boolean; lines: string[] }> {
  if (!(VOICE_PRESETS as readonly string[]).includes(opts.voice)) {
    return { ok: false, lines: [`Unknown --voice "${opts.voice}". Use one of: ${VOICE_PRESETS.join(", ")}`] };
  }
  const voicePreset = opts.voice as VoicePreset;

  const absolute = path.resolve(opts.projectRoot, opts.topicFile);
  const relative = path.relative(opts.projectRoot, absolute);
  const sourceName = (relative.startsWith("..") || path.isAbsolute(relative) ? path.basename(absolute) : relative).split(path.sep).join("/");
  let topic;
  try {
    topic = parseTopicFile(await readFile(absolute, "utf8"), sourceName);
  } catch (error) {
    const message = error instanceof TopicFileError ? error.message : `could not read ${opts.topicFile}: ${(error as Error).message}`;
    return { ok: false, lines: [`ERROR: ${message}`] };
  }

  let provider = opts.provider;
  if (!provider) {
    loadLocalEnvFile(path.join(opts.projectRoot, ".env"));
    const config = readConfig();
    const apiKey = config.values.GEMINI_API_KEY;
    const model = config.values.GEMINI_MODEL;
    if (!apiKey || !model) {
      return { ok: false, lines: ["ERROR: GEMINI_API_KEY and GEMINI_MODEL must be set in .env (see `npm run pipeline -- preflight`)."] };
    }
    provider = new GeminiPlanner({
      apiKey,
      model,
      retry: { onRetry: ({ attempt, waitMs, error }) => opts.print([`  ... temporary planner error (${error.message}); retry ${attempt} of 2 in ${Math.ceil(waitMs / 1000)} s`]) },
    });
  }

  opts.print([`ByteReel plan (LIVE planner: ${provider.name} ${provider.model})`, `Topic: ${topic.title} (${sourceName})`, `Voice: ${voicePreset}`]);
  const store = new LocalArtifactStore(opts.runsDir);
  let result;
  try {
    result = await runPlanStage({ store, provider, topic, voicePreset, onProgress: (m) => opts.print([`  ... ${m}`]) });
  } catch (error) {
    if (error instanceof RunLockedError) return { ok: false, lines: [`ERROR: ${error.message}`] };
    throw error;
  }

  const relDir = path.relative(opts.projectRoot, result.runDir);
  const attemptLines = result.attempts.map(
    (a) => `  attempt ${a.attempt} (${a.kind}): ${a.valid ? "valid" : `${a.issueCount} problem(s)`}, ${(a.durationMs / 1000).toFixed(1)} s, tokens ${formatUsage(a.usage)}`,
  );

  if (result.status === "failed") {
    return {
      ok: false,
      lines: [`FAILED (${result.errorKind}): ${result.message}`, ...attemptLines, `Run: ${result.runId} (state "${result.manifest.state}"). See ${relDir}/manifest.json.`],
    };
  }
  if (result.status === "needs-input") {
    return {
      ok: false,
      lines: [
        `NEEDS INPUT: the planner's storyboard was still invalid after one repair attempt (${result.issues.length} problem(s)):`,
        ...result.issues.map((issue, i) => `  ${i + 1}. ${formatIssue(issue)}`),
        ...(result.stats ? [`Estimate: ${result.stats.wordCount} words, about ${result.stats.estimatedSeconds} s`] : []),
        "Attempts:",
        ...attemptLines,
        `Gemini usage (total): ${formatUsage(result.usage)}`,
        `Run: ${result.runId} (state "needs-input"). No plan.json was written. See ${relDir}/manifest.json.`,
      ],
    };
  }

  const { plan, stats } = result;
  return {
    ok: true,
    lines: [
      `Plan: valid${result.repaired ? " (after one repair attempt)" : ""}: ${stats.sceneCount} scenes, ${stats.wordCount} words, about ${stats.estimatedSeconds} s estimated, ${plan.warnings.length} warning(s)`,
      ...validatePlanSemantics(plan).warnings.map((w) => `Review warning: ${formatIssue(w)}`),
      ...(result.ignoredFields.length ? [`Note: the model returned reserved fields that were ignored (assigned by code): ${result.ignoredFields.join(", ")}`] : []),
      "Attempts:",
      ...attemptLines,
      `Gemini usage (total): ${formatUsage(result.usage)}`,
      `Run ID:    ${result.runId}`,
      `Plan hash: ${result.planHash}`,
      `Review:    ${path.join(result.runDir, ArtifactKeys.planReview)}`,
      `Plan JSON: ${path.join(result.runDir, ArtifactKeys.plan)}`,
      `Run state: "${result.manifest.state}". Nothing is generated until the storyboard is approved:`,
      `  ${approveCommandFor(result.runId, result.planHash)}`,
    ],
  };
}
