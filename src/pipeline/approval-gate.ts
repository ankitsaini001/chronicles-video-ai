import { ApprovalSchema, PlanSchema, Sha256Schema, type Approval, type Manifest, type Plan } from "../contracts";
import { checkApproval, createApproval, hashPlan } from "../planning";
import { ArtifactKeys, type ArtifactStore, type RunRef } from "../storage";
import { loadManifest, recordArtifact, saveManifest, transitionRun, updateStage } from "./manifest";

/**
 * Approval and generation gating (PIPELINE_DESIGN.md §5, §8).
 *
 * - `approveRun` records an explicit approval of exactly the reviewed plan hash. A hash that does
 *   not match the current plan (stale review) is rejected.
 * - `checkGenerationGate` must pass before speech/render for a live (non-fixture) run: plan.json
 *   unchanged on disk, approval.json present, and its hash equal to the current plan's hash.
 *   Fixture runs keep their P1 behaviour (no approval needed, never reported as live).
 */

export const LOCAL_APPROVER = "local-developer";

// ---------- shared loading ----------

type LoadedPlan = { ok: true; plan: Plan; planHash: string } | { ok: false; reason: string };

/** Load plan.json and check it is the exact file the manifest recorded, and that it still validates. */
async function loadRecordedPlan(store: ArtifactStore, run: RunRef, manifest: Manifest): Promise<LoadedPlan> {
  const record = manifest.artifacts[ArtifactKeys.plan];
  if (!record || !manifest.planHash) return { ok: false, reason: "the run has no valid plan yet" };
  if (!(await store.verify(run, ArtifactKeys.plan, record.sha256))) {
    return { ok: false, reason: "plan.json is missing or was changed on disk after planning; plans are immutable (create a new version instead)" };
  }
  const parsed = PlanSchema.safeParse(await store.readJson(run, ArtifactKeys.plan));
  if (!parsed.success) return { ok: false, reason: "plan.json no longer matches the plan schema" };
  const planHash = hashPlan(parsed.data);
  if (planHash !== manifest.planHash) {
    return { ok: false, reason: `plan.json hashes to ${planHash}, but the manifest recorded ${manifest.planHash}` };
  }
  return { ok: true, plan: parsed.data, planHash };
}

// ---------- approve ----------

export type ApproveResult =
  | { status: "approved" | "already-approved"; approval: Approval; manifest: Manifest; runDir: string }
  | { status: "not-found" | "wrong-state" | "stale" | "invalid"; message: string };

export interface ApproveOptions {
  store: ArtifactStore;
  run: RunRef;
  /** The hash the reviewer saw in plan-review.html. */
  planHash: string;
  actor?: string;
  now?: () => Date;
}

export async function approveRun(options: ApproveOptions): Promise<ApproveResult> {
  const { store, run, now = () => new Date() } = options;
  const actor = options.actor ?? LOCAL_APPROVER;
  if (!Sha256Schema.safeParse(options.planHash).success) {
    return { status: "invalid", message: `--plan-hash must look like sha256:<64 hex characters>, got "${options.planHash}"` };
  }
  const runDir = store.describeRun(run);
  if (!(await store.exists(run, ArtifactKeys.manifest))) return { status: "not-found", message: `no run found at ${runDir}` };

  const writer = await store.acquireWriter(run);
  try {
    let manifest = (await loadManifest(store, run))!;
    if (manifest.fixture) {
      return { status: "wrong-state", message: "this is a fixture run; fixture plans are never approved (they are not live results)" };
    }
    if (manifest.state !== "awaiting-approval" && manifest.state !== "plan-approved") {
      return { status: "wrong-state", message: `run is "${manifest.state}"; only a run that is awaiting approval can be approved` };
    }
    const loaded = await loadRecordedPlan(store, run, manifest);
    if (!loaded.ok) return { status: "invalid", message: loaded.reason };
    if (options.planHash !== loaded.planHash) {
      return {
        status: "stale",
        message:
          `stale approval rejected: you reviewed ${options.planHash}, but the current plan is ${loaded.planHash}. ` +
          "Open the current plan-review.html and approve the hash shown there.",
      };
    }

    if (manifest.state === "plan-approved") {
      const existing = ApprovalSchema.safeParse(await store.readJson(run, ArtifactKeys.approval));
      if (existing.success && checkApproval(loaded.plan, existing.data).valid) {
        return { status: "already-approved", approval: existing.data, manifest, runDir };
      }
      return { status: "invalid", message: "run is marked plan-approved but approval.json is missing or does not match the plan" };
    }

    const approval = createApproval(loaded.plan, actor, now());
    manifest = updateStage(manifest, "approve", "running", now());
    manifest = recordArtifact(manifest, await writer.writeJson(ArtifactKeys.approval, approval), now());
    manifest = updateStage(manifest, "approve", "succeeded", now(), `plan ${approval.planHash} approved by ${actor}`);
    manifest = transitionRun(manifest, "plan-approved", `plan approved by ${actor}`, now());
    await saveManifest(writer, manifest);
    return { status: "approved", approval, manifest, runDir };
  } finally {
    await writer.release();
  }
}

// ---------- gate ----------

export type GenerationGate =
  | { allowed: true; fixture: boolean; plan: Plan; planHash: string; manifest: Manifest }
  | { allowed: false; reason: string };

export async function checkGenerationGate(store: ArtifactStore, run: RunRef): Promise<GenerationGate> {
  const manifest = await loadManifest(store, run);
  if (!manifest) return { allowed: false, reason: `no run found at ${store.describeRun(run)}` };
  const loaded = await loadRecordedPlan(store, run, manifest);
  if (!loaded.ok) return { allowed: false, reason: loaded.reason };
  if (manifest.fixture) return { allowed: true, fixture: true, plan: loaded.plan, planHash: loaded.planHash, manifest };

  if (manifest.state === "cancelled" || manifest.state === "approved") {
    return { allowed: false, reason: `run is "${manifest.state}"; it cannot be generated again` };
  }
  const record = manifest.artifacts[ArtifactKeys.approval];
  if (!record || manifest.stages.approve.status !== "succeeded") {
    return { allowed: false, reason: "the plan has not been approved yet. Review plan-review.html and run the approve command with its plan hash." };
  }
  if (!(await store.verify(run, ArtifactKeys.approval, record.sha256))) {
    return { allowed: false, reason: "approval.json is missing or was changed on disk after approval; approve again" };
  }
  const approval = ApprovalSchema.safeParse(await store.readJson(run, ArtifactKeys.approval));
  const check = checkApproval(loaded.plan, approval.success ? approval.data : null);
  if (!check.valid) return { allowed: false, reason: check.reason };
  return { allowed: true, fixture: false, plan: loaded.plan, planHash: loaded.planHash, manifest };
}
