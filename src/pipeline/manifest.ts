import {
  ManifestSchema,
  MANIFEST_SCHEMA_VERSION,
  STAGE_NAMES,
  type Manifest,
  type RunState,
  type StageName,
  type StageRecord,
  type StageStatus,
} from "../contracts";
import { redactSecrets } from "../config/config";
import { ArtifactKeys, type ArtifactStore, type RunRef, type RunWriter, type WrittenArtifact } from "../storage";

/**
 * Run manifest helpers (PIPELINE_DESIGN.md §8).
 *
 * All functions are pure: they return a new manifest and never mutate the input.
 * Only allowed state transitions are accepted; anything else throws InvalidTransitionError.
 */

/** Which run states may follow which. */
export const RUN_STATE_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  draft: ["awaiting-approval", "needs-input", "failed", "cancelled"],
  "awaiting-approval": ["plan-approved", "running", "needs-input", "cancelled"],
  "plan-approved": ["running", "needs-input", "cancelled"],
  running: ["ready-for-review", "needs-input", "failed", "cancelled"],
  "needs-input": ["draft", "awaiting-approval", "running", "cancelled"],
  failed: ["running", "cancelled"],
  "ready-for-review": ["approved", "needs-input", "cancelled"],
  approved: [],
  cancelled: [],
};

/** Which stage statuses may follow which. */
export const STAGE_STATUS_TRANSITIONS: Record<StageStatus, readonly StageStatus[]> = {
  pending: ["running", "skipped", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  failed: ["running", "pending", "cancelled"],
  succeeded: ["pending"], // invalidated by a revision
  skipped: ["pending"],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export interface CreateManifestInput {
  run: RunRef;
  parentVersionId: string | null;
  sceneIds: readonly string[];
  fixture: boolean;
  now: Date;
}

function emptyStage(): StageRecord {
  return { status: "pending", attempts: 0, startedAt: null, finishedAt: null, durationMs: null, diagnostics: [] };
}

export function createManifest(input: CreateManifestInput): Manifest {
  const at = input.now.toISOString();
  const stages = Object.fromEntries(STAGE_NAMES.map((name) => [name, emptyStage()])) as Manifest["stages"];
  return ManifestSchema.parse({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    ownerId: input.run.ownerId,
    projectId: input.run.projectId,
    versionId: input.run.versionId,
    parentVersionId: input.parentVersionId,
    fixture: input.fixture,
    timingSource: null,
    state: "draft",
    planHash: null,
    createdAt: at,
    updatedAt: at,
    stages,
    scenes: input.sceneIds.map((id) => ({ id, speech: emptyStage() })),
    artifacts: {},
    history: [{ from: null, to: "draft", at, reason: "run created" }],
  });
}

export function canTransition(from: RunState, to: RunState): boolean {
  return RUN_STATE_TRANSITIONS[from].includes(to);
}

export function transitionRun(manifest: Manifest, to: RunState, reason: string, now: Date): Manifest {
  if (!canTransition(manifest.state, to)) {
    const allowed = RUN_STATE_TRANSITIONS[manifest.state];
    throw new InvalidTransitionError(
      `cannot move run from "${manifest.state}" to "${to}"; allowed next states: ${allowed.length ? allowed.join(", ") : "(none, final state)"}`,
    );
  }
  const at = now.toISOString();
  return {
    ...manifest,
    state: to,
    updatedAt: at,
    history: [...manifest.history, { from: manifest.state, to, at, reason: redactSecrets(reason) }],
  };
}

function nextStageRecord(record: StageRecord, label: string, status: StageStatus, now: Date, diagnostic?: string): StageRecord {
  if (!STAGE_STATUS_TRANSITIONS[record.status].includes(status)) {
    throw new InvalidTransitionError(`cannot move ${label} from "${record.status}" to "${status}"`);
  }
  const at = now.toISOString();
  const diagnostics = diagnostic ? [...record.diagnostics, redactSecrets(diagnostic)] : record.diagnostics;
  if (status === "running") {
    return { ...record, status, attempts: record.attempts + 1, startedAt: at, finishedAt: null, durationMs: null, diagnostics };
  }
  if (status === "pending") {
    return { ...record, status, startedAt: null, finishedAt: null, durationMs: null, diagnostics };
  }
  // A finished status (succeeded, failed, skipped, cancelled): record when and how long.
  const durationMs = record.startedAt ? Math.max(0, now.getTime() - Date.parse(record.startedAt)) : null;
  return { ...record, status, finishedAt: at, durationMs, diagnostics };
}

/** Change one stage's status. Diagnostics are passed through secret redaction before being stored. */
export function updateStage(manifest: Manifest, stage: StageName, status: StageStatus, now: Date, diagnostic?: string): Manifest {
  const record = nextStageRecord(manifest.stages[stage], `stage "${stage}"`, status, now, diagnostic);
  return { ...manifest, updatedAt: now.toISOString(), stages: { ...manifest.stages, [stage]: record } };
}

/** Change one scene's speech status (used from P2 onward). */
export function updateSceneSpeech(manifest: Manifest, sceneId: string, status: StageStatus, now: Date, diagnostic?: string): Manifest {
  const index = manifest.scenes.findIndex((scene) => scene.id === sceneId);
  if (index === -1) throw new Error(`scene "${sceneId}" is not part of this run`);
  const scenes = manifest.scenes.map((scene, i) =>
    i === index ? { ...scene, speech: nextStageRecord(scene.speech, `speech for scene "${sceneId}"`, status, now, diagnostic) } : scene,
  );
  return { ...manifest, updatedAt: now.toISOString(), scenes };
}

export function recordArtifact(manifest: Manifest, written: WrittenArtifact, now: Date): Manifest {
  const at = now.toISOString();
  return {
    ...manifest,
    updatedAt: at,
    artifacts: { ...manifest.artifacts, [written.key]: { sha256: written.sha256, bytes: written.bytes, writtenAt: at } },
  };
}

/** Set the per-scene records once the plan's scenes are known (live runs learn them from the planner). */
export function setScenes(manifest: Manifest, sceneIds: readonly string[], now: Date): Manifest {
  const emptySpeech = { status: "pending", attempts: 0, startedAt: null, finishedAt: null, durationMs: null, diagnostics: [] } as const;
  return { ...manifest, updatedAt: now.toISOString(), scenes: sceneIds.map((id) => ({ id, speech: { ...emptySpeech, diagnostics: [] } })) };
}

export function setPlanHash(manifest: Manifest, planHash: string, now: Date): Manifest {
  return { ...manifest, planHash, updatedAt: now.toISOString() };
}

// ---------- persistence ----------

/** Validate and atomically write manifest.json. Requires the run's writer lock. */
export async function saveManifest(writer: RunWriter, manifest: Manifest): Promise<void> {
  await writer.writeJson(ArtifactKeys.manifest, ManifestSchema.parse(manifest));
}

/** Load manifest.json, or null if the run has none. Throws a clear error if it is corrupt. */
export async function loadManifest(store: ArtifactStore, run: RunRef): Promise<Manifest | null> {
  const raw = await store.readJson(run, ArtifactKeys.manifest);
  if (raw === null) return null;
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`manifest.json in ${store.describeRun(run)} is invalid: ${first?.path.join(".")}: ${first?.message}`);
  }
  return parsed.data;
}
