import { displayStateOf, failedChangeFor, getCurrentPlanVersion, getDb, listRevisions, loadPlanVersionResource, readDbConfig, readUsageCount, STORYBOARD_EDIT_STATES, USAGE_LIMITS } from "@bytereel/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ProjectStepper } from "@/components/app/ProjectStepper";
import { StoryboardScreen } from "@/components/storyboard/StoryboardScreen";
import { requireUser } from "@/lib/auth/session";
import { toProjectResourceOf } from "@/lib/plan/api";
import { loadProjectWithJobs } from "@/lib/plan/jobs";
import { approveLimitFor, newVideoCost } from "@/lib/video/narration-cost";
import { newVideoNote } from "@/lib/video/new-video";
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
// F26: when the project already has a video (it is kept after a change) and this version can be
// approved, the page works out what the new video would record (lib/video/narration-cost.ts: the
// same rule D8 checks the voice limits with; database only, no voice call) for the note above the
// scenes, and the stepper's "3 Video" opens that video.
// F27: whenever this version can be sent to D8 ("Approve & …" or "Generate video"), the page asks
// approveLimitFor (the same functions and order as D8, read-only) whether a limit would refuse it
// now; the screen then says why and greys out the button. Approving a version that already has its
// video (`reuse`) costs nothing: no cost note, never refused. The "counts as 1 of your 3 videos
// today" line only when approving starts a new job (`new`) and today still has one left.

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
  // F23: a failed or ready video keeps its page one click away (the stepper's "3 Video"); F26: so does
  // the older video after a change.
  const videoHref = shown === "generate_failed" || shown === "video_ready" || project.currentRenderId ? `/projects/${projectId}/video` : undefined;
  const current = await getCurrentPlanVersion(db, project);
  if (!current) redirect(`/projects/${projectId}`);
  const [version, history] = await Promise.all([loadPlanVersionResource(db, project, current), listRevisions(db, project, { limit: 20, cursor: null, stage: "storyboard" })]);
  // The newest change request failed, and it was asked HERE (not on the video page): its message and
  // Try again (by the revise job's own rule, not the shared retry_job flag).
  const failedChange = failedChangeFor(project, loaded.latestReviseJob, history.items[0]);
  const resource = toProjectResourceOf(loaded);
  const startable = version.valid && (resource.allowedActions.includes("approve_storyboard") || resource.allowedActions.includes("generate_video"));
  const limit = startable ? await approveLimitFor(db, { project, version: current, timezone: user.timezone }) : null;
  const approvable = project.currentRenderId !== null && resource.allowedActions.includes("approve_storyboard") && version.valid && limit?.path !== "reuse";
  const [cost, videosToday] = approvable ? await Promise.all([newVideoCost(db, project, current.plan), readUsageCount(db, user.id, "videos", user.timezone)]) : [null, 0];
  // No "counts as 1 of your 3 videos" next to a "Can't approve now" note.
  const today = limit?.path === "new" && !limit.refusal && videosToday < USAGE_LIMITS.videosPerDay ?{ used: videosToday, limit: USAGE_LIMITS.videosPerDay } : null;

  return (
    <div className="mx-auto flex w-full flex-col pb-28">
      <div className="relative mb-6 flex flex-col items-center gap-4 sm:mb-8 sm:flex-row sm:justify-center">
        <Link href="/dashboard" className="self-start text-xs font-medium text-muted transition-colors hover:text-text sm:absolute sm:left-0 sm:self-center">
          ← My videos
        </Link>
        <ProjectStepper current="storyboard" hrefs={{ storyboard: `/projects/${projectId}/storyboard`, ...(videoHref ? { video: videoHref } : {}) }} />
      </div>
      <StoryboardScreen
        project={resource}
        version={version}
        revisions={history.items.reverse()}
        failedChange={failedChange}
        requestsUsedUp={project.planRequestCount >= USAGE_LIMITS.planRequestsPerProject}
        samplePresets={[...availableSamples()]}
        newVideoNote={cost ? newVideoNote(cost, today) : null}
        approveLimit={limit?.refusal ?? null}
      />
    </div>
  );
}
