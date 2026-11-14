"use client";

import { VOICE_TEXT_LANG, voicePresetFor, type VoiceLanguage } from "@bytereel/db/voices";
import type { PlanVersionResource, ProjectResource } from "@bytereel/db";
import { useState } from "react";
import { sceneNotes, type SceneLike } from "@/lib/storyboard/view";
import { Note } from "./Note";
import { SceneCard } from "./SceneCard";

// ② Review storyboard (F16; Stitch "Step 2 Storyboard"): the title strip (title, language, voice,
// about N seconds, scene count, version), the scene cards, the notes for the whole storyboard and
// the bottom bar. The data is the C3 project and the D2 current version, read by the server page.
// The inner part is keyed by version and stateVersion: after any change the server page re-reads
// the data and the screen starts fresh (editors and menus close), while `notice` (the aria-live
// status line) lives outside it, so "Saved as version 4" is still announced after the reload.

export type StoryboardScreenProps = {
  project: ProjectResource;
  version: PlanVersionResource;
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

function Body({ project, version }: StoryboardScreenProps & { announce: (text: string) => void }) {
  const language = project.language as VoiceLanguage;
  const lang = VOICE_TEXT_LANG[language];
  const textLang = language === "en" ? undefined : lang;
  const plan = version.plan as unknown as { scenes: SceneLike[]; warnings?: { sceneId: string | null; message: string }[] };
  const notes = sceneNotes(plan, version.validation);
  const seconds = Math.round(version.stats.estimatedSeconds);
  const languageName = LANGUAGE_NAMES[language];
  const voice = voicePresetFor(language, project.voiceGender);
  const changed = new Set(version.changedSceneIds);

  return (
    <div className="flex flex-col">
      <header className="flex flex-col gap-4 border-b border-line pb-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <h1 lang={textLang} className="font-display text-2xl font-bold tracking-tight break-words text-text lg:text-[26px]">
            {project.title}
          </h1>
          <ul aria-label="About this storyboard" className="flex flex-wrap items-center gap-2">
            <li className={chip}>
              <span lang={languageName.lang}>{languageName.text}</span>
              {languageName.english && <span className="text-muted">{languageName.english}</span>}
            </li>
            <li className={chip}>
              <span lang={language === "hi" ? "hi" : undefined}>{voice.label}</span>
            </li>
            <li className={`${chip} font-mono`}>
              <span aria-hidden="true">≈ {seconds}s</span>
              <span className="sr-only">about {seconds} seconds</span>
            </li>
            <li className={`${chip} font-mono`}>
              {version.stats.sceneCount} scenes
            </li>
            <li className={`${chip} font-mono`}>Version {version.versionNumber}</li>
          </ul>
        </div>
      </header>

      <div className="flex flex-col gap-4 pt-6">
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
              <SceneCard index={index} scene={scene} lang={lang} changed={changed.has(scene.id)} notes={notes.byScene.get(scene.id)} />
            </li>
          ))}
        </ol>
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
