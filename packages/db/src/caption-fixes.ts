import { createHash } from "node:crypto";
import { type ClientSession, type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { CAPTION_MESSAGES } from "./caption-messages";
import { renderInputHash, type RenderToSave } from "./generate-jobs";
import { cleanIdeaText } from "./idea-text";
import { finishIdempotencyInTransaction, type IdempotencyLock } from "./idempotency";
import { getJob, JOBS_COLLECTION, retryEventId, type JobDocument, type JobStage } from "./jobs";
import { PLAN_VERSIONS_COLLECTION, type PlanVersionDocument } from "./plan-versions";
import { invalidateOpenPosts } from "./post-approval";
import { assertLanguageEnabled, POST_OPEN_PROJECT_STATES, ProjectActionError, PROJECTS_COLLECTION, type ProjectDocument } from "./projects";
import { RENDER_SCHEMA_VERSION, RENDERS_COLLECTION, type RenderDocument } from "./renders";
import { SPEECH_ARTIFACTS_COLLECTION, type SpeechArtifactDocument } from "./speech-artifacts";

// Caption fixes (F25; docs/API.md F4, E2, E3, §8; DATABASE.md §4.20 `captionOverrides`, §7.2 row 7).
// The creator fixes the TEXT of caption phrases; the narration audio stays exactly the same (PRD §6.3).
// - F4 (saveCaptionFixes), ONE transaction: a new immutable `captionOverrides` set (the previous set
//   of the same storyboard version + these fixes; a later fix of the same phrase replaces the earlier
//   one, and a fix back to the narration's own words removes it), a queued `caption` job (key
//   `cap:{setId}`), project → `generating` with `activeJobId`. NO usage counter changes: no
//   videos/day, no voice characters (decision #24a: only generate jobs count).
// - The worker (apps/web/lib/video/run-caption-job.ts) re-renders the video with the SAME recorded
//   narration (never a voice call) and the fixes applied; it shares the one-at-a-time render queue
//   with the generate jobs (Inngest VIDEO_CONCURRENCY, generate-jobs.ts VIDEO_JOB_TYPES).
// - It ends in ONE short transaction: success → a new `renders` document (the next video number,
//   `captionOverrideSetId`) that becomes the project's video; failure or cancel → the project goes
//   back to `video_ready` with the previous video still current (nothing else changes).
// - Fixes belong to their storyboard version (founder, 2026-11-16): a new storyboard version starts
//   with no fixes (a set is only carried on while `basePlanVersionId` is the video's version).
// F30: also in `scheduled` / `publish_failed`: the fix cancels the post's approval in this same
// transaction (post → `approval_invalidated` + notification; API.md §9). The job then ends the
// project at `video_ready` like any caption job.

export const CAPTION_OVERRIDES_COLLECTION = "captionOverrides";
export const CAPTION_OVERRIDE_SCHEMA_VERSION = 1;

export const CAPTION_STAGES = ["compile", "render", "validate"] as const;
export type CaptionStage = (typeof CAPTION_STAGES)[number];
const STAGE_INDEX = Object.fromEntries(CAPTION_STAGES.map((name, i) => [name, i])) as Record<CaptionStage, number>;

/** Most fixes in one save, and the longest fix (API.md F4). */
export const CAPTION_FIX_LIMITS = { edits: 50, chars: 200 } as const;

/** What the creator reads (shown as is): caption-messages.ts, shared with the Captions tab. */
export { CAPTION_MESSAGES };

export type CaptionErrorCode = "RENDER_FAILED" | "NARRATION_MISSING" | "FIX_NOT_APPLICABLE" | "INTERNAL";

/** The error a failed caption job shows, and whether Try again (E2) is offered. */
export const CAPTION_ERRORS: Record<CaptionErrorCode, { message: string; retryable: boolean }> = {
  RENDER_FAILED: { message: "We couldn't render your caption fixes. They are saved; please try again.", retryable: true },
  // Never recorded again here (a caption fix makes no voice call): the storyboard must make a new video.
  NARRATION_MISSING: { message: "This video's narration couldn't be found, so its captions can't be changed. Please edit the storyboard to make a new video.", retryable: false },
  // F25 review: a failure that would happen again on every try (the phrase no longer reads the same,
  // or a fixed line was wider than the caption box in the browser). The Captions tab stays open.
  FIX_NOT_APPLICABLE: { message: "This caption fix can't be applied. Please fix the captions again.", retryable: false },
  INTERNAL: { message: "Something went wrong on our side. Please try again.", retryable: true },
};

// ---------- F4 body ----------

/** A storyboard scene id (SAFE_ID_PATTERN in packages/pipeline/src/contracts/common.ts). */
const SafeId = z.string({ error: "must be text" }).regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { error: "is not a valid id" });
const StateVersion = z.number({ error: "must be a whole number" }).int({ error: "must be a whole number" }).min(1, { error: "must be at least 1" });

/** Caption text: cleaned like the idea (API.md §2: control and invisible characters out, NFC), single spaces, trimmed. */
export function cleanCaptionText(raw: string): string {
  return cleanIdeaText(raw).replace(/\s+/g, " ").trim();
}

const CaptionText = z
  .string({ error: "must be text" })
  .transform(cleanCaptionText)
  .pipe(z.string().min(1, { error: "can't be empty" }).max(CAPTION_FIX_LIMITS.chars, { error: `must be at most ${CAPTION_FIX_LIMITS.chars} characters` }));

/** F4 body (API.md F4), strict: 1–50 fixes, each (sceneId, phraseIndex) once, text 1–200 after cleaning. */
export const CaptionOverridesBodySchema = z
  .strictObject({
    edits: z
      .array(z.strictObject({ sceneId: SafeId, phraseIndex: z.number({ error: "must be a whole number" }).int({ error: "must be a whole number" }).min(0, { error: "must be 0 or more" }), text: CaptionText }), { error: "must be a list" })
      .min(1, { error: "must have at least one caption" })
      .max(CAPTION_FIX_LIMITS.edits, { error: `must have at most ${CAPTION_FIX_LIMITS.edits} captions` }),
    expectedStateVersion: StateVersion,
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.edits.forEach((edit, i) => {
      const pair = `${edit.sceneId}#${edit.phraseIndex}`;
      if (seen.has(pair)) ctx.addIssue({ code: "custom", path: ["edits", i, "phraseIndex"], message: "this caption is listed twice" });
      seen.add(pair);
    });
  });
export type CaptionOverridesBody = z.output<typeof CaptionOverridesBodySchema>;

// ---------- the override sets ----------

/** One fix: the phrase, the creator's text, and the compiled text it replaces (the render checks it). */
export interface CaptionOverrideItem {
  sceneId: string;
  phraseIndex: number;
  text: string;
  originalText: string;
}

export interface CaptionOverrideSetDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  projectId: ObjectId;
  schemaVersion: number;
  /** The storyboard version these fixes belong to (the video's `planVersionId`). */
  basePlanVersionId: ObjectId;
  /** The video the creator fixed (as built in F25). */
  baseRenderId: ObjectId;
  overrides: CaptionOverrideItem[];
  createdAt: Date;
}

const pairOf = (o: Pick<CaptionOverrideItem, "sceneId" | "phraseIndex">) => `${o.sceneId}#${o.phraseIndex}`;

/**
 * Pure: the new set = the previous set's fixes + these edits. A later edit of the same phrase
 * replaces the earlier one (keeping the phrase's compiled `originalText`); an edit back to the
 * compiled text removes the fix.
 */
export function mergeCaptionOverrides(previous: readonly CaptionOverrideItem[], edits: readonly CaptionOverrideItem[]): CaptionOverrideItem[] {
  const merged = new Map(previous.map((o) => [pairOf(o), { ...o }]));
  for (const edit of edits) {
    const originalText = merged.get(pairOf(edit))?.originalText ?? edit.originalText;
    if (edit.text === originalText) merged.delete(pairOf(edit));
    else merged.set(pairOf(edit), { sceneId: edit.sceneId, phraseIndex: edit.phraseIndex, text: edit.text, originalText });
  }
  return [...merged.values()];
}

/** The job's idempotency key and first event id (DATABASE.md Q6). */
export function captionJobKey(setId: ObjectId): string {
  return `cap:${setId.toHexString()}`;
}

function pendingStages(): JobStage[] {
  return CAPTION_STAGES.map((name) => ({ name, status: "pending" as const, startedAt: null, endedAt: null, attempts: 0, error: null }));
}

const WAITING_PROGRESS = { stage: "compile", percent: 0, message: CAPTION_MESSAGES.WAITING };

/** A new queued caption job (F4), inserted in the same transaction as its override set. */
export function newCaptionJob(input: { ownerId: ObjectId; projectId: ObjectId; render: Pick<RenderDocument, "_id" | "planVersionId">; set: Pick<CaptionOverrideSetDocument, "_id" | "overrides">; now: Date }): JobDocument {
  const key = captionJobKey(input.set._id);
  return {
    _id: new ObjectId(),
    ownerId: input.ownerId,
    projectId: input.projectId,
    schemaVersion: 1,
    type: "caption",
    inputRef: { planVersionId: input.render.planVersionId, renderId: input.render._id, captionOverrideSetId: input.set._id },
    inputHash: createHash("sha256").update(JSON.stringify(input.set.overrides.map((o) => [o.sceneId, o.phraseIndex, o.text])), "utf8").digest("hex"),
    state: "queued",
    attempt: 1,
    stages: pendingStages(),
    progress: WAITING_PROGRESS,
    error: null,
    needsInput: null,
    result: null,
    idempotencyKey: key,
    inngestRunId: null,
    cancelRequestedAt: null,
    event: { id: key, sentAt: null, lastTriedAt: null },
    planner: null,
    render: null,
    queuedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
    startedAt: null,
    finishedAt: null,
  };
}

// ---------- F4: save caption fixes ----------

export type SaveCaptionFixesResult = { set: CaptionOverrideSetDocument; job: JobDocument; project: ProjectDocument };

const notFoundProject = () => new ProjectActionError("NOT_FOUND", "We couldn't find this project.");
const notFoundVideo = () => new ProjectActionError("NOT_FOUND", "We couldn't find this video.");

/**
 * Pure: may this project's captions be fixed on this video now? Throws the refusal (API.md F4), in
 * this order: archived, the language switch, a job running, another tab changed it, not the
 * project's video, not `video_ready`. Used before reading the captions and again in the transaction.
 */
export function assertCaptionsFixable(project: ProjectDocument, render: Pick<RenderDocument, "_id" | "status">, expectedStateVersion: number): void {
  if (project.state === "archived") throw new ProjectActionError("INVALID_STATE", "This project is archived.", { state: project.state });
  assertLanguageEnabled(project.language);
  if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.", { activeJobId: project.activeJobId.toHexString() });
  if (project.stateVersion !== expectedStateVersion) {
    throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.", { expectedStateVersion, currentStateVersion: project.stateVersion });
  }
  if (!project.currentRenderId?.equals(render._id) || render.status !== "ready") {
    throw new ProjectActionError("INVALID_STATE", "Only your latest video's captions can be fixed.", { reason: "not_current", currentRenderId: project.currentRenderId?.toHexString() ?? null });
  }
  // F30: also while a post waits (scheduled / publish_failed); saveCaptionFixes cancels its approval.
  if (project.state !== "video_ready" && !POST_OPEN_PROJECT_STATES.includes(project.state)) {
    throw new ProjectActionError("INVALID_STATE", "Captions can be fixed once your video is ready.", { state: project.state });
  }
}

/** The project's video by id or "current" (owner AND project scoped), or null. */
async function projectRender(db: Db, project: ProjectDocument, renderId: string, session?: ClientSession): Promise<RenderDocument | null> {
  const id = renderId === "current" ? project.currentRenderId : /^[0-9a-f]{24}$/.test(renderId) ? new ObjectId(renderId) : null;
  if (!id) return null;
  return db.collection<RenderDocument>(RENDERS_COLLECTION).findOne({ _id: id, ownerId: project.ownerId, projectId: project._id }, session ? { session } : {});
}

/** The fixes already on this video that still belong to its storyboard version (else none). */
export async function currentCaptionOverrides(db: Db, render: Pick<RenderDocument, "ownerId" | "projectId" | "planVersionId" | "captionOverrideSetId">, session?: ClientSession): Promise<CaptionOverrideItem[]> {
  if (!render.captionOverrideSetId) return [];
  const set = await db
    .collection<CaptionOverrideSetDocument>(CAPTION_OVERRIDES_COLLECTION)
    .findOne({ _id: render.captionOverrideSetId, ownerId: render.ownerId, projectId: render.projectId }, session ? { session } : {});
  return set && set.basePlanVersionId.equals(render.planVersionId) ? set.overrides : [];
}

/**
 * F4 (API.md F4; DATABASE.md §7.2 row 7), ONE transaction. `edits` were checked by the caller
 * against the video's captions (each phrase exists, the text fits on screen) and carry each
 * phrase's compiled text. Checks again: the project (404), the video (404), assertCaptionsFixable
 * (409). Then: the new set (previous fixes of the same storyboard version + these; nothing changed
 * → 400), the queued caption job, project → `generating`, +1 stateVersion; F30: a `scheduled` /
 * `publish_failed` post → `approval_invalidated` (+ notification). No usage counter is touched. The
 * Inngest event is sent by the caller AFTER the commit.
 */
export async function saveCaptionFixes(
  db: Db,
  input: {
    ownerId: string;
    projectId: string;
    renderId: string;
    expectedStateVersion: number;
    edits: CaptionOverrideItem[];
    idempotencyLock?: IdempotencyLock | null;
    respond: (out: SaveCaptionFixesResult) => { status: number; body: unknown };
    now?: Date;
  },
): Promise<SaveCaptionFixesResult> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.projectId) || !/^[0-9a-f]{24}$/.test(input.ownerId)) throw notFoundProject();
  const session = db.client.startSession();
  let result: SaveCaptionFixesResult | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const project = await projects.findOne({ _id: new ObjectId(input.projectId), ownerId: new ObjectId(input.ownerId) }, { session });
      if (!project) throw notFoundProject();
      const render = await projectRender(db, project, input.renderId, session);
      if (!render) throw notFoundVideo();
      assertCaptionsFixable(project, render, input.expectedStateVersion);

      const previous = await currentCaptionOverrides(db, render, session);
      const overrides = mergeCaptionOverrides(previous, input.edits);
      if (JSON.stringify(overrides) === JSON.stringify(previous)) {
        throw new ProjectActionError("INVALID_INPUT", CAPTION_MESSAGES.NOTHING_CHANGED, { issues: input.edits.map((_e, i) => ({ path: `edits[${i}].text`, message: CAPTION_MESSAGES.NOTHING_CHANGED })) });
      }
      const set: CaptionOverrideSetDocument = {
        _id: new ObjectId(),
        ownerId: project.ownerId,
        projectId: project._id,
        schemaVersion: CAPTION_OVERRIDE_SCHEMA_VERSION,
        basePlanVersionId: render.planVersionId,
        baseRenderId: render._id,
        overrides,
        createdAt: now,
      };
      await db.collection<CaptionOverrideSetDocument>(CAPTION_OVERRIDES_COLLECTION).insertOne(set, { session });
      const job = newCaptionJob({ ownerId: project.ownerId, projectId: project._id, render, set, now });
      await db.collection<JobDocument>(JOBS_COLLECTION).insertOne(job, { session });
      const moved = await projects.findOneAndUpdate(
        { _id: project._id, stateVersion: project.stateVersion, activeJobId: null, state: project.state, currentRenderId: render._id },
        // currentRenderId is kept: the video stays the project's video until the fixed one is ready.
        { $set: { state: "generating", activeJobId: job._id, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session, returnDocument: "after" },
      );
      if (!moved) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      if (POST_OPEN_PROJECT_STATES.includes(project.state)) {
        await invalidateOpenPosts(db, session, { ownerId: project.ownerId, projectId: project._id, reason: "caption_fix", now });
      }
      result = { set, job, project: moved };
      if (input.idempotencyLock) {
        const answer = input.respond(result);
        await finishIdempotencyInTransaction(db, input.idempotencyLock, answer.status, answer.body, session);
      }
    });
  } finally {
    await session.endSession();
  }
  return result!;
}

// ---------- E2: Try again ----------

/** May this caption job be retried as it is (E2)? A retryable failure, or a cancelled job (API.md §8.4). */
export function canRetryCaptionJob(job: JobDocument): boolean {
  return job.type === "caption" && ((job.state === "failed" && job.error?.retryable === true) || job.state === "cancelled");
}

/** The fields that put a caption job back in the queue (E2): attempt + 1. */
function requeueFields(job: JobDocument, now: Date): Partial<JobDocument> {
  const attempt = job.attempt + 1;
  return {
    state: "queued",
    attempt,
    stages: pendingStages(),
    progress: WAITING_PROGRESS,
    error: null,
    needsInput: null,
    result: null,
    cancelRequestedAt: null,
    event: { id: retryEventId(job._id, attempt), sentAt: null, lastTriedAt: null },
    render: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  };
}

/**
 * E2 on a failed or cancelled caption job, ONE transaction: the language switch (422), archived, a job running, retryable (or
 * cancelled), the video the fixes were made on is still the project's video and the project is
 * `video_ready` (else 409 INVALID_STATE: fix the captions again). The same job → `queued`, attempt
 * + 1; project → `generating`. Nothing is counted.
 */
export async function retryCaptionJob(
  db: Db,
  input: { ownerId: string; jobId: string; idempotencyLock?: IdempotencyLock | null; respond: (job: JobDocument) => { status: number; body: unknown }; now?: Date },
): Promise<JobDocument> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.jobId) || !/^[0-9a-f]{24}$/.test(input.ownerId)) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
  const ownerId = new ObjectId(input.ownerId);
  const session = db.client.startSession();
  let result: JobDocument | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const job = await jobs.findOne({ _id: new ObjectId(input.jobId), ownerId, type: "caption" }, { session });
      if (!job) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
      const project = await projects.findOne({ _id: job.projectId, ownerId }, { session });
      if (!project) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
      // The same 422 rule as F4 (caption fixes are switched off with Hindi/Hinglish).
      assertLanguageEnabled(project.language);
      if (project.state === "archived") throw new ProjectActionError("INVALID_STATE", "This project is archived.", { state: project.state });
      if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.");
      if (!canRetryCaptionJob(job)) {
        throw new ProjectActionError("INVALID_STATE", "This step can't be retried. Please fix the captions again.", { jobState: job.state, retryable: job.error?.retryable ?? false });
      }
      if (project.state !== "video_ready" || !job.inputRef.renderId || !project.currentRenderId?.equals(job.inputRef.renderId)) {
        throw new ProjectActionError("INVALID_STATE", "Your video changed since these caption fixes were saved. Please fix the captions again.", { reason: "video_changed" });
      }
      const moved = await projects.updateOne(
        { _id: project._id, activeJobId: null, stateVersion: project.stateVersion, state: "video_ready" },
        { $set: { state: "generating", activeJobId: job._id, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      if (moved.matchedCount !== 1) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      const updated = await jobs.findOneAndUpdate({ _id: job._id, attempt: job.attempt, state: job.state }, { $set: requeueFields(job, now) }, { session, returnDocument: "after" });
      if (!updated) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      if (input.idempotencyLock) {
        const answer = input.respond(updated);
        await finishIdempotencyInTransaction(db, input.idempotencyLock, answer.status, answer.body, session);
      }
      result = updated;
    });
  } finally {
    await session.endSession();
  }
  return result!;
}

// ---------- E3: Cancel ----------

/**
 * E3 Cancel on a caption job: still waiting → cancelled at once; running → `cancelRequestedAt`, the
 * worker stops before its next step or within seconds while rendering. The project goes back to
 * `video_ready` with the previous video. Calling it again is harmless. Returns the job as it is now.
 */
export async function cancelCaptionJob(db: Db, input: { ownerId: string; jobId: string; now?: Date }): Promise<JobDocument> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.jobId) || !/^[0-9a-f]{24}$/.test(input.ownerId)) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
  const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
  const job = await jobs.findOne({ _id: new ObjectId(input.jobId), ownerId: new ObjectId(input.ownerId) });
  if (!job) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
  if (job.type !== "caption") throw new ProjectActionError("INVALID_STATE", "This step can't be cancelled.", { jobType: job.type });
  if (job.state !== "queued" && job.state !== "running") throw new ProjectActionError("INVALID_STATE", "This job has already finished.", { jobState: job.state });
  if (job.state === "queued" && (await endCaptionJob(db, { jobId: job._id, attempt: job.attempt, outcome: "cancelled", onlyIfQueued: true, now }))) {
    return (await getJob(db, job._id)) ?? job;
  }
  await jobs.updateOne({ _id: job._id, state: { $in: ["queued", "running"] }, cancelRequestedAt: null }, { $set: { cancelRequestedAt: now, updatedAt: now } });
  return (await getJob(db, job._id)) ?? job;
}

// ---------- the worker ----------

export type CaptionJobContext = {
  job: JobDocument;
  project: ProjectDocument;
  /** The storyboard version of the video being fixed. */
  version: PlanVersionDocument;
  /** The video the fixes were made on (its recordings are reused as they are). */
  baseRender: RenderDocument;
  set: CaptionOverrideSetDocument;
};

/** Read the job's version, video and fix set (owner scoped), or null when something is missing. */
async function contextOf(db: Db, job: JobDocument, project: ProjectDocument): Promise<CaptionJobContext | null> {
  const { planVersionId, renderId, captionOverrideSetId } = job.inputRef;
  if (!planVersionId || !renderId || !captionOverrideSetId) return null;
  const [version, baseRender, set] = await Promise.all([
    db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: planVersionId, projectId: project._id, ownerId: job.ownerId }),
    db.collection<RenderDocument>(RENDERS_COLLECTION).findOne({ _id: renderId, projectId: project._id, ownerId: job.ownerId, status: "ready" }),
    db.collection<CaptionOverrideSetDocument>(CAPTION_OVERRIDES_COLLECTION).findOne({ _id: captionOverrideSetId, projectId: project._id, ownerId: job.ownerId }),
  ]);
  if (!version || !baseRender || !set || !baseRender.planVersionId.equals(version._id)) return null;
  return { job, project, version, baseRender, set };
}

/**
 * The run's first step: the job becomes `running` for this attempt. Null when there is nothing to do
 * (finished, a newer attempt, the project no longer waits for it). Ends the job at once when Cancel
 * was pressed, or when its video, storyboard version or fixes can't be found (INTERNAL).
 */
export async function startCaptionAttempt(db: Db, input: { jobId: string; attempt: number; runId?: string | null; now?: Date }): Promise<CaptionJobContext | null> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.jobId)) return null;
  const job = await getJob(db, new ObjectId(input.jobId));
  if (!job || job.type !== "caption" || job.attempt !== input.attempt || (job.state !== "queued" && job.state !== "running")) return null;
  const project = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: job.projectId, ownerId: job.ownerId });
  if (!project || !project.activeJobId?.equals(job._id) || project.state !== "generating") return null;
  if (job.cancelRequestedAt) {
    await endCaptionJob(db, { jobId: job._id, attempt: job.attempt, outcome: "cancelled", now });
    return null;
  }
  const ctx = await contextOf(db, job, project);
  if (!ctx) {
    await endCaptionJob(db, { jobId: job._id, attempt: job.attempt, outcome: "failed", code: "INTERNAL", detail: "The video or its caption fixes could not be found", now });
    return null;
  }
  const updated = await db.collection<JobDocument>(JOBS_COLLECTION).findOneAndUpdate(
    { _id: job._id, attempt: input.attempt, state: { $in: ["queued", "running"] } },
    {
      $set: {
        state: "running",
        startedAt: job.startedAt ?? now,
        "stages.0.status": "running",
        "stages.0.startedAt": job.stages[0]?.startedAt ?? now,
        "stages.0.attempts": 1,
        progress: { stage: "compile", percent: 5, message: CAPTION_MESSAGES.UPDATING },
        ...(input.runId ? { inngestRunId: input.runId } : {}),
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  return updated ? { ...ctx, job: updated } : null;
}

/** Read-only: the job and what it works on while it runs this attempt (else null). */
export async function loadCaptionAttempt(db: Db, input: { jobId: string; attempt: number }): Promise<CaptionJobContext | null> {
  if (!/^[0-9a-f]{24}$/.test(input.jobId)) return null;
  const job = await getJob(db, new ObjectId(input.jobId));
  if (!job || job.type !== "caption" || job.state !== "running" || job.attempt !== input.attempt) return null;
  const project = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: job.projectId, ownerId: job.ownerId, activeJobId: job._id });
  return project ? contextOf(db, job, project) : null;
}

/** The recordings a video used, by id, owner scoped (never another user's). */
export async function speechArtifactsByIds(db: Db, ownerId: ObjectId, ids: readonly ObjectId[]): Promise<SpeechArtifactDocument[]> {
  if (ids.length === 0) return [];
  return db.collection<SpeechArtifactDocument>(SPEECH_ARTIFACTS_COLLECTION).find({ _id: { $in: [...ids] }, ownerId }).toArray();
}

/**
 * Progress while the job runs (only this attempt); `stages` moves stages along by name. Returns
 * whether Cancel was pressed, or null when the job no longer runs this attempt. Every call keeps
 * `updatedAt` fresh (the stuck-job rule's heartbeat).
 */
export async function setCaptionProgress(
  db: Db,
  input: { jobId: ObjectId; attempt: number; stage: CaptionStage; percent: number; message: string; stages?: Partial<Record<CaptionStage, "running" | "succeeded">>; now?: Date },
): Promise<{ cancelRequested: boolean } | null> {
  const now = input.now ?? new Date();
  const set: Record<string, unknown> = { progress: { stage: input.stage, percent: Math.max(0, Math.min(100, Math.round(input.percent))), message: input.message }, updatedAt: now };
  for (const [name, status] of Object.entries(input.stages ?? {}) as [CaptionStage, "running" | "succeeded"][]) {
    const i = STAGE_INDEX[name];
    set[`stages.${i}.status`] = status;
    if (status === "running") {
      set[`stages.${i}.startedAt`] = now;
      set[`stages.${i}.attempts`] = 1;
    } else set[`stages.${i}.endedAt`] = now;
  }
  const job = await db
    .collection<JobDocument>(JOBS_COLLECTION)
    .findOneAndUpdate({ _id: input.jobId, attempt: input.attempt, state: "running" }, { $set: set }, { returnDocument: "after", projection: { cancelRequestedAt: 1 } });
  return job ? { cancelRequested: job.cancelRequestedAt !== null && job.cancelRequestedAt !== undefined } : null;
}

/** The render attempt starts: a NEW renderId (its own R2 folder). */
export async function beginCaptionRender(db: Db, input: { jobId: ObjectId; attempt: number; renderId: ObjectId; now?: Date }): Promise<{ cancelRequested: boolean } | null> {
  const now = input.now ?? new Date();
  const job = await db.collection<JobDocument>(JOBS_COLLECTION).findOneAndUpdate(
    { _id: input.jobId, attempt: input.attempt, state: "running" },
    {
      $set: {
        render: { renderId: input.renderId, startedAt: now },
        "stages.0.status": "running",
        "stages.1.status": "pending",
        "stages.2.status": "pending",
        progress: { stage: "compile", percent: 10, message: CAPTION_MESSAGES.UPDATING },
        updatedAt: now,
      },
    },
    { returnDocument: "after", projection: { cancelRequestedAt: 1 } },
  );
  return job ? { cancelRequested: Boolean(job.cancelRequestedAt) } : null;
}

/**
 * The fixed video is ready, ONE transaction: insert the render (`ready`, the next video number,
 * `captionOverrideSetId`), project → `video_ready` with the new `currentRenderId`, `activeJobId`
 * cleared, +1 stateVersion; job → `succeeded` with `result.renderId`. Nothing is counted. False when
 * the job no longer runs this attempt.
 */
export async function completeCaptionJob(db: Db, input: { jobId: ObjectId; attempt: number; render: RenderToSave; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let saved = false;
  try {
    await session.withTransaction(async () => {
      saved = false;
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = await jobs.findOne({ _id: input.jobId, attempt: input.attempt, state: "running", type: "caption" }, { session });
      const { planVersionId, captionOverrideSetId } = job?.inputRef ?? {};
      if (!job || !planVersionId || !captionOverrideSetId || !job.render?.renderId.equals(input.render.renderId)) return;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const project = await projects.findOne({ _id: job.projectId, ownerId: job.ownerId, activeJobId: job._id }, { session });
      if (!project) return;
      const version = await db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: planVersionId, ownerId: job.ownerId }, { session, projection: { planHash: 1 } });
      const set = await db.collection<CaptionOverrideSetDocument>(CAPTION_OVERRIDES_COLLECTION).findOne({ _id: captionOverrideSetId, ownerId: job.ownerId }, { session });
      if (!version || !set) return;
      const renders = db.collection<RenderDocument>(RENDERS_COLLECTION);
      const last = await renders.findOne({ projectId: project._id }, { session, sort: { renderNumber: -1 }, projection: { renderNumber: 1 } });
      const { render } = input;
      await renders.insertOne(
        {
          _id: render.renderId,
          ownerId: job.ownerId,
          projectId: project._id,
          schemaVersion: RENDER_SCHEMA_VERSION,
          planVersionId,
          planHash: version.planHash,
          renderNumber: (last?.renderNumber ?? 0) + 1,
          speech: render.speech,
          captionOverrideSetId: set._id,
          timelineKey: render.keys.timeline,
          captionsKey: render.keys.captions,
          mp4Key: render.keys.mp4,
          thumbnailKey: render.keys.thumbnail,
          qaKey: render.keys.qa,
          previewFrameKeys: [],
          renderInputHash: renderInputHash({ planHash: version.planHash, cacheKeys: render.cacheKeys, music: render.music, captionOverrides: set.overrides }),
          mp4Sha256: render.mp4Sha256,
          qa: render.qa,
          status: "ready",
          metrics: render.metrics,
          error: null,
          createdAt: job.render.startedAt,
          readyAt: now,
        },
        { session },
      );
      await projects.updateOne(
        { _id: project._id, activeJobId: job._id },
        { $set: { state: "video_ready", currentRenderId: render.renderId, activeJobId: null, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      await jobs.updateOne(
        { _id: job._id, attempt: input.attempt, state: "running" },
        {
          $set: {
            state: "succeeded",
            stages: job.stages.map((s) => ({ ...s, status: "succeeded" as const, startedAt: s.startedAt ?? now, endedAt: s.endedAt ?? now, attempts: Math.max(1, s.attempts), error: null })),
            progress: { stage: "validate", percent: 100, message: CAPTION_MESSAGES.DONE },
            error: null,
            result: { planVersionId, renderId: render.renderId },
            render: null,
            finishedAt: now,
            updatedAt: now,
          },
        },
        { session },
      );
      saved = true;
    });
  } finally {
    await session.endSession();
  }
  return saved;
}

/**
 * The caption job ends without a new video, ONE transaction (API.md §8.3): `failed` (the plain
 * error, Try again when retryable) or `cancelled`. Either way the project goes back to `video_ready`
 * with the previous video still its video (`currentRenderId` untouched), `activeJobId` cleared, +1
 * stateVersion. The review screen shows the failure from the job. Only while the job is
 * queued/running (and the given attempt; for the stuck-job rule: not updated since `staleBefore` /
 * queued since `queuedBefore`). False = nothing changed. `detail` is a fixed plain line written by
 * our code (never a renderer's text or a stack trace: those go to the server log).
 */
export async function endCaptionJob(
  db: Db,
  input: {
    jobId: ObjectId;
    attempt?: number;
    outcome: "failed" | "cancelled";
    code?: CaptionErrorCode;
    stage?: CaptionStage;
    detail?: string;
    staleBefore?: Date;
    queuedBefore?: Date;
    onlyIfQueued?: boolean;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let ended = false;
  try {
    await session.withTransaction(async () => {
      ended = false;
      const filter = {
        _id: input.jobId,
        type: "caption" as const,
        state: { $in: (input.onlyIfQueued ? ["queued"] : ["queued", "running"]) as JobDocument["state"][] },
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        ...(input.staleBefore ? { updatedAt: { $lt: input.staleBefore } } : {}),
        ...(input.queuedBefore ? { state: "queued" as const, queuedAt: { $lt: input.queuedBefore } } : {}),
      };
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = await jobs.findOne(filter, { session });
      if (!job) return;
      let set: Partial<JobDocument>;
      if (input.outcome === "failed") {
        const code = input.code ?? "INTERNAL";
        const { message, retryable } = CAPTION_ERRORS[code];
        const stageName = input.stage ?? (job.stages.find((s) => s.status === "running")?.name as CaptionStage | undefined) ?? "compile";
        const stageError = { code, message: (input.detail ?? message).slice(0, 300) };
        set = {
          state: "failed",
          stages: job.stages.map((s) => (s.name === stageName ? { ...s, status: "failed" as const, startedAt: s.startedAt ?? now, endedAt: now, error: stageError } : s)),
          progress: { ...job.progress, message },
          error: { code, message, retryable },
        };
      } else {
        set = {
          state: "cancelled",
          stages: job.stages.map((s) => (s.status === "running" || s.status === "pending" ? { ...s, status: "cancelled" as const, endedAt: s.status === "running" ? now : s.endedAt } : s)),
          progress: { ...job.progress, message: CAPTION_MESSAGES.CANCELLED },
          error: { code: "CANCELLED", message: CAPTION_MESSAGES.CANCELLED, retryable: false },
        };
      }
      await jobs.updateOne({ _id: job._id, attempt: job.attempt, state: job.state }, { $set: { ...set, render: null, finishedAt: now, updatedAt: now } }, { session });
      await db
        .collection<ProjectDocument>(PROJECTS_COLLECTION)
        .updateOne({ _id: job.projectId, activeJobId: job._id }, { $set: { state: "video_ready", activeJobId: null, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } }, { session });
      ended = true;
    });
  } finally {
    await session.endSession();
  }
  return ended;
}
