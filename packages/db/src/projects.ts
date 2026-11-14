import { type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { cleanIdeaText, IDEA_MAX_CHARS, IDEA_MIN_CHARS, IDEA_TOPIC_MAX_CHARS } from "./idea-text";
import { finishIdempotencyInTransaction, type IdempotencyLock } from "./idempotency";
import { canRetryPlanJob, JOBS_COLLECTION, newPlanJob, planInputHash, toJobResource, type JobDocument, type JobResource, type JobType } from "./jobs";
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

export const LANGUAGES = ["en", "hi", "hinglish"] as const;
export const VOICE_GENDERS = ["female", "male"] as const;
export const INPUT_TYPES = ["topic", "notes", "brainstorm"] as const;
export type Language = (typeof LANGUAGES)[number];
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
 */
export const STORYBOARD_EDIT_STATES: readonly ProjectState[] = ["storyboard_ready", "generate_failed", "video_ready", "scheduled", "publish_failed"];

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
  latestPost: null;
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

/** API.md §11.1 `AllowedAction`: only those whose endpoints exist so far. */
export type AllowedAction = "edit_idea" | "retry_job" | "edit_storyboard";

/**
 * What the creator may do now (API.md §11.1, "the server owns state"). Nothing while a job runs.
 * - F15, after a failed storyboard: `edit_idea` (C4), and `retry_job` (E2) while the last plan job
 *   may be retried and the project is under its 20 storyboard requests.
 * - F17, with a storyboard: `edit_storyboard` (D3 narration edit, D4 voice, D7 undo/restore).
 * Rename and archive arrive with F21.
 */
export function allowedActionsFor(doc: ProjectDocument, latestPlanJob: JobDocument | null | undefined): AllowedAction[] {
  if (doc.activeJobId) return [];
  if (doc.state === "plan_failed") {
    const actions: AllowedAction[] = ["edit_idea"];
    if (latestPlanJob && doc.planRequestCount < USAGE_LIMITS.planRequestsPerProject && canRetryPlanJob(latestPlanJob, planInputHash(doc))) actions.push("retry_job");
    return actions;
  }
  if (STORYBOARD_EDIT_STATES.includes(doc.state) && doc.currentPlanVersionId) return ["edit_storyboard"];
  return [];
}

export interface ProjectRelated {
  /** The job in `activeJobId`, when the caller loaded it. */
  activeJob?: JobDocument | null;
  /** False: `activeJob` stays null in the answer (C2 returns the job next to the project). */
  embedActiveJob?: boolean;
  /** The project's newest plan job (for `retry_job`). */
  latestPlanJob?: JobDocument | null;
}

/**
 * Database document → API resource. Posts and thumbnails don't exist yet (F23, F30), so those
 * fields are null.
 */
export function toProjectResource(doc: ProjectDocument, related: ProjectRelated = {}): ProjectResource {
  const activeJob = related.activeJob && doc.activeJobId && related.activeJob._id.equals(doc.activeJobId) ? related.activeJob : null;
  const state = doc.state === "archived" && doc.stateBeforeArchive ? doc.stateBeforeArchive : doc.state;
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    language: doc.language,
    voiceGender: doc.voiceGender,
    state: doc.state,
    currentStep: currentStepOf(state),
    thumbnailUrl: null,
    latestPost: null,
    activeJobType: activeJob ? activeJob.type : doc.activeJobId ? "plan" : null,
    input: { type: doc.input.type, text: doc.input.text, brainstormChoice: doc.input.brainstormChoice },
    stateVersion: doc.stateVersion,
    currentPlanVersionId: hexOrNull(doc.currentPlanVersionId),
    approvedPlanVersionId: hexOrNull(doc.approvedPlanVersionId),
    currentRenderId: hexOrNull(doc.currentRenderId),
    activeJobId: hexOrNull(doc.activeJobId),
    activeJob: activeJob && related.embedActiveJob !== false ? toJobResource(activeJob) : null,
    lastError: doc.lastError ? { code: doc.lastError.code, message: doc.lastError.message, at: doc.lastError.at.toISOString() } : null,
    allowedActions: allowedActionsFor(doc, related.latestPlanJob),
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
 * Throws ProjectQuotaExceededError (nothing saved) when the limit is reached, and
 * IdempotencyLockLostError (nothing saved) when a repeat of the same click took the record over.
 */
export async function createProject(
  db: Db,
  input: { ownerId: string; timezone: string; body: CreateProjectBody; idempotencyLock?: IdempotencyLock | null; now?: Date },
): Promise<{ response: CreateProjectResponse; job: JobDocument }> {
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
    readonly code: "NOT_FOUND" | "INVALID_STATE" | "STALE_VERSION" | "JOB_ALREADY_RUNNING" | "QUOTA_EXCEEDED" | "INVALID_INPUT",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProjectActionError";
  }
}

/** C4 body in F15: edit the idea after a failed storyboard (API.md C4). Rename alone arrives with F21. */
export const EditIdeaBodySchema = z.strictObject({
  text: cleanText,
  title: textBetween(1, TITLE_MAX).optional(),
  expectedStateVersion: z.number({ error: "must be a whole number" }).int({ error: "must be a whole number" }).min(1, { error: "must be at least 1" }),
});
export type EditIdeaBody = z.output<typeof EditIdeaBodySchema>;

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
    { $set: { "input.text": text, title: input.body.title ?? titleFromIdea(text), updatedAt: now }, $inc: { stateVersion: 1 } },
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
