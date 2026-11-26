import { type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { cleanIdeaText, IDEA_MAX_CHARS, IDEA_MIN_CHARS, IDEA_TOPIC_MAX_CHARS } from "./idea-text";
import { finishIdempotencyInTransaction, type IdempotencyLock } from "./idempotency";
import { isLanguageEnabled, LANGUAGES, languageUnavailableMessage, type Language } from "./languages";
import { canRetryPlanJob, JOBS_COLLECTION, newPlanJob, planInputHash, toJobResource, type JobDocument, type JobResource, type JobType } from "./jobs";
import { isCheckablePost, toPostSummary, type PostDocument, type PostSummaryResource } from "./post-approval";
import { addUsageWithinLimit } from "./usage-counters";
import { USAGE_LIMITS } from "./usage";

// Video projects (docs/DATABASE.md §4.8 `projects`, docs/API.md C2, C4 and §11.3 `Project`).
// C2 "Create storyboard" (F12, full spec since F15): ONE transaction counts the project for the day,
// saves it in state `planning` (planRequestCount 0: the storyboard request is counted when the job
// really sends it to Gemini), and inserts its queued `plan` job; the
// route then hands the job to Inngest (`plan.requested`). Projects saved by F12 before F15 stay in
// state `draft` with no job.

export const PROJECTS_COLLECTION = "projects";
export const PROJECT_SCHEMA_VERSION = 1;

export { LANGUAGES, type Language };
export const VOICE_GENDERS = ["female", "male"] as const;
export const INPUT_TYPES = ["topic", "notes", "brainstorm"] as const;
export type VoiceGender = (typeof VOICE_GENDERS)[number];
export type InputType = (typeof INPUT_TYPES)[number];

export type ProjectState =
  | "draft"
  | "planning"
  | "plan_failed"
  | "storyboard_ready"
  | "generating"
  | "generate_failed"
  | "video_ready"
  | "scheduled"
  | "publishing"
  | "published"
  | "publish_failed"
  | "archived";

export type ProjectStep = "idea" | "storyboard" | "video" | "publish";

/**
 * States in which the storyboard may be changed (API.md D3–D7): edit, voice, revision, undo.
 * Anything but a running job; a change after a video exists makes a new version to approve again.
 * F30: also `scheduled` / `publish_failed`. There each change moves the post to
 * `approval_invalidated` (+ a notification) in the SAME transaction (post-approval.ts
 * invalidateOpenPosts; API.md §9), so an old approval can never publish the changed project.
 */
export const STORYBOARD_EDIT_STATES: readonly ProjectState[] = ["storyboard_ready", "generate_failed", "video_ready", "scheduled", "publish_failed"];

/** F30: the states where a project has a post whose approval a change must cancel. */
export const POST_OPEN_PROJECT_STATES: readonly ProjectState[] = ["scheduled", "publish_failed"];

/** Idea text limits per input type (API.md C2, DATABASE.md §4.8), counted after trim + NFC. */
export const IDEA_LIMITS = {
  topic: { min: IDEA_MIN_CHARS, max: IDEA_TOPIC_MAX_CHARS },
  notes: { min: 20, max: IDEA_MAX_CHARS },
  brainstorm: { min: 3, max: 300 },
} as const satisfies Record<InputType, { min: number; max: number }>;

/** `title` = the first 120 characters of the idea until the storyboard arrives (DATABASE.md §4.8). */
export const TITLE_MAX = 120;

export type BrainstormChoice = { subject: string; title: string; hook: string };

export interface ProjectDocument {
  _id: ObjectId;
  ownerId: ObjectId;
  schemaVersion: number;
  title: string;
  /**
   * True once the creator chose the title (C4 rename, or Edit idea with a title; F21 review). A
   * finishing storyboard job then keeps it instead of using the plan's topic. Missing = false.
   */
  titleSetByUser?: boolean;
  language: Language;
  voiceGender: VoiceGender;
  input: { type: InputType; text: string; brainstormChoice: BrainstormChoice | null };
  state: ProjectState;
  currentPlanVersionId: ObjectId | null;
  approvedPlanVersionId: ObjectId | null;
  currentRenderId: ObjectId | null;
  activeJobId: ObjectId | null;
  stateVersion: number;
  planRequestCount: number;
  lastError: { code: string; message: string; at: Date } | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  stateBeforeArchive?: ProjectState;
  /**
   * F29: the Instagram caption being written on Step 4 (caption + hashtags in one text), saved by H1
   * (an AI suggestion, `source: "ai"`) and H7 (the creator's edits, `"edited"`). Missing = none yet.
   * Not part of the project's state: saving it never changes `stateVersion` or `updatedAt`.
   */
  captionDraft?: { text: string; updatedAt: Date; source: "ai" | "edited" } | null;
  /** F29 review: the newest H7 save's `clientSeq` (an older save arriving late is skipped). */
  captionDraftSeq?: number | null;
  /**
   * F29 review: an AI caption suggestion is being written until this time (a 60 s lease taken in the
   * same atomic update that counts the request; cleared when it ends). While it runs, H1 answers 409
   * `suggestion_in_progress`, so a reload or a second tab never spends a second request.
   */
  captionSuggestingUntil?: Date | null;
  /** The lease's id, so only the request that took it clears it. */
  captionSuggestingId?: ObjectId | null;
}

/** API.md §2: control characters removed, NFC, trimmed, before length checks (idea-text.ts). */
const cleanText = z.string({ error: "must be text" }).transform(cleanIdeaText);
const textBetween = (min: number, max: number) =>
  cleanText.pipe(z.string().min(min, { error: `must be at least ${min} characters` }).max(max, { error: `must be at most ${max} characters` }));

/** C2 request body (API.md C2). Strict: unknown fields → 400 INVALID_INPUT. */
export const CreateProjectBodySchema = z
  .strictObject({
    inputType: z.enum(INPUT_TYPES, { error: `must be one of ${INPUT_TYPES.join(", ")}` }),
    text: cleanText,
    language: z.enum(LANGUAGES, { error: `must be one of ${LANGUAGES.join(", ")}` }),
    voiceGender: z.enum(VOICE_GENDERS, { error: `must be one of ${VOICE_GENDERS.join(", ")}` }),
    brainstormChoice: z.strictObject({ subject: textBetween(2, 100), title: textBetween(3, 120), hook: textBetween(3, 200) }).optional(),
  })
  .superRefine((body, ctx) => {
    const { min, max } = IDEA_LIMITS[body.inputType];
    if (body.text.length < min) ctx.addIssue({ code: "custom", path: ["text"], message: `must be at least ${min} characters` });
    if (body.text.length > max) ctx.addIssue({ code: "custom", path: ["text"], message: `must be at most ${max} characters` });
    if (body.inputType === "brainstorm" && !body.brainstormChoice) ctx.addIssue({ code: "custom", path: ["brainstormChoice"], message: "is required when inputType is brainstorm" });
    if (body.inputType !== "brainstorm" && body.brainstormChoice) ctx.addIssue({ code: "custom", path: ["brainstormChoice"], message: "is only allowed when inputType is brainstorm" });
  });

export type CreateProjectBody = z.output<typeof CreateProjectBodySchema>;

/**
 * The idea as a title: spaces and line breaks collapsed. A longer idea is cut to at most 120
 * characters at the last word break (never mid-word, never an emoji in half) and ends with "…".
 */
export function titleFromIdea(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_MAX) return flat;
  let end = TITLE_MAX - 1; // room for "…"
  const last = flat.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // a high surrogate: keep the pair together
  // Cut at the last space if that keeps at least half the room; one very long word is cut as is.
  const space = flat.lastIndexOf(" ", end);
  if (space >= TITLE_MAX / 2) end = space;
  return `${flat.slice(0, end).replace(/[\s,;:–—-]+$/u, "")}…`;
}

/**
 * The title after a storyboard job succeeds: the plan's topic (same 120-character rule), unless the
 * creator chose the title themselves (rename, or Edit idea with a title), or the topic is empty.
 */
export function titleAfterPlan(project: Pick<ProjectDocument, "title" | "titleSetByUser">, planTopic: unknown): string {
  if (project.titleSetByUser) return project.title;
  return typeof planTopic === "string" && planTopic.trim() ? titleFromIdea(planTopic) : project.title;
}

/** The project title: the picked brainstorm idea's own title, otherwise taken from the idea text. */
export function projectTitle(body: { text: string; brainstormChoice?: { title: string } | null | undefined }): string {
  return body.brainstormChoice?.title ?? titleFromIdea(body.text);
}

/** API.md §11.3 `currentStep` rules. */
export function currentStepOf(state: ProjectState): ProjectStep {
  switch (state) {
    case "storyboard_ready":
      return "storyboard";
    case "generating":
    case "generate_failed":
    case "video_ready":
      return "video";
    case "scheduled":
    case "publishing":
    case "published":
    case "publish_failed":
      return "publish";
    default:
      return "idea";
  }
}

/** The `Project` resource (API.md §11.3) as JSON. */
export type ProjectResource = {
  id: string;
  title: string;
  language: Language;
  voiceGender: VoiceGender;
  state: ProjectState;
  currentStep: ProjectStep;
  thumbnailUrl: string | null;
  /** F30: the project's newest post (C3, C6), null when it has none or the caller didn't load it. */
  latestPost: PostSummaryResource | null;
  activeJobType: JobType | null;
  input: { type: InputType; text: string; brainstormChoice: BrainstormChoice | null };
  stateVersion: number;
  currentPlanVersionId: string | null;
  approvedPlanVersionId: string | null;
  currentRenderId: string | null;
  activeJobId: string | null;
  activeJob: JobResource | null;
  lastError: { code: string; message: string; at: string } | null;
  allowedActions: string[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const hexOrNull = (id: ObjectId | null) => (id ? id.toHexString() : null);

/**
 * The state the project's pages follow. An archived project keeps showing the step it was on
 * (`stateBeforeArchive`, API.md C5), read-only, so a saved link still opens the same page (F21).
 */
export function displayStateOf(doc: Pick<ProjectDocument, "state" | "stateBeforeArchive">): ProjectState {
  return doc.state === "archived" ? (doc.stateBeforeArchive ?? "draft") : doc.state;
}

/**
 * API.md §11.1 `AllowedAction`: only those whose endpoints exist so far. F23 adds `generate_video`
 * (D8 on a version that is already approved but has no video job yet) and `cancel_job` (E3).
 */
export type AllowedAction =
  | "rename"
  | "edit_idea"
  | "retry_job"
  | "edit_storyboard"
  | "request_revision"
  | "approve_storyboard"
  | "generate_video"
  | "edit_captions"
  | "cancel_job"
  | "publish"
  | "retry_post"
  | "archive";

/**
 * What the creator may do now (API.md §11.1, "the server owns state"). While a job runs: only
 * `cancel_job` for a video job (F23) that hasn't been asked to stop yet; nothing for the storyboard
 * jobs. Nothing on an archived project.
 * - F21: `rename` (C4 title) first and `archive` (C5) last, in every state (archive not while
 *   `publishing`, ARCHITECTURE §7.2).
 * - F15, after a failed storyboard: `edit_idea` (C4), and `retry_job` (E2) while the last plan job
 *   may be retried and the project is under its 20 storyboard requests.
 * - F17, with a storyboard: `edit_storyboard` (D3 narration edit, D4 voice, D7 undo/restore).
 * - F18: `request_revision` (D5) while under the 20 AI requests; `retry_job` (E2) when the last
 *   change request failed with a retryable error and the storyboard is still the one it was made on.
 * - F20/F23: `approve_storyboard` (D8 "Approve & generate video") in storyboard_ready /
 *   generate_failed while the current version isn't the approved one (whether it passes the checks
 *   is on the version: `valid`).
 * - F23: `generate_video` (D8 "Generate video") in storyboard_ready when the current version IS
 *   approved and has no video job running (an approval from F20, a cancelled job), unless its last
 *   job said the storyboard must change (needs_input) or failed with an error that can't be retried
 *   as it is (D8 refuses both, like E2). `retry_job` (E2) in generate_failed when the
 *   newest video job failed with a retryable error and is still for the approved current version.
 * - F25: `edit_captions` (F4 caption fixes) in video_ready when the project has a video. While a
 *   caption job waits or runs: `cancel_job` (like a video job). `retry_job` (E2) in video_ready when
 *   the newest caption job failed with a retryable error or was cancelled, and the video it was made
 *   on is still the project's video.
 * - F30: `publish` (H2) in video_ready with a video, or in publish_failed / scheduled when the newest
 *   post's approval was cancelled (approve again); `retry_post` (H6) in publish_failed when the newest
 *   post failed. `edit_captions` also in publish_failed / scheduled (F4 cancels the post's approval).
 * - Language switch (languages.ts): a project in a switched-off language (Hindi/Hinglish for now)
 *   loses every action that costs AI or voice: `retry_job`, `request_revision`, `edit_idea` (only
 *   useful for its Try again), and since F23 `approve_storyboard` / `generate_video` (approving now
 *   starts the voice + video job), and since F25 `edit_captions` (the Hindi/Hinglish script rule for
 *   caption text comes back with those languages). It stays viewable; the free actions stay.
 */
export function allowedActionsFor(
  doc: ProjectDocument,
  latestPlanJob: JobDocument | null | undefined,
  latestReviseJob?: JobDocument | null,
  more: {
    activeJob?: JobDocument | null;
    latestGenerateJob?: JobDocument | null;
    latestCaptionJob?: JobDocument | null;
    latestPost?: (Pick<PostDocument, "state"> & Partial<Pick<PostDocument, "publishAttemptedAt" | "igMediaId">>) | null;
  } = {},
): AllowedAction[] {
  if (doc.state === "archived") return [];
  if (doc.activeJobId) {
    const active = more.activeJob && more.activeJob._id.equals(doc.activeJobId) ? more.activeJob : null;
    const videoJob = active?.type === "generate" || active?.type === "caption";
    return active && videoJob && (active.state === "queued" || active.state === "running") && !active.cancelRequestedAt ? ["cancel_job"] : [];
  }
  const stepActions = [...stepActionsFor(doc, latestPlanJob, latestReviseJob, more.latestGenerateJob, more.latestCaptionJob), ...postActionsFor(doc, more.latestPost ?? null)];
  const actions: AllowedAction[] = ["rename", ...(isLanguageEnabled(doc.language) ? stepActions : stepActions.filter((a) => !AI_ACTIONS.includes(a)))];
  if (doc.state !== "publishing") actions.push("archive");
  return actions;
}

/**
 * F30: publishing actions (they cost no AI or voice, so the language switch doesn't remove them).
 * An unconfirmed post (its publish may be live) blocks every new approval: only "Check again"
 * (`retry_post`, H6) is offered until it is confirmed or proven not posted (code review MUST 1).
 */
function postActionsFor(doc: ProjectDocument, latestPost: (Pick<PostDocument, "state"> & Partial<Pick<PostDocument, "publishAttemptedAt" | "igMediaId">>) | null): AllowedAction[] {
  if (!doc.currentRenderId) return [];
  if (latestPost && isCheckablePost({ state: latestPost.state, publishAttemptedAt: latestPost.publishAttemptedAt ?? null, igMediaId: latestPost.igMediaId ?? null })) return ["retry_post"];
  if (doc.state === "video_ready") return ["publish"];
  if ((doc.state === "publish_failed" || doc.state === "scheduled") && latestPost?.state === "approval_invalidated") return ["publish"];
  if (doc.state === "publish_failed" && latestPost?.state === "publish_failed") return ["retry_post"];
  return [];
}

/** Actions that start an AI or voice job (or lead only to one): refused for a switched-off language. */
const AI_ACTIONS: readonly AllowedAction[] = ["retry_job", "request_revision", "edit_idea", "approve_storyboard", "generate_video", "edit_captions"];

/**
 * Throws 422 LANGUAGE_UNAVAILABLE when the language is switched off (languages.ts). Every action
 * that costs AI or voice calls this BEFORE counting anything or starting a job: C2, D5, D8, E2 (and
 * the F23 video job's worker).
 */
export function assertLanguageEnabled(language: string): void {
  if (!isLanguageEnabled(language)) throw new ProjectActionError("LANGUAGE_UNAVAILABLE", languageUnavailableMessage(), { language });
}

/** The actions of the step the project is on (F15–F20), without rename/archive. */
function stepActionsFor(
  doc: ProjectDocument,
  latestPlanJob: JobDocument | null | undefined,
  latestReviseJob?: JobDocument | null,
  latestGenerateJob?: JobDocument | null,
  latestCaptionJob?: JobDocument | null,
): AllowedAction[] {
  const underLimit = doc.planRequestCount < USAGE_LIMITS.planRequestsPerProject;
  if (doc.state === "plan_failed") {
    const actions: AllowedAction[] = ["edit_idea"];
    if (latestPlanJob && underLimit && canRetryPlanJob(latestPlanJob, planInputHash(doc))) actions.push("retry_job");
    return actions;
  }
  if (!STORYBOARD_EDIT_STATES.includes(doc.state) || !doc.currentPlanVersionId) return [];
  const actions: AllowedAction[] = ["edit_storyboard"];
  if (underLimit) actions.push("request_revision");
  const reviseRetry =
    latestReviseJob?.type === "revise" &&
    latestReviseJob.state === "failed" &&
    latestReviseJob.error?.retryable === true &&
    latestReviseJob.inputRef.planVersionId?.equals(doc.currentPlanVersionId) === true;
  if (reviseRetry && underLimit) actions.push("retry_job");
  const approved = doc.approvedPlanVersionId?.equals(doc.currentPlanVersionId) === true;
  if ((doc.state === "storyboard_ready" || doc.state === "generate_failed") && !approved) actions.push("approve_storyboard");
  // F23: the video job of the current (approved) version.
  const videoJob = latestGenerateJob?.type === "generate" && latestGenerateJob.inputRef.planVersionId?.equals(doc.currentPlanVersionId) === true ? latestGenerateJob : null;
  const videoNeedsChange = videoJob?.state === "needs_input" || (videoJob?.state === "failed" && videoJob.error?.retryable !== true);
  if (doc.state === "storyboard_ready" && approved && !videoNeedsChange) actions.push("generate_video");
  if (doc.state === "generate_failed" && approved && videoJob?.state === "failed" && videoJob.error?.retryable === true && !actions.includes("retry_job")) actions.push("retry_job");
  // F30: caption fixes also while a post waits (publish_failed / scheduled): F4 cancels its approval.
  if (POST_OPEN_PROJECT_STATES.includes(doc.state) && doc.currentRenderId) actions.push("edit_captions");
  // F25: caption fixes on the project's video, and Try again for the last caption job made on it.
  if (doc.state === "video_ready" && doc.currentRenderId) {
    actions.push("edit_captions");
    const captionJob = latestCaptionJob?.type === "caption" && latestCaptionJob.inputRef.renderId?.equals(doc.currentRenderId) === true ? latestCaptionJob : null;
    const captionRetry = captionJob !== null && ((captionJob.state === "failed" && captionJob.error?.retryable === true) || captionJob.state === "cancelled");
    if (captionRetry && !actions.includes("retry_job")) actions.push("retry_job");
  }
  return actions;
}

export interface ProjectRelated {
  /** The job in `activeJobId`, when the caller loaded it. */
  activeJob?: JobDocument | null;
  /** False: `activeJob` stays null in the answer (C2 returns the job next to the project). */
  embedActiveJob?: boolean;
  /** The project's newest plan job (for `retry_job`). */
  latestPlanJob?: JobDocument | null;
  /** The project's newest revise job (for `retry_job` on the storyboard, F18). */
  latestReviseJob?: JobDocument | null;
  /** The project's newest generate job (F23: `generate_video`, `retry_job` on the video step). */
  latestGenerateJob?: JobDocument | null;
  /** The project's newest caption job (F25: `retry_job` after a failed or cancelled caption fix). */
  latestCaptionJob?: JobDocument | null;
  /** The project's newest post (F30: `latestPost`, `publish` / `retry_post`). */
  latestPost?: PostDocument | null;
}

/**
 * Database document → API resource. `latestPost` (F30) when the caller loaded it; the thumbnail is
 * only on the My videos cards (C1, F23), so here it is null.
 */
export function toProjectResource(doc: ProjectDocument, related: ProjectRelated = {}): ProjectResource {
  const activeJob = related.activeJob && doc.activeJobId && related.activeJob._id.equals(doc.activeJobId) ? related.activeJob : null;
  const state = displayStateOf(doc);
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    language: doc.language,
    voiceGender: doc.voiceGender,
    state: doc.state,
    currentStep: currentStepOf(state),
    thumbnailUrl: null,
    latestPost: related.latestPost ? toPostSummary(related.latestPost) : null,
    activeJobType: activeJob ? activeJob.type : null,
    input: { type: doc.input.type, text: doc.input.text, brainstormChoice: doc.input.brainstormChoice },
    stateVersion: doc.stateVersion,
    currentPlanVersionId: hexOrNull(doc.currentPlanVersionId),
    approvedPlanVersionId: hexOrNull(doc.approvedPlanVersionId),
    currentRenderId: hexOrNull(doc.currentRenderId),
    activeJobId: hexOrNull(doc.activeJobId),
    activeJob: activeJob && related.embedActiveJob !== false ? toJobResource(activeJob) : null,
    lastError: doc.lastError ? { code: doc.lastError.code, message: doc.lastError.message, at: doc.lastError.at.toISOString() } : null,
    allowedActions: allowedActionsFor(doc, related.latestPlanJob, related.latestReviseJob, {
      activeJob,
      latestGenerateJob: related.latestGenerateJob ?? null,
      latestCaptionJob: related.latestCaptionJob ?? null,
      latestPost: related.latestPost ?? null,
    }),
    archivedAt: doc.archivedAt ? doc.archivedAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** The C2 answer (API.md C2): 202 Accepted with the project and its queued plan job. */
export const CREATE_PROJECT_STATUS = 202;
export type CreateProjectResponse = { project: ProjectResource; job: JobResource };

/** The 5 projects/day limit is reached (API.md §10.1). Nothing was saved. */
export class ProjectQuotaExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly used: number,
    readonly resetsAt: Date,
  ) {
    super("Daily project limit reached.");
    this.name = "ProjectQuotaExceededError";
  }
}

/**
 * C2 (DATABASE.md §7.2 #1). In ONE transaction: +1 on today's projects counter (only while within
 * 5), insert the project (`planning`, planRequestCount 0, activeJobId = the job), insert its queued
 * `plan` job, and, when the request carried an Idempotency-Key, save the answer on its record. So a
 * crash can never leave a counted project that doesn't exist, a project without its job, or a
 * saved project whose click would run again on retry. The Inngest event is sent by the caller
 * AFTER this returns (never inside a transaction); if that send fails, the job stays `queued` and
 * the stuck-job rule sends it again (plan-jobs.ts).
 * Throws ProjectActionError LANGUAGE_UNAVAILABLE first (nothing read, counted or saved) for a
 * switched-off language, ProjectQuotaExceededError (nothing saved) when the limit is reached, and
 * IdempotencyLockLostError (nothing saved) when a repeat of the same click took the record over.
 */
export async function createProject(
  db: Db,
  input: { ownerId: string; timezone: string; body: CreateProjectBody; idempotencyLock?: IdempotencyLock | null; now?: Date },
): Promise<{ response: CreateProjectResponse; job: JobDocument }> {
  assertLanguageEnabled(input.body.language);
  const now = input.now ?? new Date();
  const projectId = new ObjectId();
  const ownerId = new ObjectId(input.ownerId);
  const job = newPlanJob({
    ownerId,
    projectId,
    project: { input: { type: input.body.inputType, text: input.body.text, brainstormChoice: input.body.brainstormChoice ?? null }, language: input.body.language, voiceGender: input.body.voiceGender },
    now,
  });
  const doc: ProjectDocument = {
    _id: projectId,
    ownerId,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    title: projectTitle(input.body),
    language: input.body.language,
    voiceGender: input.body.voiceGender,
    input: { type: input.body.inputType, text: input.body.text, brainstormChoice: input.body.brainstormChoice ?? null },
    state: "planning",
    currentPlanVersionId: null,
    approvedPlanVersionId: null,
    currentRenderId: null,
    activeJobId: job._id,
    stateVersion: 1,
    // Counted when the job sends its first Gemini request (plan-jobs.ts reservePlanRequest).
    planRequestCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const response: CreateProjectResponse = { project: toProjectResource(doc, { activeJob: job, embedActiveJob: false }), job: toJobResource(job) };

  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      const counted = await addUsageWithinLimit(db, session, {
        ownerId: input.ownerId,
        kind: "projects",
        timezone: input.timezone,
        limit: USAGE_LIMITS.projectsPerDay,
        now,
      });
      if (!counted.ok) throw new ProjectQuotaExceededError(counted.limit, counted.used, counted.resetsAt);
      await db.collection<ProjectDocument>(PROJECTS_COLLECTION).insertOne(doc, { session });
      await db.collection<JobDocument>(JOBS_COLLECTION).insertOne(job, { session });
      // Last write: if another request took this click over meanwhile, this throws and nothing
      // (counter, project) is kept.
      if (input.idempotencyLock) await finishIdempotencyInTransaction(db, input.idempotencyLock, CREATE_PROJECT_STATUS, response, session);
    });
  } finally {
    await session.endSession();
  }
  return { response, job };
}

/**
 * One project of this owner, or null: a malformed id, someone else's project and a missing one all
 * look the same, so nobody can learn that another user's project exists (ARCHITECTURE §10.3).
 */
export async function getOwnedProject(db: Db, ownerId: string, projectId: string): Promise<ProjectDocument | null> {
  if (!/^[0-9a-f]{24}$/.test(projectId) || !/^[0-9a-f]{24}$/.test(ownerId)) return null;
  return db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: new ObjectId(projectId), ownerId: new ObjectId(ownerId) });
}

/**
 * A refused project action, mapped to an API error by the route (API.md §4.2): the project or job
 * doesn't exist for this owner, the state doesn't allow it, another tab changed it, a job is
 * already running, or the per-project storyboard limit is reached. Nothing was changed.
 */
export class ProjectActionError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "INVALID_STATE"
      | "STALE_VERSION"
      | "JOB_ALREADY_RUNNING"
      | "QUOTA_EXCEEDED"
      | "INVALID_INPUT"
      | "APPROVAL_STALE"
      | "PLAN_INVALID"
      | "LANGUAGE_UNAVAILABLE"
      | "APPROVAL_REQUIRED"
      | "SPEND_CEILING"
      | "INSTAGRAM_NOT_CONNECTED"
      | "INSTAGRAM_TOKEN_EXPIRED",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProjectActionError";
  }
}

/**
 * A project title sent by the creator (C4): cleaned like the idea (control and invisible format
 * characters removed, NFC), spaces and line breaks collapsed to one space, trimmed, 1–120.
 */
const titleText = cleanText
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1, { error: "must not be empty" }).max(TITLE_MAX, { error: `must be at most ${TITLE_MAX} characters` }));

const expectedStateVersion = z.number({ error: "must be a whole number" }).int({ error: "must be a whole number" }).min(1, { error: "must be at least 1" });

/**
 * C4 body (API.md C4), strict: `title` alone = rename (F21); `text` (optionally with `title`) =
 * edit the idea after a failed storyboard (F15). `expectedStateVersion` is always required.
 */
export const UpdateProjectBodySchema = z
  .strictObject({ title: titleText.optional(), text: cleanText.optional(), expectedStateVersion })
  .refine((body) => body.title !== undefined || body.text !== undefined, { path: ["title"], error: "send a title, the idea text, or both" });
export type UpdateProjectBody = z.output<typeof UpdateProjectBodySchema>;
export type EditIdeaBody = { text: string; title?: string | undefined; expectedStateVersion: number };

/**
 * C4 "Edit idea" (API.md C4, DATABASE.md §7.2 #2): only in `plan_failed` with no job running.
 * Replaces the idea text (type and picked brainstorm idea stay), sets the title (the sent one, else
 * from the new text), +1 stateVersion. One document, so one conditional update is all-or-nothing:
 * if another tab changed the project meanwhile, nothing is written and the reason is reported.
 * Doesn't count toward the 5 projects/day (no new project); the Try again that follows (E2) counts
 * 1 toward the project's 20 storyboard requests.
 */
export async function editProjectIdea(
  db: Db,
  input: { ownerId: string; projectId: string; body: EditIdeaBody; now?: Date },
): Promise<ProjectDocument> {
  const now = input.now ?? new Date();
  const project = await getOwnedProject(db, input.ownerId, input.projectId);
  if (!project) throw new ProjectActionError("NOT_FOUND", "We couldn't find this project.");
  const check = () => {
    if (project.state === "archived") throw new ProjectActionError("INVALID_STATE", "This project is archived.", { state: project.state });
    // Language switch: Edit idea only leads to a Try again, which is refused for this language.
    assertLanguageEnabled(project.language);
    if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.");
    if (project.stateVersion !== input.body.expectedStateVersion) {
      throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.", {
        expectedStateVersion: input.body.expectedStateVersion,
        currentStateVersion: project.stateVersion,
      });
    }
    if (project.state !== "plan_failed") throw new ProjectActionError("INVALID_STATE", "The idea can only be edited after a storyboard couldn't be made.", { state: project.state });
  };
  check();
  const { min, max } = IDEA_LIMITS[project.input.type];
  const text = input.body.text;
  if (text.length < min || text.length > max) {
    throw new ProjectActionError("INVALID_INPUT", "Please check the highlighted fields.", {
      issues: [{ path: "text", message: text.length < min ? `must be at least ${min} characters` : `must be at most ${max} characters` }],
    });
  }
  const updated = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOneAndUpdate(
    { _id: project._id, ownerId: project.ownerId, state: "plan_failed", activeJobId: null, stateVersion: input.body.expectedStateVersion },
    { $set: { "input.text": text, title: input.body.title ?? titleFromIdea(text), titleSetByUser: input.body.title !== undefined, updatedAt: now }, $inc: { stateVersion: 1 } },
    { returnDocument: "after" },
  );
  if (updated) return updated;
  // Changed between our read and the write: report the reason from the current document.
  const current = await getOwnedProject(db, input.ownerId, input.projectId);
  if (!current) throw new ProjectActionError("NOT_FOUND", "We couldn't find this project.");
  Object.assign(project, current);
  check();
  throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.", {
    expectedStateVersion: input.body.expectedStateVersion,
    currentStateVersion: current.stateVersion,
  });
}
