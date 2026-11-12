import type { Manifest } from "../contracts";
import { hashPlan, validatePlan, type PlanStats, type ValidationIssue } from "../planning";
import { ArtifactKeys, type ArtifactStore, type RunRef } from "../storage";
import {
  createManifest,
  loadManifest,
  recordArtifact,
  saveManifest,
  setPlanHash,
  transitionRun,
  updateStage,
} from "./manifest";

/**
 * P0 fixture run: validate a fixture plan, hash it, create the run folder and manifest,
 * and store plan.json. No provider is called; fixture runs are marked `fixture: true`
 * and must never be reported as live results.
 */

export type FixtureRunResult =
  | { status: "invalid"; stage: "schema" | "semantic"; issues: ValidationIssue[]; stats: PlanStats | null }
  | { status: "created" | "unchanged"; run: RunRef; runDir: string; planHash: string; stats: PlanStats; manifest: Manifest }
  | { status: "conflict"; run: RunRef; runDir: string; planHash: string; existingPlanHash: string | null };

export interface FixtureRunOptions {
  input: unknown;
  store: ArtifactStore;
  now?: () => Date;
}

export async function runFixture({ input, store, now = () => new Date() }: FixtureRunOptions): Promise<FixtureRunResult> {
  const validation = validatePlan(input);
  if (!validation.ok) {
    // Nothing is written for an invalid plan.
    return { status: "invalid", stage: validation.stage, issues: validation.issues, stats: validation.stats };
  }

  const { plan, stats } = validation;
  const run: RunRef = { ownerId: plan.ownerId, projectId: plan.projectId, versionId: plan.versionId };
  const planHash = hashPlan(plan);
  const runDir = store.describeRun(run);

  const writer = await store.acquireWriter(run); // throws RunLockedError if another writer is active
  try {
    const existing = await loadManifest(store, run);
    if (existing) {
      // A version is immutable: same plan -> nothing to do; different plan -> needs a new versionId.
      if (existing.planHash === planHash) return { status: "unchanged", run, runDir, planHash, stats, manifest: existing };
      return { status: "conflict", run, runDir, planHash, existingPlanHash: existing.planHash };
    }

    let manifest = createManifest({
      run,
      parentVersionId: plan.parentVersionId,
      sceneIds: plan.scenes.map((scene) => scene.id),
      fixture: true,
      now: now(),
    });
    manifest = updateStage(manifest, "preflight", "skipped", now(), "fixture mode: no provider credentials needed");
    manifest = updateStage(manifest, "plan", "running", now(), "fixture plan supplied from file (no planner call)");
    await saveManifest(writer, manifest);

    const written = await writer.writeJson(ArtifactKeys.plan, plan);
    manifest = recordArtifact(manifest, written, now());
    manifest = setPlanHash(manifest, planHash, now());
    manifest = updateStage(
      manifest,
      "plan",
      "succeeded",
      now(),
      `plan valid: ${stats.sceneCount} scenes, ${stats.wordCount} words, about ${stats.estimatedSeconds} s estimated`,
    );
    manifest = transitionRun(manifest, "awaiting-approval", "fixture plan validated; waiting for explicit approval", now());
    await saveManifest(writer, manifest);

    return { status: "created", run, runDir, planHash, stats, manifest };
  } finally {
    await writer.release();
  }
}
