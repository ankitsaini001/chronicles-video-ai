import { canRetryCaptionJob, type JobDocument, type ProjectState } from "@bytereel/db";
import type { ObjectId } from "mongodb";

// What the ready-video screen offers (F25, F26; F26 code review), as plain functions the page uses
// (server only: they read database documents).

/**
 * Does the storyboard have changes this video doesn't show? True when the video was made from
 * another storyboard version than the current one, or the project isn't `video_ready` (after a change
 * the new version waits for approval on the storyboard). Then the video is shown read-only: no
 * caption fixes, no change requests here. F30: a project whose post failed (`publish_failed`) still
 * has its ready video (captions, changes and the caption box stay available; each change cancels the
 * failed post's approval).
 */
export function storyboardChangedSince(input: { state: ProjectState; currentPlanVersionId: ObjectId | null; renderPlanVersionId: ObjectId }): boolean {
  const ready = input.state === "video_ready" || input.state === "publish_failed";
  return !ready || input.currentPlanVersionId === null || !input.renderPlanVersionId.equals(input.currentPlanVersionId);
}

export type CaptionFailure = { id: string; message: string; canRetry: boolean };

/**
 * The note after a FAILED caption fix on this video (a cancelled one shows none), only while the
 * project is `video_ready`. Try again needs `retry_job` (the server's rule) AND this caption job to be
 * retryable itself, so the shared flag set by another job never offers it alone.
 */
export function captionFailureOf(input: { state: ProjectState; job: JobDocument | null | undefined; renderId: ObjectId; retryAllowed: boolean; archived: boolean }): CaptionFailure | null {
  const { job } = input;
  if (input.state !== "video_ready" || !job || job.type !== "caption" || job.state !== "failed" || !job.inputRef.renderId?.equals(input.renderId)) return null;
  return {
    id: job._id.toHexString(),
    message: job.error?.message ?? "Something went wrong on our side. Please try again.",
    canRetry: input.retryAllowed && canRetryCaptionJob(job) && !input.archived,
  };
}
