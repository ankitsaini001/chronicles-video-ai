import { redactSecrets } from "../config/config";
import type { Manifest, Plan, VoicePreset } from "../contracts";
import {
  formatIssue,
  hashPlan,
  planWithRepair,
  renderPlanReview,
  totalUsage,
  type PlanAttempt,
  type PlanStats,
  type TopicFile,
  type ValidationIssue,
} from "../planning";
import { adviceFor, ProviderError, type PlannerProvider, type TokenUsage } from "../providers";
import { ArtifactKeys, type ArtifactStore, type RunRef } from "../storage";
import { createManifest, recordArtifact, saveManifest, setPlanHash, setScenes, transitionRun, updateStage } from "./manifest";
import { FIRST_VERSION_ID, formatRunId, LOCAL_OWNER_ID, newProjectId } from "./run-id";

/**
 * Live Plan stage (PIPELINE_DESIGN.md §8): create a new run (owner, project and version IDs come
 * from code), call the planner with one bounded repair, validate, write plan.json and
 * plan-review.html, record the canonical plan hash, and leave the run `awaiting-approval`.
 *
 * - Still invalid after the repair: plan stage failed, run `needs-input`, no plan.json written.
 * - Provider failure (after retries, or fatal): plan stage failed, run `failed`.
 * Diagnostics never contain secrets (they pass through redactSecrets in the manifest helpers).
 */

export function approveCommandFor(runId: string, planHash: string): string {
  return `npm run pipeline -- approve --run ${runId} --plan-hash ${planHash}`;
}

interface RunInfo {
  run: RunRef;
  runId: string;
  runDir: string;
  manifest: Manifest;
  attempts: PlanAttempt[];
  usage: TokenUsage;
}

export type PlanRunResult =
  | (RunInfo & { status: "awaiting-approval"; plan: Plan; planHash: string; stats: PlanStats; repaired: boolean; ignoredFields: string[] })
  | (RunInfo & { status: "needs-input"; issues: ValidationIssue[]; stats: PlanStats | null })
  | (RunInfo & { status: "failed"; message: string; errorKind: string });

export interface PlanRunOptions {
  store: ArtifactStore;
  provider: PlannerProvider;
  topic: TopicFile;
  voicePreset: VoicePreset;
  ownerId?: string;
  /** Injectable for tests; defaults to a slug of the topic title plus random hex. */
  projectId?: string;
  now?: () => Date;
  onProgress?: (message: string) => void;
}

export async function runPlanStage(options: PlanRunOptions): Promise<PlanRunResult> {
  const { store, provider, topic, voicePreset, now = () => new Date(), onProgress = () => undefined } = options;
  const run: RunRef = {
    ownerId: options.ownerId ?? LOCAL_OWNER_ID,
    projectId: options.projectId ?? newProjectId(topic.title),
    versionId: FIRST_VERSION_ID,
  };
  const runId = formatRunId(run);
  const runDir = store.describeRun(run);

  const writer = await store.acquireWriter(run);
  try {
    if (await store.exists(run, ArtifactKeys.manifest)) {
      throw new Error(`run ${runId} already exists; a new plan always gets a new project ID`);
    }
    let manifest = createManifest({ run, parentVersionId: null, sceneIds: [], fixture: false, now: now() });
    manifest = updateStage(manifest, "preflight", "running", now());
    manifest = updateStage(manifest, "preflight", "succeeded", now(), `planner configured: ${provider.name} model ${provider.model} (presence check only; network check is \`preflight --network\`)`);
    manifest = updateStage(manifest, "plan", "running", now(), `live planner: ${provider.name} ${provider.model}; topic ${topic.sourceName}; voice ${voicePreset}`);
    await saveManifest(writer, manifest);
    onProgress(`Run ${runId} created`);

    let attempts: PlanAttempt[] = [];
    let result;
    try {
      result = await planWithRepair({
        provider,
        topic,
        voicePreset,
        ids: { ownerId: run.ownerId, projectId: run.projectId, versionId: run.versionId, parentVersionId: null },
        onProgress,
      });
      attempts = result.attempts;
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null;
      const message = providerError ? `${providerError.message.replace(/\.+$/, "")}. ${adviceFor(providerError)}` : `planner failed: ${(error as Error).message}`;
      manifest = updateStage(manifest, "plan", "failed", now(), message);
      manifest = transitionRun(manifest, "failed", `plan stage failed (${providerError?.kind ?? "error"})`, now());
      await saveManifest(writer, manifest);
      return { status: "failed", run, runId, runDir, manifest, attempts, usage: totalUsage(attempts), message, errorKind: providerError?.kind ?? "error" };
    }

    for (const line of attemptDiagnostics(result.attempts)) manifest = addDiagnostic(manifest, line);
    const usage = totalUsage(result.attempts);

    if (result.status === "needs-input") {
      const shown = result.issues.slice(0, 25).map(formatIssue);
      const more = result.issues.length > shown.length ? [`... and ${result.issues.length - shown.length} more`] : [];
      manifest = addDiagnostic(manifest, `plan still invalid after ${result.attempts.length} attempts (${result.issues.length} problems):`);
      for (const line of [...shown, ...more]) manifest = addDiagnostic(manifest, `  ${line}`);
      manifest = updateStage(manifest, "plan", "failed", now(), "planner output failed validation after one repair attempt; needs input (adjust the topic notes or prompts and plan again)");
      manifest = transitionRun(manifest, "needs-input", "planner output invalid after one repair attempt", now());
      await saveManifest(writer, manifest);
      return { status: "needs-input", run, runId, runDir, manifest, attempts, usage, issues: result.issues, stats: result.stats };
    }

    const { plan, stats, repaired } = result;
    const planHash = hashPlan(plan);
    const ignoredFields = [...new Set(result.attempts.flatMap((a) => a.ignoredFields))];
    manifest = recordArtifact(manifest, await writer.writeJson(ArtifactKeys.plan, plan), now());
    manifest = setPlanHash(manifest, planHash, now());
    manifest = setScenes(manifest, plan.scenes.map((s) => s.id), now());

    const lastModel = result.attempts.at(-1)?.model ?? provider.model;
    const review = renderPlanReview({
      plan,
      planHash,
      stats,
      runId,
      plannerModel: `${provider.name} ${lastModel}`,
      generatedAt: now().toISOString(),
      plannerNote: repaired ? "repaired once after validation errors" : null,
      approveCommand: approveCommandFor(runId, planHash),
    });
    manifest = recordArtifact(manifest, await writer.write(ArtifactKeys.planReview, review), now());
    manifest = updateStage(
      manifest,
      "plan",
      "succeeded",
      now(),
      `plan valid${repaired ? " after one repair" : ""}: ${stats.sceneCount} scenes, ${stats.wordCount} words, about ${stats.estimatedSeconds} s estimated, ` +
        `${plan.warnings.length} warning(s); tokens ${formatUsage(usage)}` +
        (ignoredFields.length ? `; ignored model-supplied reserved fields: ${ignoredFields.join(", ")}` : ""),
    );
    manifest = transitionRun(manifest, "awaiting-approval", `live plan ${planHash} written; waiting for explicit approval`, now());
    await saveManifest(writer, manifest);
    return { status: "awaiting-approval", run, runId, runDir, manifest, attempts, usage, plan, planHash, stats, repaired, ignoredFields };
  } finally {
    await writer.release();
  }
}

function addDiagnostic(manifest: Manifest, line: string): Manifest {
  const plan = manifest.stages.plan;
  return { ...manifest, stages: { ...manifest.stages, plan: { ...plan, diagnostics: [...plan.diagnostics, redactSecrets(line)] } } };
}

function attemptDiagnostics(attempts: readonly PlanAttempt[]): string[] {
  return attempts.map(
    (a) =>
      `attempt ${a.attempt} (${a.kind}): model ${a.model}, finish ${a.finishReason ?? "?"}, ${a.valid ? "valid" : `${a.issueCount} problem(s)`}, ` +
      `${(a.durationMs / 1000).toFixed(1)} s, ${a.retries} transient retr${a.retries === 1 ? "y" : "ies"}, tokens ${formatUsage(a.usage)}`,
  );
}

export function formatUsage(usage: TokenUsage | null): string {
  if (!usage) return "not reported";
  const part = (label: string, value: number | null) => (value === null ? null : `${label} ${value}`);
  return [part("prompt", usage.promptTokens), part("output", usage.outputTokens), part("thinking", usage.thinkingTokens), part("total", usage.totalTokens)]
    .filter(Boolean)
    .join(", ") || "not reported";
}
