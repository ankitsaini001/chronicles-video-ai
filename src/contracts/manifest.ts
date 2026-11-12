import { z } from "zod";
import { SafeIdSchema, Sha256Schema, TimestampSchema } from "./common";
import { TimingSourceSchema } from "./media";

/**
 * Local run manifest (PIPELINE_DESIGN.md §8). One manifest.json per run folder.
 * Records the run state, every stage and every scene. A file existing on disk
 * never means a stage succeeded; only the manifest says that.
 *
 * Diagnostics must never contain secrets or authorization headers.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

export const RUN_STATES = [
  "draft",
  "awaiting-approval",
  /** The reviewed plan hash was explicitly approved (approval.json); generation may start. */
  "plan-approved",
  "running",
  "needs-input",
  "failed",
  "cancelled",
  "ready-for-review",
  "approved",
] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;

export const STAGE_NAMES = [
  "preflight",
  "plan",
  "approve",
  "speech",
  "compile",
  "render",
  "validate",
  "review",
] as const;
export const StageNameSchema = z.enum(STAGE_NAMES);
export type StageName = z.infer<typeof StageNameSchema>;

export const STAGE_STATUSES = ["pending", "running", "succeeded", "failed", "skipped", "cancelled"] as const;
export const StageStatusSchema = z.enum(STAGE_STATUSES);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const StageRecordSchema = z.strictObject({
  status: StageStatusSchema,
  attempts: z.number().int().nonnegative(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  durationMs: z.number().nonnegative().nullable(),
  /** Short, human-readable notes. Never secrets. */
  diagnostics: z.array(z.string()),
});
export type StageRecord = z.infer<typeof StageRecordSchema>;

/** Per-scene progress for the stages that run once per scene (speech in P2). */
export const SceneRecordSchema = z.strictObject({
  id: SafeIdSchema,
  speech: StageRecordSchema,
});
export type SceneRecord = z.infer<typeof SceneRecordSchema>;

export const ArtifactRecordSchema = z.strictObject({
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  writtenAt: TimestampSchema,
});
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export const StateChangeSchema = z.strictObject({
  from: RunStateSchema.nullable(),
  to: RunStateSchema,
  at: TimestampSchema,
  reason: z.string(),
});
export type StateChange = z.infer<typeof StateChangeSchema>;

export const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  ownerId: SafeIdSchema,
  projectId: SafeIdSchema,
  versionId: SafeIdSchema,
  parentVersionId: SafeIdSchema.nullable(),
  /** true when created from a fixture. Fixture runs are never reported as live results. */
  fixture: z.boolean(),
  /**
   * Where compiled timing came from once the compile stage ran. "synthetic-silent-fixture" means
   * the video has no audio and invented (deterministic) timing: never a live result.
   */
  timingSource: TimingSourceSchema.nullable().default(null),
  state: RunStateSchema,
  /** Canonical hash of plan.json once a valid plan exists. */
  planHash: Sha256Schema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  stages: z.strictObject({
    preflight: StageRecordSchema,
    plan: StageRecordSchema,
    approve: StageRecordSchema,
    speech: StageRecordSchema,
    compile: StageRecordSchema,
    render: StageRecordSchema,
    validate: StageRecordSchema,
    review: StageRecordSchema,
  }),
  scenes: z.array(SceneRecordSchema),
  /**
   * Text-to-speech usage of this run, counted BEFORE each request is sent (retries included), so a
   * crash can never under-count. `charactersReported` sums what the provider said it charged.
   */
  speechUsage: z
    .strictObject({
      requests: z.number().int().nonnegative(),
      charactersSent: z.number().int().nonnegative(),
      charactersReported: z.number().int().nonnegative(),
    })
    .default({ requests: 0, charactersSent: 0, charactersReported: 0 }),
  /** Completed artifacts by key (e.g. "plan.json"), with their content hash. */
  artifacts: z.record(z.string(), ArtifactRecordSchema),
  history: z.array(StateChangeSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;
