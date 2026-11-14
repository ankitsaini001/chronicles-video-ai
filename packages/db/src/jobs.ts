import { createHash } from "node:crypto";
import { type ClientSession, type Db, ObjectId } from "mongodb";

// Background work (docs/DATABASE.md §4.9 `jobs`, docs/API.md §8 "Asynchronous Jobs and Polling").
// F15 builds the first job type: `plan` (the AI writes the storyboard, Inngest function
// `plan-video`). A job holds the progress the creator sees, the error when it fails, and the
// planner checkpoint: every Gemini answer is saved here as soon as it arrives, so a retry never
// pays for an answer that already exists.
//
// States (ARCHITECTURE §7.3): queued → running → succeeded | failed. A retry (E2) keeps the same
// job, adds 1 to `attempt` and puts it back to `queued`. Every background write is conditional on
// "still running, same attempt", so a late write of an older attempt (or of a job the stuck-job
// rule already failed) changes nothing.

export const JOBS_COLLECTION = "jobs";
export const JOB_SCHEMA_VERSION = 1;

export type JobType = "plan" | "revise" | "generate" | "caption" | "publish";
export type JobState = "queued" | "running" | "succeeded" | "failed" | "needs_input" | "cancelled";
export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
/** Error codes a plan job can end with (API.md §4.2). */
export type PlanJobErrorCode = "PROVIDER_BUSY" | "PROVIDER_REJECTED" | "PLAN_INVALID" | "QUOTA_EXCEEDED" | "INTERNAL";

export const TERMINAL_JOB_STATES: readonly JobState[] = ["succeeded", "failed", "needs_input", "cancelled"];
/** API.md §8.1: the UI polls every 2 s while a job is active. */
export const POLL_AFTER_MS = 2000;

/** A plan job's stages (API.md §8.2): `plan` = asking the AI, `validate` = checking and saving. */
export const PLAN_STAGES = ["plan", "validate"] as const;

/** What the creator reads (API.md §4.3). Shown as is in the UI. */
export const JOB_MESSAGES = {
  QUEUED: "Writing your storyboard…",
  WRITING: "Writing your storyboard…",
  RETRYING: "Our AI is busy, trying again…",
  REPAIRING: "Fixing a few details in your storyboard…",
  SAVING: "Checking your storyboard…",
  DONE: "Your storyboard is ready.",
  PROVIDER_BUSY: "Our AI is very busy right now. Your idea is saved; please try again in a few minutes.",
  PROVIDER_REJECTED: "We can't make a video about this topic.",
  PLAN_INVALID: "Couldn't build a good storyboard, try rephrasing.",
  QUOTA_EXCEEDED: "This project has reached 20 storyboard requests. Start a new project to keep going.",
  INTERNAL: "Something went wrong on our side. Please try again.",
} as const;

/** Which failures may be retried as they are (E2 without editing the idea). A safety refusal needs a new idea. */
export const PLAN_ERROR_RETRYABLE: Record<PlanJobErrorCode, boolean> = {
  PROVIDER_BUSY: true,
  PROVIDER_REJECTED: false,
  PLAN_INVALID: true,
  QUOTA_EXCEEDED: false,
  INTERNAL: true,
};

export interface JobStage {
  name: string;
  status: StageStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  attempts: number;
  error: { code: string; message: string } | null;
}

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

/** One planner answer, saved as soon as it arrives (the paid part of the job). */
export interface PlannerAnswer {
  /** 1 = first answer, 2 = the repair. */
  n: 1 | 2;
  /** The model's raw JSON text (needed for the repair conversation and to rebuild the plan). */
  text: string;
  model: string;
  finishReason: string | null;
  usage: { promptTokens: number | null; outputTokens: number | null; thinkingTokens: number | null } | null;
  valid: boolean;
  issueCount: number;
}

/** The planner checkpoint of the current attempt (DATABASE.md §4.9, F15). */
export interface PlanCheckpoint {
  attempt: number;
  /** The idea these answers belong to (an edited idea starts over). */
  inputHash: string;
  /** The id the saved plan version gets (the plan carries it as `versionId`). */
  planVersionId: ObjectId;
  /** Gemini requests made in this attempt (at most PLAN_JOB_MAX_REQUESTS). */
  requests: number;
  answers: PlannerAnswer[];
}

export interface JobDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  projectId: ObjectId;
  schemaVersion: number;
  type: JobType;
  inputRef: { planVersionId?: ObjectId; revisionId?: ObjectId; postId?: ObjectId };
  /** sha256 of the idea the job plans from (part of the idempotency key). */
  inputHash: string;
  state: JobState;
  attempt: number;
  stages: JobStage[];
  progress: { stage: string; percent: number; message: string };
  error: JobError | null;
  needsInput: null;
  result: { planVersionId?: ObjectId } | null;
  /** `plan:{projectId}:{inputHash}` (unique). */
  idempotencyKey: string;
  inngestRunId: string | null;
  cancelRequestedAt: Date | null;
  /** The Inngest event that starts this attempt: its id (dedupe) and when it was sent. */
  event: { id: string; sentAt: Date | null; lastTriedAt: Date | null };
  planner: PlanCheckpoint | null;
  /** When the job last became `queued` (C2 or E2), for the stuck-job rule. */
  queuedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** The `Job` resource (API.md §8.2). */
export type JobResource = {
  id: string;
  projectId: string;
  type: JobType;
  state: JobState;
  attempt: number;
  stages: { name: string; status: StageStatus; startedAt: string | null; endedAt: string | null; attempts: number; error: { code: string; message: string } | null }[];
  progress: { stage: string; percent: number; message: string };
  error: JobError | null;
  needsInput: null;
  result: { planVersionId?: string } | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pollAfterMs: number | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function isTerminal(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

export function toJobResource(doc: JobDocument): JobResource {
  return {
    id: doc._id.toHexString(),
    projectId: doc.projectId.toHexString(),
    type: doc.type,
    state: doc.state,
    attempt: doc.attempt,
    stages: doc.stages.map((s) => ({ name: s.name, status: s.status, startedAt: iso(s.startedAt), endedAt: iso(s.endedAt), attempts: s.attempts, error: s.error })),
    progress: doc.progress,
    error: doc.error,
    needsInput: null,
    result: doc.result ? { ...(doc.result.planVersionId ? { planVersionId: doc.result.planVersionId.toHexString() } : {}) } : null,
    cancelRequestedAt: iso(doc.cancelRequestedAt),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    startedAt: iso(doc.startedAt),
    finishedAt: iso(doc.finishedAt),
    pollAfterMs: isTerminal(doc.state) ? null : POLL_AFTER_MS,
  };
}

/** The idea a plan job works from (projects.input + language + voice). */
export interface PlanInput {
  input: { type: string; text: string; brainstormChoice: { subject: string; title: string; hook: string } | null };
  language: string;
  voiceGender: string;
}

/** sha256 (hex) of the idea, language and voice: the same idea gives the same hash (Q6 key). */
export function planInputHash(project: PlanInput): string {
  const choice = project.input.brainstormChoice;
  const canonical = JSON.stringify([
    project.input.type,
    project.input.text,
    choice ? [choice.subject, choice.title, choice.hook] : null,
    project.language,
    project.voiceGender,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The job's idempotency key (DATABASE.md Q6), also the first Inngest event id. */
export function planJobKey(projectId: ObjectId, inputHash: string): string {
  return `plan:${projectId.toHexString()}:${inputHash}`;
}

/** The Inngest event id of a retry (API.md E2): a new id per attempt, so it is not dropped as a duplicate. */
export function retryEventId(jobId: ObjectId, attempt: number): string {
  return `${jobId.toHexString()}:retry:${attempt}`;
}

function pendingStages(): JobStage[] {
  return PLAN_STAGES.map((name) => ({ name, status: "pending" as const, startedAt: null, endedAt: null, attempts: 0, error: null }));
}

const QUEUED_PROGRESS = { stage: "plan", percent: 0, message: JOB_MESSAGES.QUEUED };

/** A new queued plan job (C2). Inserted in the same transaction as its project. */
export function newPlanJob(input: { ownerId: ObjectId; projectId: ObjectId; project: PlanInput; now: Date }): JobDocument {
  const inputHash = planInputHash(input.project);
  const key = planJobKey(input.projectId, inputHash);
  return {
    _id: new ObjectId(),
    ownerId: input.ownerId,
    projectId: input.projectId,
    schemaVersion: JOB_SCHEMA_VERSION,
    type: "plan",
    inputRef: {},
    inputHash,
    state: "queued",
    attempt: 1,
    stages: pendingStages(),
    progress: QUEUED_PROGRESS,
    error: null,
    needsInput: null,
    result: null,
    idempotencyKey: key,
    inngestRunId: null,
    cancelRequestedAt: null,
    event: { id: key, sentAt: null, lastTriedAt: null },
    planner: null,
    queuedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
    startedAt: null,
    finishedAt: null,
  };
}

const isHexId = (id: string) => /^[0-9a-f]{24}$/.test(id);

/** One job of this owner, or null (malformed id, someone else's job and a missing one look the same). */
export async function getOwnedJob(db: Db, ownerId: string, jobId: string): Promise<JobDocument | null> {
  if (!isHexId(jobId) || !isHexId(ownerId)) return null;
  return db.collection<JobDocument>(JOBS_COLLECTION).findOne({ _id: new ObjectId(jobId), ownerId: new ObjectId(ownerId) });
}

export async function getJob(db: Db, jobId: ObjectId, session?: ClientSession): Promise<JobDocument | null> {
  return db.collection<JobDocument>(JOBS_COLLECTION).findOne({ _id: jobId }, session ? { session } : {});
}

/** The project's newest plan job (the one the Try again button retries), or null. */
export async function getLatestPlanJob(db: Db, projectId: ObjectId): Promise<JobDocument | null> {
  return db.collection<JobDocument>(JOBS_COLLECTION).findOne({ projectId, type: "plan" }, { sort: { createdAt: -1 } });
}

/** Remember that the start event was (or could not be) handed to Inngest. */
export async function markJobEventSent(db: Db, jobId: ObjectId, eventId: string, ok: boolean, now: Date = new Date()): Promise<void> {
  await db
    .collection<JobDocument>(JOBS_COLLECTION)
    .updateOne({ _id: jobId, "event.id": eventId }, { $set: { "event.lastTriedAt": now, ...(ok ? { "event.sentAt": now } : {}) } });
}

/**
 * May this failed plan job be retried (E2)? A retryable error, a cancelled job, or a failure whose
 * idea was edited since (C4), even when the error itself is not retryable (PROVIDER_REJECTED).
 */
export function canRetryPlanJob(job: JobDocument, currentInputHash: string): boolean {
  if (job.type !== "plan") return false;
  if (job.state === "cancelled") return true;
  if (job.state !== "failed") return false;
  return job.error?.retryable === true || currentInputHash !== job.inputHash;
}
