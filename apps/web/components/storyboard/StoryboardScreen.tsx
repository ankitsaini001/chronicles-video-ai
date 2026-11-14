"use client";

import { VOICE_TEXT_LANG, type VoiceLanguage, type VoicePresetId } from "@bytereel/db/voices";
import type { PlanVersionResource, ProjectResource, RevisionResource } from "@bytereel/db";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { sceneNotes, sceneNumber, type SceneLike } from "@/lib/storyboard/view";
import { ChangesPanel } from "./ChangesPanel";
import { apiSend, CLIENT_MESSAGES } from "./client";
import { NarrationEditor } from "./NarrationEditor";
import { Note } from "./Note";
import { SceneCard } from "./SceneCard";
import { VersionMenu } from "./VersionMenu";
import { VoiceMenu } from "./VoiceMenu";

// ② Review storyboard (F16–F20; Stitch "Step 2 Storyboard"): the title strip (title, language,
// voice, about N seconds, scene count), "Version N ▾" and Undo (F17), the scene cards with inline
// narration editing (F17), the notes for the whole storyboard and the bottom bar.
// The data is the C3 project and the D2 current version, read by the server page. After any change
// the page re-reads it (router.refresh). The inner part is keyed by version and stateVersion, so
// the screen then starts fresh (editors and menus close), while the status line (`notice`,
// aria-live) lives outside it, so "Saved as version 4" is still announced after the reload.
// Every change sends the stateVersion this page was loaded with: another tab's change → "refresh".

export type StoryboardScreenProps = {
  project: ProjectResource;
  version: PlanVersionResource;
  /** Change requests on the storyboard, oldest first (D6). */
  revisions: RevisionResource[];
  /** The newest change request's job, when it failed (for its message and Try again). */
  failedChange: { id: string; message: string } | null;
  /** The project used all its 20 AI requests. */
  requestsUsedUp: boolean;
  /** Voices with a recorded ▶ sample (F13). */
  samplePresets: VoicePresetId[];
};

const LANGUAGE_NAMES: Record<VoiceLanguage, { text: string; lang?: string; english?: string }> = {
  en: { text: "English" },
  hi: { text: "हिंदी", lang: "hi", english: "Hindi" },
  hinglish: { text: "Hinglish" },
};

const chip = "inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1 text-xs font-medium text-text";

export function StoryboardScreen(props: StoryboardScreenProps) {
  const [notice, setNotice] = useState("");
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {notice}
      </p>
      <Body key={`${props.version.id}:${props.project.stateVersion}`} {...props} announce={setNotice} />
    </>
  );
}

type Problem = { message: string; stale: boolean };

function Body({ project, version, revisions, failedChange, requestsUsedUp, samplePresets, announce }: StoryboardScreenProps & { announce: (text: string) => void }) {
  const router = useRouter();
  const language = project.language as VoiceLanguage;
  const lang = VOICE_TEXT_LANG[language];
  const textLang = language === "en" ? undefined : lang;
  const plan = version.plan as unknown as { scenes: SceneLike[]; warnings?: { sceneId: string | null; message: string }[] };
  const notes = sceneNotes(plan, version.validation);
  const seconds = Math.round(version.stats.estimatedSeconds);
  const languageName = LANGUAGE_NAMES[language];
  const changed = new Set(version.changedSceneIds);
  const canEdit = project.allowedActions.includes("edit_storyboard");

  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  function fail(answer: { code: string; message: string }) {
    setBusy(false);
    setProblem({ message: answer.code === "STALE_VERSION" ? CLIENT_MESSAGES.STALE : answer.message, stale: answer.code === "STALE_VERSION" });
  }

  /** D3, one call per changed block (each makes a version), then the page reloads. */
  async function saveNarration(sceneId: string, blocks: { id: string; text: string }[]) {
    setBusy(true);
    setProblem(null);
    let base = version.id;
    let stateVersion = project.stateVersion;
    let saved: number | null = null;
    for (const block of blocks) {
      const original = plan.scenes.find((s) => s.id === sceneId)?.narration.find((n) => n.id === block.id);
      // A new text replaces the old pronunciation/caption forms, so the new words are spoken and shown.
      const clear = { ...(original?.speech ? { speech: null } : {}), ...(original?.display ? { display: null } : {}) };
      const answer = await apiSend<{ id: string; versionNumber: number }>("POST", `/api/v1/projects/${project.id}/narration-edits`, {
        basePlanVersionId: base,
        sceneId,
        narrationId: block.id,
        text: block.text,
        ...clear,
        expectedStateVersion: stateVersion,
      });
      if (!answer.ok) {
        if (saved !== null) router.refresh(); // part of it was saved: show it
        return fail(answer);
      }
      base = answer.json.id;
      stateVersion += 1;
      saved = answer.json.versionNumber;
    }
    announce(`Saved as version ${saved}.`);
    router.refresh();
  }

  /** D7: Undo (the parent version) or restore an older one. */
  async function restore(target: { id: string; versionNumber: number | null }) {
    setBusy(true);
    setProblem(null);
    const answer = await apiSend("POST", `/api/v1/projects/${project.id}/plan-versions/${target.id}/restore`, { expectedStateVersion: project.stateVersion });
    if (!answer.ok) return fail(answer);
    announce(target.versionNumber ? `Restored version ${target.versionNumber}.` : "Undone: the previous version is back.");
    router.refresh();
  }

  /** D4: switch the voice (a new version). */
  async function switchVoice(gender: "female" | "male") {
    setBusy(true);
    setProblem(null);
    const answer = await apiSend<{ versionNumber: number }>("POST", `/api/v1/projects/${project.id}/voice`, {
      basePlanVersionId: version.id,
      voiceGender: gender,
      expectedStateVersion: project.stateVersion,
    });
    if (!answer.ok) return fail(answer);
    announce(`Voice changed. Saved as version ${answer.json.versionNumber}.`);
    router.refresh();
  }

  const locked = busy || !canEdit;

  return (
    <div className="flex flex-col">
      <header className="flex flex-col gap-4 border-b border-line pb-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <h1 lang={textLang} className="font-display text-2xl font-bold tracking-tight break-words text-text lg:text-[26px]">
            {project.title}
          </h1>
          <ul aria-label="About this storyboard" className="flex flex-wrap items-center gap-2">
            <li className={chip}>
              <span lang={languageName.lang}>{languageName.text}</span>
              {languageName.english && <span className="text-muted">{languageName.english}</span>}
            </li>
            <li>
              <VoiceMenu language={language} current={project.voiceGender} samplePresets={samplePresets} disabled={locked || editing !== null} onChoose={(g) => void switchVoice(g)} />
            </li>
            <li className={`${chip} font-mono`}>
              <span aria-hidden="true">≈ {seconds}s</span>
              <span className="sr-only">about {seconds} seconds</span>
            </li>
            <li className={`${chip} font-mono`}>{version.stats.sceneCount} scenes</li>
          </ul>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <VersionMenu projectId={project.id} versionNumber={version.versionNumber} disabled={locked} onRestore={(v) => void restore(v)} />
          <button
            type="button"
            disabled={locked || !version.parentVersionId}
            onClick={() => version.parentVersionId && void restore({ id: version.parentVersionId, versionNumber: null })}
            className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-xs font-medium text-text transition hover:border-amber/40 hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-50"
          >
            <span aria-hidden="true">↶</span> Undo
          </button>
        </div>
      </header>

      {problem && (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-text">
          <span className="min-w-0 flex-1">{problem.message}</span>
          {problem.stale && (
            <button type="button" onClick={() => router.refresh()} className="cursor-pointer rounded-full border border-line px-3 py-1 text-xs font-medium hover:border-amber/40">
              Refresh
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-8 pt-6 lg:grid-cols-12">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-8">
        {(notes.general.problems.length > 0 || notes.general.warnings.length > 0) && (
          <div className="flex flex-col gap-2">
            {notes.general.problems.map((text) => (
              <Note key={`p:${text}`} tone="problem">
                <span lang={textLang}>{text}</span>
              </Note>
            ))}
            {notes.general.warnings.map((text) => (
              <Note key={`w:${text}`} tone="warning">
                <span lang={textLang}>{text}</span>
              </Note>
            ))}
          </div>
        )}
        <ol aria-label="Scenes" className="flex flex-col gap-4">
          {plan.scenes.map((scene, index) => (
            <li key={scene.id}>
              <SceneCard
                index={index}
                scene={scene}
                lang={lang}
                changed={changed.has(scene.id)}
                notes={notes.byScene.get(scene.id)}
                action={
                  canEdit && editing !== scene.id ? (
                    <button
                      type="button"
                      disabled={busy || editing !== null}
                      onClick={() => setEditing(scene.id)}
                      className="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 text-xs text-muted transition hover:text-amber disabled:pointer-events-none disabled:opacity-50"
                    >
                      <PencilIcon />
                      Edit<span className="sr-only"> narration of {sceneNumber(index).toLowerCase()}</span>
                    </button>
                  ) : undefined
                }
                editor={
                  editing === scene.id ? (
                    <NarrationEditor
                      sceneLabel={sceneNumber(index).toLowerCase()}
                      blocks={scene.narration}
                      lang={lang}
                      busy={busy}
                      onSave={(blocks) => saveNarration(scene.id, blocks)}
                      onCancel={() => setEditing(null)}
                    />
                  ) : undefined
                }
              />
            </li>
          ))}
        </ol>
      </div>
      <aside className="min-w-0 lg:col-span-4">
        <div className="lg:sticky lg:top-6">
          <ChangesPanel
            projectId={project.id}
            baseVersionId={version.id}
            stateVersion={project.stateVersion}
            scenes={plan.scenes}
            revisions={revisions}
            activeJob={project.activeJob}
            failedJob={failedChange}
            canRequest={project.allowedActions.includes("request_revision")}
            canRetry={project.allowedActions.includes("retry_job")}
            requestsUsedUp={requestsUsedUp}
            disabled={busy || editing !== null}
            announce={announce}
          />
        </div>
      </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface px-4 py-3.5 sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <p className="font-mono text-xs tracking-wide text-muted">
            ≈ {seconds}s · {version.stats.sceneCount} scenes · Version {version.versionNumber}
          </p>
        </div>
      </div>
    </div>
  );
}

function PencilIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="size-3.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
    </svg>
  );
}
