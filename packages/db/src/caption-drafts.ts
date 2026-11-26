import { type Db, type Filter, ObjectId, type UpdateFilter } from "mongodb";
import { z } from "zod";
import { captionHash, invalidateOpenPosts } from "./post-approval";
import { cleanPostCaptionText, POST_CAPTION_LIMITS, postCaptionLength } from "./post-caption";
import { PROJECTS_COLLECTION, type ProjectDocument, type ProjectState } from "./projects";
import { USAGE_LIMITS } from "./usage";

// F29 "AI caption + hashtags" (API.md H1, H7; DATABASE.md §4.8 `captionDraft`): the request bodies,
// the count of one AI caption suggestion toward the project's 20 AI requests (with its in-flight
// lease), and the saved draft. Every function takes the signed-in user's id and puts it in every
// filter (§6.3).
// F30 (decision 1): the caption can also be edited in `publish_failed`. There a save whose text (NFC)
// differs from the approved caption (`posts.approval.captionHash`) cancels the failed post's approval
// in the SAME transaction (post → `approval_invalidated` + notification; PRD §7: a caption change
// invalidates the approval), so Try again becomes "approve again".

/**
 * F30: the project states in which the caption may be edited (H1, H7). F31 adds `scheduled`: the
 * "needs approval" and Schedule-again forms keep the caption box; a saved text that differs from a
 * still-scheduled post's approved caption cancels that approval (the same rule as `publish_failed`).
 */
export const CAPTION_EDIT_STATES: readonly ProjectState[] = ["video_ready", "publish_failed", "scheduled"];
const EDITABLE = { $in: [...CAPTION_EDIT_STATES] };

/** How long one AI suggestion holds the project's lease (H1 itself stops after 30 s). */
export const CAPTION_SUGGESTION_LEASE_MS = 60_000;

/** H1 request body. `renderId`: the video on screen (24 hex) or "current". Strict. */
export const CaptionSuggestionBodySchema = z.strictObject({
  renderId: z.string({ error: "must be text" }).regex(/^(current|[0-9a-f]{24})$/, { error: "must be a video id or current" }),
  /**
   * F29: the page's automatic first suggestion sends `true`: it only fills an EMPTY caption box. A
   * caption already saved (another tab, a quick reload) → 409 `draft_exists` with that caption, no AI;
   * a caption typed while the AI was writing is kept (the suggestion is not saved over it).
   */
  onlyIfEmpty: z.boolean({ error: "must be true or false" }).optional(),
});
export type CaptionSuggestionBody = z.output<typeof CaptionSuggestionBodySchema>;

/**
 * H7 request body: the whole caption text, 0–2,200 characters after cleaning (an empty box is a valid
 * draft), and optionally `clientSeq`, a number that grows with every save from the page (F29 review):
 * a save whose number isn't higher than the stored one arrived late and is skipped. Strict.
 */
export const CaptionDraftBodySchema = z.strictObject({
  text: z
    .string({ error: "must be text" })
    .transform(cleanPostCaptionText)
    .refine((text) => postCaptionLength(text) <= POST_CAPTION_LIMITS.textMax, { error: `must be at most ${POST_CAPTION_LIMITS.textMax.toLocaleString("en-IN")} characters` }),
  clientSeq: z.number({ error: "must be a number" }).int({ error: "must be a whole number" }).min(0, { error: "must be 0 or more" }).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type CaptionDraftBody = z.output<typeof CaptionDraftBodySchema>;

export type CaptionDraftSource = "ai" | "edited";
export type CaptionDraftDocument = NonNullable<ProjectDocument["captionDraft"]>;

/** API.md H1/H7 `CaptionDraft`. */
export type CaptionDraftResource = { text: string; updatedAt: string; source: CaptionDraftSource };

export function toCaptionDraftResource(draft: CaptionDraftDocument): CaptionDraftResource {
  return { text: draft.text, updatedAt: draft.updatedAt.toISOString(), source: draft.source };
}

/** True when the box has something in it (whitespace only counts as empty). */
export function hasCaptionText(draft: { text: string } | null | undefined): boolean {
  return !!draft && draft.text.trim() !== "";
}

/** Filter: no caption saved, or only whitespace (`captionDraft: null` matches a missing field too). */
const EMPTY_DRAFT: Filter<ProjectDocument> = { $or: [{ captionDraft: null }, { "captionDraft.text": { $regex: /^\s*$/ } }] };
/** Filter: no AI suggestion running (no lease, or an expired one). */
const leaseFree = (now: Date): Filter<ProjectDocument> => ({ captionSuggestingUntil: { $not: { $gt: now } } });

export type CaptionRequestCount =
  | { ok: true; used: number; leaseId: string }
  | { ok: false; reason: "quota"; used: number }
  | { ok: false; reason: "state" }
  | { ok: false; reason: "draft_exists"; draft: CaptionDraftDocument }
  | { ok: false; reason: "in_progress" };

/**
 * Count ONE AI caption suggestion toward the project's 20 AI requests (`planRequestCount`, the same
 * counter and rule as storyboard requests and D5 changes: +1 when the request really goes to Gemini,
 * only while below 20; repairs and busy-retries inside the same suggestion add nothing) AND take the
 * project's 60 s suggestion lease, in ONE atomic update that also re-checks: the project is still
 * `video_ready` with this video, no other suggestion holds a live lease, and (onlyIfEmpty) the caption
 * box is still empty. So two requests at the same moment (a reload, two tabs) can never both count
 * and call Gemini. When nothing matches, the project is read again to say why.
 */
export async function countCaptionRequest(
  db: Db,
  input: { ownerId: string; projectId: ObjectId; renderId: ObjectId; onlyIfEmpty?: boolean; now?: Date },
): Promise<CaptionRequestCount> {
  const limit = USAGE_LIMITS.planRequestsPerProject;
  const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
  const ownerId = new ObjectId(input.ownerId);
  const now = input.now ?? new Date();
  const leaseId = new ObjectId();
  const counted = await projects.findOneAndUpdate(
    {
      _id: input.projectId,
      ownerId,
      state: EDITABLE,
      currentRenderId: input.renderId,
      planRequestCount: { $lt: limit },
      $and: [leaseFree(now), ...(input.onlyIfEmpty ? [EMPTY_DRAFT] : [])],
    },
    // `updatedAt` is left alone: a caption suggestion doesn't change the project (My videos order).
    { $inc: { planRequestCount: 1 }, $set: { captionSuggestingUntil: new Date(now.getTime() + CAPTION_SUGGESTION_LEASE_MS), captionSuggestingId: leaseId } },
    { returnDocument: "after", projection: { planRequestCount: 1 } },
  );
  if (counted) return { ok: true, used: counted.planRequestCount, leaseId: leaseId.toHexString() };

  const project = await projects.findOne(
    { _id: input.projectId, ownerId },
    { projection: { state: 1, currentRenderId: 1, planRequestCount: 1, captionDraft: 1, captionSuggestingUntil: 1 } },
  );
  if (!project || !CAPTION_EDIT_STATES.includes(project.state) || !project.currentRenderId?.equals(input.renderId)) return { ok: false, reason: "state" };
  if (input.onlyIfEmpty && project.captionDraft && hasCaptionText(project.captionDraft)) return { ok: false, reason: "draft_exists", draft: project.captionDraft };
  if (project.captionSuggestingUntil && project.captionSuggestingUntil.getTime() > now.getTime()) return { ok: false, reason: "in_progress" };
  if (project.planRequestCount >= limit) return { ok: false, reason: "quota", used: project.planRequestCount };
  // Something changed between the two reads (e.g. a lease ended just now): say "in progress", the
  // page checks again a little later.
  return { ok: false, reason: "in_progress" };
}

/** Clear this request's lease (after its save, or when it failed). Only the request that took it. */
export async function releaseCaptionSuggestion(db: Db, input: { ownerId: string; projectId: ObjectId; leaseId: string }): Promise<void> {
  await db
    .collection<ProjectDocument>(PROJECTS_COLLECTION)
    .updateOne({ _id: input.projectId, ownerId: new ObjectId(input.ownerId), captionSuggestingId: new ObjectId(input.leaseId) }, { $unset: { captionSuggestingUntil: "", captionSuggestingId: "" } });
}

export type AiCaptionSave = { applied: true; draft: CaptionDraftDocument } | { applied: false; draft: CaptionDraftDocument };

/**
 * H1: save the AI's suggestion (`source: "ai"`) while the project's video is ready. With onlyIfEmpty
 * the save is conditional on the box still being empty: a caption the creator typed while the AI was
 * writing is KEPT and returned instead (`applied: false`). Null when the project isn't the owner's or
 * isn't ready any more. `stateVersion` and `updatedAt` are not changed.
 */
export async function saveAiCaptionDraft(
  db: Db,
  input: { ownerId: string; projectId: ObjectId; text: string; onlyIfEmpty?: boolean; now?: Date },
): Promise<AiCaptionSave | null> {
  const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
  const ownerId = new ObjectId(input.ownerId);
  const draft: CaptionDraftDocument = { text: input.text, updatedAt: input.now ?? new Date(), source: "ai" };
  const applied = await saveDraftWhere(db, { ownerId, projectId: input.projectId, draft, filter: input.onlyIfEmpty ? EMPTY_DRAFT : {}, update: { $set: { captionDraft: draft } } });
  if (applied) return { applied: true, draft };
  if (!input.onlyIfEmpty) return null;
  const project = await projects.findOne({ _id: input.projectId, ownerId }, { projection: { state: 1, captionDraft: 1 } });
  if (project && CAPTION_EDIT_STATES.includes(project.state) && project.captionDraft && hasCaptionText(project.captionDraft)) return { applied: false, draft: project.captionDraft };
  return null;
}

export type CaptionDraftSave = { applied: boolean; draft: CaptionDraftDocument };

/**
 * H7: save the creator's caption (`source: "edited"`) on the owner's project while its video is ready
 * (`video_ready`, or `publish_failed` since F30: see saveDraftWhere). With `clientSeq`, only if it is higher than the stored
 * one: an older save that arrives late (e.g. the request sent when the page was left) is skipped and
 * the stored caption is returned (`applied: false`). Null when the project isn't the owner's or isn't
 * ready. `stateVersion` and `updatedAt` are NOT changed: a caption is not a project change.
 */
export async function saveCaptionDraft(
  db: Db,
  input: { ownerId: string; projectId: ObjectId; text: string; clientSeq?: number | undefined; now?: Date },
): Promise<CaptionDraftSave | null> {
  const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
  const ownerId = new ObjectId(input.ownerId);
  const draft: CaptionDraftDocument = { text: input.text, updatedAt: input.now ?? new Date(), source: "edited" };
  const seq = input.clientSeq;
  const applied = await saveDraftWhere(db, {
    ownerId,
    projectId: input.projectId,
    draft,
    filter: seq !== undefined ? { $or: [{ captionDraftSeq: null }, { captionDraftSeq: { $lt: seq } }] } : {},
    update: { $set: { captionDraft: draft, ...(seq !== undefined ? { captionDraftSeq: seq } : {}) } },
  });
  if (applied) return { applied: true, draft };
  if (seq === undefined) return null;
  const project = await projects.findOne({ _id: input.projectId, ownerId }, { projection: { state: 1, captionDraft: 1 } });
  if (!project || !CAPTION_EDIT_STATES.includes(project.state)) return null;
  return { applied: false, draft: project.captionDraft ?? { text: "", updatedAt: draft.updatedAt, source: "edited" } };
}

/**
 * The one conditional save of a caption draft (H1, H7), ONE transaction: the project's state is read,
 * then the conditional update on that state (`video_ready` or `publish_failed`). In `publish_failed`
 * (F30), when the saved text (NFC) differs from the failed post's approved caption, that post →
 * `approval_invalidated` + notification in the same transaction.
 * True when the draft was saved.
 */
async function saveDraftWhere(
  db: Db,
  input: { ownerId: ObjectId; projectId: ObjectId; draft: CaptionDraftDocument; filter: Filter<ProjectDocument>; update: UpdateFilter<ProjectDocument> },
): Promise<boolean> {
  const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
  // F30 code review (nit 7): the state is read INSIDE the transaction, so the save and the approval
  // cancel can never act on a state that changed in between.
  const session = db.client.startSession();
  let saved = false;
  try {
    await session.withTransaction(async () => {
      saved = false;
      const current = await projects.findOne({ _id: input.projectId, ownerId: input.ownerId }, { session, projection: { state: 1 } });
      if (!current || !CAPTION_EDIT_STATES.includes(current.state)) return;
      const result = await projects.updateOne({ _id: input.projectId, ownerId: input.ownerId, state: current.state, ...input.filter }, input.update, { session });
      if (result.matchedCount !== 1) return;
      if (current.state === "video_ready") {
        saved = true;
        return;
      }
      await invalidateOpenPosts(db, session, {
        ownerId: input.ownerId,
        projectId: input.projectId,
        reason: "caption_edit",
        now: input.draft.updatedAt,
        extraFilter: { "approval.captionHash": { $ne: captionHash(input.draft.text) } },
      });
      saved = true;
    });
  } finally {
    await session.endSession();
  }
  return saved;
}
