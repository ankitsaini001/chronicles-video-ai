import {
  API_RATE_LIMITS,
  CaptionOverridesBodySchema,
  getLatestGenerateJob,
  getLatestPlanJob,
  getLatestReviseJob,
  IdempotencyLockLostError,
  saveCaptionFixes,
  toJobResource,
  toProjectResource,
  type SaveCaptionFixesResult,
} from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem, ApiResult } from "@/lib/api/v1";
import { toApiProblem } from "@/lib/plan/api";
import { sendPlanEvent } from "@/lib/plan/jobs";
import { assertCaptionJobsReady } from "@/lib/video/api";
import { captionDeps, checkCaptionFixes } from "@/lib/video/captions";

// F4 POST /api/v1/projects/{projectId}/renders/{renderId}/caption-overrides (docs/API.md F4, F25):
// "Save caption fixes". Fixes the caption TEXT of the project's video without changing the narration
// audio: the video is rendered again with the same recordings (no voice call). Idempotency-Key
// required. Rate: 10 per hour (its own counter). Body (strict): `edits` 1–50 of { sceneId,
// phraseIndex, text 1–200 after cleaning }, unique pairs; `expectedStateVersion`.
// Order: the project and the video (404) → archived / language (422) / a job running / another tab /
// not the project's video / not video_ready (409) → each fix against THIS video's captions.json (400:
// an unknown phrase, or "This caption is too long to fit on screen. Please shorten it.", with the
// path) → Inngest and R2 must be set up (else 500, nothing saved) → ONE transaction
// (packages/db/src/caption-fixes.ts saveCaptionFixes): the new override set (the previous fixes of
// the same storyboard version + these), the queued `caption` job (key cap:{setId}), project →
// `generating`. NO usage counter changes (not a video of the day, no voice characters). AFTER the
// commit: `video.recaption.requested`. Answer 202 { captionOverrideSetId, job, project }.
// `renderId` may be `current`.

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; renderId: string }> }): Promise<Response> {
  const { projectId, renderId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.captionFixesPerUser,
    body: CaptionOverridesBodySchema,
    idempotent: true,
    handle: async ({ db, user, body, idempotencyLock }) => {
      let checked: Awaited<ReturnType<typeof checkCaptionFixes>>;
      try {
        checked = await checkCaptionFixes(captionDeps(db), user.id, projectId, renderId, body);
      } catch (error) {
        return toApiProblem(error);
      }
      assertCaptionJobsReady();
      // The project's newest jobs (read first), so the answer's `allowedActions` match C3's.
      const related = {
        latestPlanJob: await getLatestPlanJob(db, checked.project._id),
        latestReviseJob: await getLatestReviseJob(db, checked.project._id),
        latestGenerateJob: await getLatestGenerateJob(db, checked.project._id),
      };
      const answer = (out: SaveCaptionFixesResult) => ({
        captionOverrideSetId: out.set._id.toHexString(),
        job: toJobResource(out.job),
        // `activeJob` stays null in `project`: the full job is returned next to it (like D8).
        project: toProjectResource(out.project, { ...related, activeJob: out.job, embedActiveJob: false, latestCaptionJob: out.job }),
      });
      let out: SaveCaptionFixesResult;
      try {
        out = await saveCaptionFixes(db, {
          ownerId: user.id,
          projectId,
          renderId,
          expectedStateVersion: body.expectedStateVersion,
          edits: checked.edits,
          idempotencyLock,
          respond: (o) => ({ status: 202, body: answer(o) }),
        });
      } catch (error) {
        if (error instanceof IdempotencyLockLostError) throw new ApiProblem(409, "IDEMPOTENCY_IN_PROGRESS", API_MESSAGES.IDEMPOTENCY_IN_PROGRESS);
        return toApiProblem(error);
      }
      // After the commit (never inside the transaction). A lost send is sent again by the stuck-job rule.
      await sendPlanEvent(db, out.job);
      return new ApiResult(202, answer(out));
    },
  })(request);
}
