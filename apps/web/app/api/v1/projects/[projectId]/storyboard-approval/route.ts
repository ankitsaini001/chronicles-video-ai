import {
  API_RATE_LIMITS,
  approveAndGenerate,
  assertLanguageEnabled,
  getLatestPlanJob,
  getLatestReviseJob,
  getOwnedProject,
  IdempotencyLockLostError,
  ProjectActionError,
  StoryboardApprovalBodySchema,
  toJobResource,
  toProjectResource,
  toStoryboardApprovalResource,
  type ApproveAndGenerateResult,
} from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { API_MESSAGES, ApiProblem, ApiResult } from "@/lib/api/v1";
import { toApiProblem } from "@/lib/plan/api";
import { sendPlanEvent } from "@/lib/plan/jobs";
import { assertGenerateReady } from "@/lib/video/api";

// D8 POST /api/v1/projects/{projectId}/storyboard-approval (docs/API.md D8, §9; F20 + F23):
// "Approve & generate video" (and "Generate video" for a version that is already approved but has no
// video job, e.g. one approved in F20 or a cancelled job). The creator approves the EXACT version on
// screen: body (strict) `planVersionId`, `planHash`, `expectedStateVersion`. Idempotency-Key required.
// Rate: 10 per hour.
// Order: the project (404) → the language switch (422 LANGUAGE_UNAVAILABLE, before anything is
// counted) → the video job set-up (Inngest, voice, R2; else 500, nothing saved) → ONE transaction
// (packages/db/src/generate-jobs.ts approveAndGenerate): the checks, videos/day (3, new job only),
// the voice characters still to record (creator 3,000/month, then app 9,000/month), the approval
// (reused when the version has one), the queued `generate` job (key gen:{planVersionId}; a failed or
// cancelled one is queued again), project → `generating`. AFTER the commit: `video.generate.requested`.
// Answers: 202 { approval, job, project } · 200 (same shape) when this version already has a video
// (no job, no limits: the project points back to it, `video_ready`).
// Errors: 404 · 409 STALE_VERSION · 409 APPROVAL_STALE · 422 PLAN_INVALID · 409 INVALID_STATE ·
// 409 JOB_ALREADY_RUNNING · 422 LANGUAGE_UNAVAILABLE · 429 QUOTA_EXCEEDED (videos_per_day,
// voice_characters_per_month) · 503 SPEND_CEILING (the app's monthly voice characters).

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.approvePerUser,
    body: StoryboardApprovalBodySchema,
    idempotent: true,
    handle: async ({ db, user, body, idempotencyLock }) => {
      // The project and the language switch first: a clear 404 / 422 even when the video job isn't set
      // up (both are checked again inside the transaction).
      const owned = await getOwnedProject(db, user.id, projectId);
      if (!owned) return toApiProblem(new ProjectActionError("NOT_FOUND", "We couldn't find this project."));
      try {
        assertLanguageEnabled(owned.language);
      } catch (error) {
        toApiProblem(error);
      }
      const voice = assertGenerateReady();
      // The project's newest jobs (read first), so the answer's `allowedActions` match C3's.
      const related = { latestPlanJob: await getLatestPlanJob(db, owned._id), latestReviseJob: await getLatestReviseJob(db, owned._id) };
      const answer = (out: ApproveAndGenerateResult) => ({
        approval: toStoryboardApprovalResource(out.approval),
        job: toJobResource(out.job),
        // `activeJob` stays null in `project`: the full job is returned next to it (API.md D8).
        project: toProjectResource(out.project, { ...related, activeJob: out.kind === "queued" ? out.job : null, embedActiveJob: false, latestGenerateJob: out.job }),
      });
      const status = (out: ApproveAndGenerateResult) => (out.kind === "queued" ? 202 : 200);
      let out: ApproveAndGenerateResult;
      try {
        out = await approveAndGenerate(db, { ownerId: user.id, projectId, timezone: user.timezone, body, voice, idempotencyLock, respond: (o) => ({ status: status(o), body: answer(o) }) });
      } catch (error) {
        if (error instanceof IdempotencyLockLostError) throw new ApiProblem(409, "IDEMPOTENCY_IN_PROGRESS", API_MESSAGES.IDEMPOTENCY_IN_PROGRESS);
        return toApiProblem(error);
      }
      // After the commit (never inside the transaction). A lost send is sent again by the stuck-job rule.
      if (out.kind === "queued") await sendPlanEvent(db, out.job);
      return new ApiResult(status(out), answer(out));
    },
  })(request);
}
