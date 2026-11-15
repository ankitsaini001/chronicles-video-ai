import { currentStepOf, displayStateOf, getDb, getRender, readDbConfig, toJobResource } from "@bytereel/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ProjectStepper } from "@/components/app/ProjectStepper";
import { MakingVideoScreen } from "@/components/video/MakingVideoScreen";
import { requireUser } from "@/lib/auth/session";
import { toProjectResourceOf } from "@/lib/plan/api";
import { loadProjectWithJobs, videosAhead } from "@/lib/plan/jobs";
import { thumbnailLink } from "@/lib/video/storage";

// ③ Video (F23; ARCHITECTURE §11, PRD §6.3, Stitch "Step 3 Making video"): the video while it is
// made (the four steps, Cancel), after a failure (the plain message, Try again), and when it is
// ready (its thumbnail; watching and downloading it here is F24). Only the owner sees it: another
// user's project, a missing one and a malformed id all get the same 404 page. A project on another
// step goes back to /projects/[id], which sends it to its step. An archived project opens read-only.

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
  const job = loaded.activeJob ?? loaded.latestGenerateJob ?? null;
  // The ready video's thumbnail: a 15-minute private link, made only after the owner check above.
  const render = state === "video_ready" && project.currentRenderId ? await getRender(db, project.ownerId, project.currentRenderId) : null;
  const thumbnailUrl = render ? await thumbnailLink(render.thumbnailKey).catch(() => null) : null;

  return (
    <div className="mx-auto flex w-full flex-col">
      <div className="relative mb-8 flex flex-col items-center gap-4 sm:mb-12 sm:flex-row sm:justify-center">
        <Link href="/dashboard" className="self-start text-xs font-medium text-muted transition-colors hover:text-text sm:absolute sm:left-0 sm:self-center">
          ← My videos
        </Link>
        <ProjectStepper current="video" />
      </div>
      <MakingVideoScreen
        key={`${state}:${project.stateVersion}`}
        projectId={projectId}
        title={project.title}
        state={state}
        job={job ? toJobResource(job, { ahead: await videosAhead(db, job) }) : null}
        thumbnailUrl={thumbnailUrl}
        error={project.lastError ? { code: project.lastError.code, message: project.lastError.message } : null}
        allowedActions={resource.allowedActions}
        archived={project.state === "archived"}
      />
    </div>
  );
}
