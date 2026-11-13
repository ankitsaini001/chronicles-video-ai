import { type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { cleanIdeaText, IDEA_MAX_CHARS, IDEA_MIN_CHARS, IDEA_TOPIC_MAX_CHARS } from "./idea-text";
import { finishIdempotencyInTransaction, type IdempotencyLock } from "./idempotency";
import { addUsageWithinLimit } from "./usage-counters";
import { USAGE_LIMITS } from "./usage";

// Video projects (docs/DATABASE.md §4.8 `projects`, docs/API.md C2 and §11.3 `Project`).
// F12 builds "① Idea → Create storyboard" WITHOUT the AI: C2 saves the project in state `draft`
// with no job. F15 changes C2 to the full spec (state `planning` + a queued `plan` job in the same
// transaction, planRequestCount 1, answer 202 with the job). See API.md C2 "Until F15".

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

/** First 120 characters of the idea, spaces and line breaks collapsed, never cutting an emoji in half. */
export function titleFromIdea(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_MAX) return flat;
  let end = TITLE_MAX;
  const last = flat.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // a high surrogate: keep the pair together
  return flat.slice(0, end).trimEnd();
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
  activeJobType: null;
  input: { type: InputType; text: string; brainstormChoice: BrainstormChoice | null };
  stateVersion: number;
  currentPlanVersionId: string | null;
  approvedPlanVersionId: string | null;
  currentRenderId: string | null;
  activeJobId: string | null;
  activeJob: null;
  lastError: { code: string; message: string; at: string } | null;
  allowedActions: string[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const hexOrNull = (id: ObjectId | null) => (id ? id.toHexString() : null);

/**
 * Database document → API resource. Jobs, posts and thumbnails don't exist yet (F15, F23, F30), so
 * those fields are null. `allowedActions` is empty until the endpoints behind them exist (rename
 * and archive: F21; the job actions: F15).
 */
export function toProjectResource(doc: ProjectDocument): ProjectResource {
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
    activeJobType: null,
    input: { type: doc.input.type, text: doc.input.text, brainstormChoice: doc.input.brainstormChoice },
    stateVersion: doc.stateVersion,
    currentPlanVersionId: hexOrNull(doc.currentPlanVersionId),
    approvedPlanVersionId: hexOrNull(doc.approvedPlanVersionId),
    currentRenderId: hexOrNull(doc.currentRenderId),
    activeJobId: hexOrNull(doc.activeJobId),
    activeJob: null,
    lastError: doc.lastError ? { code: doc.lastError.code, message: doc.lastError.message, at: doc.lastError.at.toISOString() } : null,
    allowedActions: [],
    archivedAt: doc.archivedAt ? doc.archivedAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** The C2 answer until F15: 201 with the project and no job. */
export const CREATE_PROJECT_STATUS = 201;
export type CreateProjectResponse = { project: ProjectResource; job: null };

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
 * C2 without AI (F12). In ONE transaction (DATABASE.md §7.2 #1): +1 on today's projects counter
 * (only while within 5), insert the project, and, when the request carried an Idempotency-Key,
 * save the answer on its record. So a crash can never leave a counted project that doesn't exist,
 * a project that wasn't counted, or a saved project whose click would run again on retry.
 * Throws ProjectQuotaExceededError (nothing saved) when the limit is reached, and
 * IdempotencyLockLostError (nothing saved) when a repeat of the same click took the record over.
 */
export async function createProject(
  db: Db,
  input: { ownerId: string; timezone: string; body: CreateProjectBody; idempotencyLock?: IdempotencyLock | null; now?: Date },
): Promise<CreateProjectResponse> {
  const now = input.now ?? new Date();
  const doc: ProjectDocument = {
    _id: new ObjectId(),
    ownerId: new ObjectId(input.ownerId),
    schemaVersion: PROJECT_SCHEMA_VERSION,
    title: titleFromIdea(input.body.text),
    language: input.body.language,
    voiceGender: input.body.voiceGender,
    input: { type: input.body.inputType, text: input.body.text, brainstormChoice: input.body.brainstormChoice ?? null },
    state: "draft",
    currentPlanVersionId: null,
    approvedPlanVersionId: null,
    currentRenderId: null,
    activeJobId: null,
    stateVersion: 1,
    planRequestCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const response: CreateProjectResponse = { project: toProjectResource(doc), job: null };

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
      // Last write: if another request took this click over meanwhile, this throws and nothing
      // (counter, project) is kept.
      if (input.idempotencyLock) await finishIdempotencyInTransaction(db, input.idempotencyLock, CREATE_PROJECT_STATUS, response, session);
    });
  } finally {
    await session.endSession();
  }
  return response;
}

/**
 * One project of this owner, or null: a malformed id, someone else's project and a missing one all
 * look the same, so nobody can learn that another user's project exists (ARCHITECTURE §10.3).
 */
export async function getOwnedProject(db: Db, ownerId: string, projectId: string): Promise<ProjectDocument | null> {
  if (!/^[0-9a-f]{24}$/.test(projectId) || !/^[0-9a-f]{24}$/.test(ownerId)) return null;
  return db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: new ObjectId(projectId), ownerId: new ObjectId(ownerId) });
}
