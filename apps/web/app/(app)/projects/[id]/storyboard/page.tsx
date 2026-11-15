import { displayStateOf, getCurrentPlanVersion, getDb, listRevisions, loadPlanVersionResource, readDbConfig, STORYBOARD_EDIT_STATES, USAGE_LIMITS } from "@bytereel/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ProjectStepper } from "@/components/app/ProjectStepper";
import { StoryboardScreen } from "@/components/storyboard/StoryboardScreen";
import { requireUser } from "@/lib/auth/session";
import { toProjectResourceOf } from "@/lib/plan/api";
import { loadProjectWithJobs } from "@/lib/plan/jobs";
import { availableSamples } from "@/lib/voices";

// ② Review storyboard (F16; ARCHITECTURE §11, PRD §6.2, Stitch "Step 2 Storyboard").
// Reads the same data as C3 (project) and D2 `current` (the full storyboard), straight from the
// database, then hands it to the screen. Only the owner sees it: another user's project, a missing
// one and a malformed id all get the same 404 page (ARCHITECTURE §10.3).
// It opens in every state where the storyboard may be changed (STORYBOARD_EDIT_STATES:
// storyboard_ready, which is also where a cancelled video lands; generate_failed and video_ready,
// F23 "Edit storyboard" from the video page). Any other project (idea, "Writing…", a video being
// made) goes back to /projects/[id], which shows its step. An archived project (F21) still opens
// here from a saved link, read-only (allowedActions is empty, so nothing can be edited or approved).

export const metadata: Metadata = { title: "Storyboard" };

export default async function StoryboardPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const settings = readDbConfig(process.env);
  if (!settings.ok) throw new Error(settings.problems.join(" "));
  const db = getDb(settings.config);
  const loaded = await loadProjectWithJobs(db, user.id, id);
  if (!loaded) notFound();
  const { project } = loaded;
  const projectId = project._id.toHexString();
  const shown = displayStateOf(project);
  if (!STORYBOARD_EDIT_STATES.includes(shown)) redirect(`/projects/${projectId}`);
  // F23: a failed or ready video keeps its page one click away (the stepper's "3 Video").
  const videoHref = shown === "generate_failed" || shown === "video_ready" ? `/projects/${projectId}/video` : undefined;
  const current = await getCurrentPlanVersion(db, project);
  if (!current) redirect(`/projects/${projectId}`);
  const [version, history] = await Promise.all([loadPlanVersionResource(db, project, current), listRevisions(db, project, { limit: 20, cursor: null, stage: "storyboard" })]);
  const latestChange = loaded.latestReviseJob;
  const failedChange = latestChange?.state === "failed" && latestChange.error ? { id: latestChange._id.toHexString(), message: latestChange.error.message } : null;

  return (
    <div className="mx-auto flex w-full flex-col pb-28">
      <div className="relative mb-6 flex flex-col items-center gap-4 sm:mb-8 sm:flex-row sm:justify-center">
        <Link href="/dashboard" className="self-start text-xs font-medium text-muted transition-colors hover:text-text sm:absolute sm:left-0 sm:self-center">
          ← My videos
        </Link>
        <ProjectStepper current="storyboard" hrefs={{ storyboard: `/projects/${projectId}/storyboard`, ...(videoHref ? { video: videoHref } : {}) }} />
      </div>
      <StoryboardScreen
        project={toProjectResourceOf(loaded)}
        version={version}
        revisions={history.items.reverse()}
        failedChange={failedChange}
        requestsUsedUp={project.planRequestCount >= USAGE_LIMITS.planRequestsPerProject}
        samplePresets={[...availableSamples()]}
      />
    </div>
  );
}
