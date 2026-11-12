import path from "node:path";
import { SAFE_ID_PATTERN } from "../contracts";

/**
 * Artifact storage boundary (PIPELINE_DESIGN.md §8).
 *
 * Local filesystem now; private, owner-scoped R2 later. The rest of the pipeline only
 * talks to this interface, so swapping the backend does not touch stage code.
 *
 * Paths are never taken from model output. A run is addressed by validated IDs
 * (owner/project/version) and an artifact by a key from the fixed list below.
 */

export interface RunRef {
  ownerId: string;
  projectId: string;
  versionId: string;
}

export interface WrittenArtifact {
  key: string;
  sha256: string;
  bytes: number;
}

/** Holds the single-writer lock for one run. All writes to a run go through its writer. */
export interface RunWriter {
  readonly run: RunRef;
  write(key: string, data: string | Uint8Array): Promise<WrittenArtifact>;
  writeJson(key: string, value: unknown): Promise<WrittenArtifact>;
  release(): Promise<void>;
}

export interface ArtifactStore {
  /** Take the run's writer lock. Throws RunLockedError if another writer holds it. */
  acquireWriter(run: RunRef): Promise<RunWriter>;
  read(run: RunRef, key: string): Promise<Uint8Array | null>;
  readJson(run: RunRef, key: string): Promise<unknown | null>;
  exists(run: RunRef, key: string): Promise<boolean>;
  /** Recompute an artifact's hash and compare it with the expected one (used on resume). */
  verify(run: RunRef, key: string, expectedSha256: string): Promise<boolean>;
  /** Human-readable location of a run, for CLI output. */
  describeRun(run: RunRef): string;
}

export class RunLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLockedError";
  }
}

export class InvalidArtifactKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArtifactKeyError";
  }
}

// ---------- artifact keys ----------

const SAFE_ID = SAFE_ID_PATTERN.source.slice(1, -1); // pattern without ^ and $

/** The only artifacts a run may contain (design §8 artifact layout). */
const FIXED_KEYS = new Set([
  "manifest.json",
  "plan.json",
  "plan-review.html",
  "approval.json",
  "timeline.json",
  "captions.json",
  "output.mp4",
  "qa.json",
  "evaluation.md",
]);
const PATTERN_KEYS = [
  new RegExp(`^audio/${SAFE_ID}\\.mp3$`),
  new RegExp(`^alignment/${SAFE_ID}\\.json$`),
  // Synthetic (silent, invented) timing fixtures carry ".synthetic" in their file name.
  new RegExp(`^alignment/${SAFE_ID}\\.synthetic\\.json$`),
  new RegExp(`^preview-frames/${SAFE_ID}\\.png$`),
];

/** Helpers that build valid keys from IDs. Prefer these over writing key strings by hand. */
export const ArtifactKeys = {
  manifest: "manifest.json",
  plan: "plan.json",
  planReview: "plan-review.html",
  approval: "approval.json",
  timeline: "timeline.json",
  captions: "captions.json",
  output: "output.mp4",
  qa: "qa.json",
  evaluation: "evaluation.md",
  audio: (sceneId: string) => checkedKey(`audio/${sceneId}.mp3`),
  alignment: (sceneId: string) => checkedKey(`alignment/${sceneId}.json`),
  syntheticAlignment: (sceneId: string) => checkedKey(`alignment/${sceneId}.synthetic.json`),
  previewFrame: (frameId: string) => checkedKey(`preview-frames/${frameId}.png`),
} as const;

export function isValidArtifactKey(key: string): boolean {
  return FIXED_KEYS.has(key) || PATTERN_KEYS.some((pattern) => pattern.test(key));
}

export function assertArtifactKey(key: string): void {
  if (!isValidArtifactKey(key)) {
    throw new InvalidArtifactKeyError(
      `"${key}" is not an allowed artifact. Allowed: ${[...FIXED_KEYS].join(", ")}, audio/<scene-id>.mp3, alignment/<scene-id>.json, alignment/<scene-id>.synthetic.json, preview-frames/<id>.png`,
    );
  }
}

function checkedKey(key: string): string {
  assertArtifactKey(key);
  return key;
}

export function assertRunRef(run: RunRef): void {
  for (const [field, value] of Object.entries(run)) {
    if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
      throw new InvalidArtifactKeyError(`${field} "${String(value)}" is not a safe ID (lowercase letters, digits, dashes)`);
    }
  }
}

/** runs/<owner>/<project>/<version>, relative to the store root. */
export function runRelativePath(run: RunRef): string {
  assertRunRef(run);
  return path.join(run.ownerId, run.projectId, run.versionId);
}
