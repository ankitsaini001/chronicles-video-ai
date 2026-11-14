import { allowedActionsFor, currentStepOf, getCurrentPlanVersion, getDb, IDEA_LIMITS, readDbConfig, USAGE_LIMITS } from "@bytereel/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectStepper } from "@/components/app/ProjectStepper";
import { PlanJobPanel } from "@/components/project/PlanJobPanel";
import { StoryboardPreview } from "@/components/project/StoryboardPreview";
import { Button } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { loadProjectWithJobs } from "@/lib/plan/jobs";

// TEMPORARY project page (F12, F15): where "Create storyboard" lands.
// - `planning`: "Writing storyboard…" with the job's progress (polled every 2 s, PlanJobPanel).
// - `plan_failed`: the plain error, Try again and Edit idea.
// - `storyboard_ready`: the saved storyboard as a simple read-only list (the real storyboard
//   screen, /projects/[id]/storyboard, is F16; this address then sends you to the current step).
// Leaving and coming back keeps the progress: the job runs on the server (Inngest) and this page
// reads it again. Only the owner sees it: another user's project, a missing one and a malformed id
// all get the same 404 page, so nobody can tell whether a project exists (ARCHITECTURE §10.3).

export const metadata: Metadata = { title: "Your project" };

const LANGUAGE_LABELS = {
  en: <>English</>,
  hi: (
    <>
      <span lang="hi">हिंदी</span> Hindi
    </>
  ),
  hinglish: <>Hinglish</>,
} as const;

const VOICE_LABELS = { female: "Female voice", male: "Male voice" } as const;

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const settings = readDbConfig(process.env);
  if (!settings.ok) throw new Error(settings.problems.join(" "));
  const db = getDb(settings.config);
  const loaded = await loadProjectWithJobs(db, user.id, id);
  if (!loaded) notFound();
  const { project, activeJob, latestPlanJob } = loaded;
  const version = project.state === "storyboard_ready" ? await getCurrentPlanVersion(db, project) : null;
  const jobState = project.state === "planning" || project.state === "plan_failed" ? project.state : null;

  const eyebrow =
    project.state === "planning" ? "Writing storyboard" : project.state === "plan_failed" ? "Storyboard not ready" : version ? "Storyboard ready" : "Idea saved";

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col">
      <div className="relative mb-6 flex flex-col items-center gap-4 sm:mb-8 sm:flex-row sm:justify-center">
        <Link href="/dashboard" className="self-start text-xs font-medium text-muted transition-colors hover:text-text sm:absolute sm:left-0 sm:self-center">
          ← My videos
        </Link>
        <ProjectStepper current={currentStepOf(project.state)} />
      </div>
      <section aria-labelledby="project-title" className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-10">
        <p className={`mb-2 font-mono text-xs uppercase tracking-wider ${project.state === "plan_failed" ? "text-danger" : "text-success"}`}>{eyebrow}</p>
        <h1 id="project-title" className="mb-6 font-display text-2xl font-bold tracking-tight break-words text-text sm:text-[28px]">
          {project.title}
        </h1>

        {jobState && (
          <div className="mb-8">
            <PlanJobPanel
              // Keyed by state only: saving an edited idea (new stateVersion) must not reset the panel
              // and wipe an error shown after a refused Try again.
              key={project.state}
              projectId={project._id.toHexString()}
              state={jobState}
              stateVersion={project.stateVersion}
              jobId={latestPlanJob ? latestPlanJob._id.toHexString() : null}
              progress={activeJob ? { percent: activeJob.progress.percent, message: activeJob.progress.message } : null}
              lastError={project.lastError ? { code: project.lastError.code, message: project.lastError.message } : null}
              allowedActions={allowedActionsFor(project, latestPlanJob)}
              requestsUsedUp={project.planRequestCount >= USAGE_LIMITS.planRequestsPerProject}
              queuedAt={activeJob ? activeJob.queuedAt.toISOString() : null}
              idea={{ text: project.input.text, ...IDEA_LIMITS[project.input.type] }}
            />
          </div>
        )}

        {version ? (
          <div className="mb-8">
            <StoryboardPreview version={version} language={project.language} />
          </div>
        ) : (
          <dl className="mb-8 flex flex-col gap-5">
            <div>
              <dt className="mb-1.5 font-mono text-xs uppercase tracking-wider text-muted">Your idea</dt>
              <dd className="max-h-80 overflow-y-auto rounded-2xl border border-line bg-surface-2 p-4 text-base leading-relaxed break-words whitespace-pre-wrap text-text">
                {project.input.text}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-10 gap-y-5">
              <div>
                <dt className="mb-1.5 font-mono text-xs uppercase tracking-wider text-muted">Language</dt>
                <dd className="text-text">{LANGUAGE_LABELS[project.language]}</dd>
              </div>
              <div>
                <dt className="mb-1.5 font-mono text-xs uppercase tracking-wider text-muted">Voice</dt>
                <dd className="text-text">{VOICE_LABELS[project.voiceGender]}</dd>
              </div>
            </div>
          </dl>
        )}

        {project.state === "draft" && (
          <p className="mb-8 rounded-2xl border border-line bg-progress-bg px-4 py-3 text-sm text-text">
            This idea was saved before storyboards could be made. To get a storyboard, create a new project with it.
          </p>
        )}
        {version && <p className="mb-8 text-sm text-muted">Editing and approving the storyboard come next.</p>}
        {!jobState && (
          <Button href={project.state === "draft" ? "/projects/new" : "/dashboard"} variant="secondary">
            {project.state === "draft" ? "Start a new project" : "Back to My videos"}
          </Button>
        )}
      </section>
    </div>
  );
}
