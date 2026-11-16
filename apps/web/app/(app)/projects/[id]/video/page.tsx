import { currentStepOf, displayStateOf, findProjectRender, getDb, readDbConfig, toJobResource, toRenderSummary } from "@bytereel/db";
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

// ③ Video (F23, F24; ARCHITECTURE §11, PRD §6.3, Stitch "Step 3 Making video" and "Step 3 Review
// video"): the video while it is made (the four steps, Cancel), after a failure (the plain message,
// Try again), and when it is ready (F24: the player, the video versions, Download MP4). After a failure
// or when ready, "Edit storyboard" (and the stepper's "2 Storyboard") open the storyboard. Only the
// owner sees it: another user's project, a missing one and a malformed id all get the same 404 page.
// A project on another step goes back to /projects/[id], which sends it to its step. An archived
// project opens read-only.

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
  if (currentStepOf(state) !== "video" || (state !== "generating" && state !== "generate_failed" && state !== "video_ready")) redirect(`/projects/${projectId}`);
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

  if (state === "video_ready") {
    // F24: the project's video. Its thumbnail and MP4 links (15 minutes, private) are made only after
    // the owner check above; a link that couldn't be made is fetched again by the screen.
    const render = await findProjectRender(db, project, "current");
    if (!render || render.status !== "ready") throw new Error("This project's video could not be found.");
    const media = videoMediaDeps(db);
    const [thumbnailUrl, videoUrl] = await Promise.all([
      media.presign(render.thumbnailKey).then((link) => link.url, () => null),
      media.presign(render.mp4Key).then((link) => link.url, () => null),
    ]);
    return frame(
      <ReviewVideoScreen
        projectId={projectId}
        title={project.title}
        currentPlanVersionId={project.currentPlanVersionId?.toHexString() ?? null}
        render={toRenderSummary(render, project, thumbnailUrl)}
        videoUrl={videoUrl}
        canEditStoryboard={resource.allowedActions.includes("edit_storyboard") && !archived}
      />,
    );
  }

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
    />,
  );
}
