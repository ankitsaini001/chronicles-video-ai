import { type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { cleanPostCaptionText, POST_CAPTION_LIMITS, postCaptionLength } from "./post-caption";
import { PROJECTS_COLLECTION, type ProjectDocument } from "./projects";
import { USAGE_LIMITS } from "./usage";

// F29 "AI caption + hashtags" (API.md H1, H7; DATABASE.md §4.8 `captionDraft`): the request bodies,
// the count of one AI caption suggestion toward the project's 20 AI requests, and the saved draft.
// Every function takes the signed-in user's id and puts it in every filter (§6.3).

/** H1 request body. `renderId`: the video on screen (24 hex) or "current". Strict. */
export const CaptionSuggestionBodySchema = z.strictObject({
  renderId: z.string({ error: "must be text" }).regex(/^(current|[0-9a-f]{24})$/, { error: "must be a video id or current" }),
  /**
   * F29: the page's automatic first suggestion sends `true`: if a caption is already saved (another
   * tab, a quick reload), H1 answers 409 `draft_exists` with that draft and asks no AI.
   */
  onlyIfEmpty: z.boolean({ error: "must be true or false" }).optional(),
});
export type CaptionSuggestionBody = z.output<typeof CaptionSuggestionBodySchema>;

/** H7 request body: the whole caption text, 0–2,200 characters after cleaning (an empty box is a valid draft). Strict. */
export const CaptionDraftBodySchema = z.strictObject({
  text: z
    .string({ error: "must be text" })
    .transform(cleanPostCaptionText)
    .refine((text) => postCaptionLength(text) <= POST_CAPTION_LIMITS.textMax, { error: `must be at most ${POST_CAPTION_LIMITS.textMax.toLocaleString("en-IN")} characters` }),
});
export type CaptionDraftBody = z.output<typeof CaptionDraftBodySchema>;

export type CaptionDraftSource = "ai" | "edited";
export type CaptionDraftDocument = NonNullable<ProjectDocument["captionDraft"]>;

/** API.md H1/H7 `CaptionDraft`. */
export type CaptionDraftResource = { text: string; updatedAt: string; source: CaptionDraftSource };

export function toCaptionDraftResource(draft: CaptionDraftDocument): CaptionDraftResource {
  return { text: draft.text, updatedAt: draft.updatedAt.toISOString(), source: draft.source };
}

export type CaptionRequestCount = { ok: true; used: number } | { ok: false; reason: "quota"; used: number } | { ok: false; reason: "state" };

/**
 * Count ONE AI caption suggestion toward the project's 20 AI requests (`planRequestCount`, the same
 * counter and rule as storyboard requests and D5 changes: +1 when the request really goes to Gemini,
 * only while below 20; repairs and busy-retries inside the same suggestion add nothing). One atomic
 * update that also re-checks the video: the project is still `video_ready` with this video. Called
 * right before the first Gemini request, after every other check.
 */
export async function countCaptionRequest(
  db: Db,
  input: { ownerId: string; projectId: ObjectId; renderId: ObjectId; now?: Date },
): Promise<CaptionRequestCount> {
  const limit = USAGE_LIMITS.planRequestsPerProject;
  const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
  const ownerId = new ObjectId(input.ownerId);
  const counted = await projects.findOneAndUpdate(
    { _id: input.projectId, ownerId, state: "video_ready", currentRenderId: input.renderId, planRequestCount: { $lt: limit } },
    // `updatedAt` is left alone: a caption suggestion doesn't change the project (My videos order).
    { $inc: { planRequestCount: 1 } },
    { returnDocument: "after", projection: { planRequestCount: 1 } },
  );
  if (counted) return { ok: true, used: counted.planRequestCount };
  const project = await projects.findOne({ _id: input.projectId, ownerId }, { projection: { state: 1, currentRenderId: 1, planRequestCount: 1 } });
  if (project && project.state === "video_ready" && project.currentRenderId?.equals(input.renderId) && project.planRequestCount >= limit) {
    return { ok: false, reason: "quota", used: project.planRequestCount };
  }
  return { ok: false, reason: "state" };
}

/**
 * Save the caption draft on the owner's project (H1: `source: "ai"`, H7: `"edited"`). Only while the
 * project's video is ready (`video_ready`; F30 adds the publish states). Returns the saved draft, or
 * null when the project isn't the owner's or isn't ready (the caller answers 404 / 409).
 * `stateVersion` and `updatedAt` are NOT changed: a caption is not a project change (another tab's
 * storyboard or video actions never see STALE_VERSION because of it).
 */
export async function saveCaptionDraft(
  db: Db,
  input: { ownerId: string; projectId: ObjectId; text: string; source: CaptionDraftSource; now?: Date },
): Promise<CaptionDraftDocument | null> {
  const draft: CaptionDraftDocument = { text: input.text, updatedAt: input.now ?? new Date(), source: input.source };
  const result = await db
    .collection<ProjectDocument>(PROJECTS_COLLECTION)
    .updateOne({ _id: input.projectId, ownerId: new ObjectId(input.ownerId), state: "video_ready" }, { $set: { captionDraft: draft } });
  return result.matchedCount === 1 ? draft : null;
}
