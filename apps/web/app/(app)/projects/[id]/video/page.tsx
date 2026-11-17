import {
  displayStateOf,
  failedChangeFor,
  findProjectRender,
  getCurrentPlanVersion,
  getDb,
  isLanguageEnabled,
  LANGUAGE_NAMES,
  listRevisions,
  readDbConfig,
  toJobResource,
  toRenderSummary,
  USAGE_LIMITS,
} from "@bytereel/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ProjectStepper } from "@/components/app/ProjectStepper";
import { MakingVideoScreen } from "@/components/video/MakingVideoScreen";
import { ReviewVideoScreen } from "@/components/video/ReviewVideoScreen";
import { requireUser } from "@/lib/auth/session";
import { toProjectResourceOf } from "@/lib/plan/api";
import { loadProjectWithJobs, videosAhead } from "@/lib/plan/jobs";
import { videoMediaDeps } from "@/lib/video/media";
import { captionFailureOf, storyboardChangedSince } from "@/lib/video/review-state";

// ③ Video (F23, F24; ARCHITECTURE §11, PRD §6.3, Stitch "Step 3 Making video" and "Step 3 Review
// video"): the video while it is made (the four steps, Cancel), after a failure (the plain message,
// Try again), and when it is ready (F24: the player, the video versions, Download MP4). After a failure
// or when ready, "Edit storyboard" (and the stepper's "2 Storyboard") open the storyboard. Only the
// owner sees it: another user's project, a missing one and a malformed id all get the same 404 page.
// A project on another step goes back to /projects/[id], which sends it to its step. An archived
// project opens read-only.
// F25: the ready video has the Captions tab (caption fixes); while a fix is rendered the progress
// screen shows its two steps (Updating captions → Rendering). A failed or cancelled fix leaves the
// project `video_ready`; after a FAILED one the review screen shows a note (Try again only when
// trying again can help). A cancelled fix shows no note.
// F26: the ready video also has the "Ask for changes" tab (D5/D6 `stage: video`), offered while
// `request_revision` is allowed (no job running, under the 20 AI requests). While a change runs the
// project stays `video_ready` (only `activeJobId` is set): the video plays and downloads, the
// Captions tab waits. After a change the project is `storyboard_ready` with its video kept: this
// page still shows that video ("Back to video" from the storyboard), read-only, with a note to
// approve the new storyboard there. "Changed" means the video was made from another storyboard
// version than the current one (lib/video/review-state.ts), not just the state.

export const metadata: Metadata = { title: "Your video" };

export default async function VideoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const settings = readDbConfig(process.env);
  if (!settings.ok) throw new Error(settings.problems.join(" "));
  const db = getDb(settings.config);
  const loaded = await loadProjectWithJobs(db, user.id, id);
  if (!loaded) notFound();
  const { project } = loaded;
  const projectId = project._id.toHexString();
  const state = displayStateOf(project);
  const resource = toProjectResourceOf(loaded);
  const archived = project.state === "archived";

  const frame = (screen: ReactNode) => (
    <div className="mx-auto flex w-full flex-col">
      <div className="relative mb-8 flex flex-col items-center gap-4 sm:mb-12 sm:flex-row sm:justify-center">
        <Link href="/dashboard" className="self-start text-xs font-medium text-muted transition-colors hover:text-text sm:absolute sm:left-0 sm:self-center">
          ← My videos
        </Link>
        <ProjectStepper current="video" hrefs={state === "generating" ? {} : { storyboard: `/projects/${projectId}/storyboard` }} />
      </div>
      {screen}
    </div>
  );

  // F26: the kept video after a change (storyboard_ready with a currentRenderId) opens here too.
  if (state === "video_ready" || (state === "storyboard_ready" && project.currentRenderId !== null)) {
    // F24: the project's video. Its thumbnail and MP4 links (15 minutes, private) are made only after
    // the owner check above; a link that couldn't be made is fetched again by the screen.
    const render = await findProjectRender(db, project, "current");
    if (!render || render.status !== "ready") throw new Error("This project's video could not be found.");
    const storyboardChanged = storyboardChangedSince({ state, currentPlanVersionId: project.currentPlanVersionId, renderPlanVersionId: render.planVersionId });
    const media = videoMediaDeps(db);
    const [thumbnailUrl, videoUrl] = await Promise.all([
      media.presign(render.thumbnailKey).then((link) => link.url, () => null),
      media.presign(render.mp4Key).then((link) => link.url, () => null),
    ]);
    // F26: the video-stage change requests (D6) and the base storyboard version they are made on.
    const [current, history] = await Promise.all([getCurrentPlanVersion(db, project), listRevisions(db, project, { limit: 20, cursor: null, stage: "video" })]);
    if (!current) throw new Error("This project's storyboard could not be found.");
    // The newest change request failed: its message (and Try again, by the revise job's own rule) shows under it, when it was asked here.
    const failedChange = failedChangeFor(project, loaded.latestReviseJob, history.items[0]);
    const activeJob = resource.activeJob;
    const changeRunning = activeJob?.type === "revise";
    const languageOn = isLanguageEnabled(project.language);
    // The last caption fix made on THIS video, when it FAILED (a fix the creator cancelled shows no note).
    const lastCaptionJob = captionFailureOf({ state, job: loaded.latestCaptionJob, renderId: render._id, retryAllowed: resource.allowedActions.includes("retry_job"), archived });
    return frame(
      <ReviewVideoScreen
        projectId={projectId}
        title={project.title}
        currentPlanVersionId={project.currentPlanVersionId?.toHexString() ?? null}
        render={toRenderSummary(render, project, thumbnailUrl)}
        videoUrl={videoUrl}
        canEditStoryboard={resource.allowedActions.includes("edit_storyboard") && !archived}
        stateVersion={project.stateVersion}
        canEditCaptions={resource.allowedActions.includes("edit_captions") && !archived && !storyboardChanged}
        lastCaptionJob={lastCaptionJob}
        storyboardChanged={storyboardChanged}
        captionsNote={
          changeRunning
            ? "Caption fixes wait until your change request is finished."
            : storyboardChanged
              ? "Your storyboard has changes that aren't in this video yet, so its captions can't be fixed now."
              : null
        }
        changes={{
          baseVersionId: current._id.toHexString(),
          scenes: current.plan.scenes.map((scene) => ({ id: scene.id })),
          revisions: history.items.reverse(),
          activeJob: changeRunning ? activeJob : null,
          failedJob: failedChange ? { id: failedChange.id, message: failedChange.message } : null,
          canRequest: !storyboardChanged && resource.allowedActions.includes("request_revision") && !archived,
          canRetry: !storyboardChanged && failedChange?.canRetry === true,
          requestsUsedUp: project.planRequestCount >= USAGE_LIMITS.planRequestsPerProject,
          unavailableNote: !languageOn
            ? `AI changes aren't available for ${LANGUAGE_NAMES[project.language]} videos right now. You can still edit the narration yourself.`
            : storyboardChanged
              ? "Your storyboard has changes that aren't in this video yet. Ask for more changes on the storyboard."
              : null,
        }}
      />,
    );
  }

  // Otherwise only a video being made or a failed one opens here; another step goes back to /projects/[id].
  if (state !== "generating" && state !== "generate_failed") redirect(`/projects/${projectId}`);
  const job = loaded.activeJob ?? loaded.latestGenerateJob ?? null;
  return frame(
    <MakingVideoScreen
      key={`${state}:${project.stateVersion}`}
      projectId={projectId}
      title={project.title}
      state={state}
      job={job ? toJobResource(job, { ahead: await videosAhead(db, job) }) : null}
      error={project.lastError ? { code: project.lastError.code, message: project.lastError.message } : null}
      allowedActions={resource.allowedActions}
      archived={archived}
      kind={job?.type === "caption" ? "captions" : "video"}
    />,
  );
}
