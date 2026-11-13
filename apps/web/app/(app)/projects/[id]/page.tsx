import { currentStepOf, getDb, getOwnedProject, readDbConfig } from "@bytereel/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectStepper } from "@/components/app/ProjectStepper";
import { Button } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";

// TEMPORARY project page (F12): where "Create storyboard" lands until the storyboard exists.
// It shows what was saved (idea, language, voice). F15 makes the AI storyboard, F16 builds
// /projects/[id]/storyboard; this address then sends you to the project's current step.
// Only the owner sees it: another user's project, a missing one and a malformed id all get the
// same 404 page, so nobody can tell whether a project exists (ARCHITECTURE §10.3).

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
  const project = await getOwnedProject(getDb(settings.config), user.id, id);
  if (!project) notFound();

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col">
      <div className="relative mb-6 flex flex-col items-center gap-4 sm:mb-8 sm:flex-row sm:justify-center">
        <Link href="/dashboard" className="self-start text-xs font-medium text-muted transition-colors hover:text-text sm:absolute sm:left-0 sm:self-center">
          ← My videos
        </Link>
        <ProjectStepper current={currentStepOf(project.state)} />
      </div>
      <section aria-labelledby="project-title" className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-10">
        <p className="mb-2 font-mono text-xs uppercase tracking-wider text-success">Idea saved</p>
        <h1 id="project-title" className="mb-6 font-display text-2xl font-bold tracking-tight break-words text-text sm:text-[28px]">
          {project.title}
        </h1>
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
        <p className="mb-8 rounded-2xl border border-line bg-progress-bg px-4 py-3 text-sm text-text">The AI storyboard arrives in F15.</p>
        <Button href="/dashboard" variant="secondary">
          Back to My videos
        </Button>
        <p className="mt-6 font-mono text-[11px] uppercase tracking-wider text-muted">Temporary page · the storyboard screen comes in F16</p>
      </section>
    </div>
  );
}
