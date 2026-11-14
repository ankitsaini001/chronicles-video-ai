import type { ReactNode } from "react";
import { patternLabel, sceneNumber, visualParts, type NoteItem, type SceneLike } from "@/lib/storyboard/view";
import { Note } from "./Note";

// One scene on the storyboard (Stitch "Step 2 Storyboard"): "SCENE 01", the motion pattern badge,
// a "Changed" tag after a change, the narration, the plain "Visual:" line (built from the plan's
// objects, lib/storyboard/view.ts) and the scene's notes. `action` is the card's top-right button
// (Edit, F17); `editor` replaces the narration while it is being edited.

type SceneCardProps = {
  index: number;
  scene: SceneLike;
  /** The `lang` of the plan's text (Hindi narration must be marked lang="hi"). */
  lang: string;
  changed: boolean;
  notes: { warnings: NoteItem[]; problems: NoteItem[] } | undefined;
  action?: ReactNode;
  editor?: ReactNode;
};

export function SceneCard({ index, scene, lang, changed, notes, action, editor }: SceneCardProps) {
  const titleId = `scene-${scene.id}-title`;
  const visual = visualParts(scene);
  return (
    <article
      aria-labelledby={titleId}
      className="rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-amber/30 sm:p-5"
    >
      <div className="mb-3 flex items-center justify-between gap-3 border-b border-amber/10 pb-3">
        <h2 id={titleId} className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-2.5">
          <span className="font-mono text-xs font-semibold tracking-wider text-amber uppercase">{sceneNumber(index)}</span>
          <span className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-gold-cream">{patternLabel(scene.type)}</span>
          {changed && <span className="rounded-full border border-amber/30 bg-progress-bg px-2 py-0.5 text-[10px] font-medium text-amber">Changed</span>}
        </h2>
        {action}
      </div>
      {editor ?? (
        <div lang={lang} className="mb-3 flex flex-col gap-2">
          {scene.narration.map((block) => (
            <p key={block.id} className="text-base leading-relaxed break-words text-text">
              {block.text}
            </p>
          ))}
        </div>
      )}
      <p className="text-xs leading-relaxed break-words text-muted">
        <span className="mr-1.5 font-mono text-[10px] tracking-wider text-amber-light uppercase">Visual:</span>
        {visual.pattern}
        {visual.detail && (
          <>
            {": "}
            <span lang={lang}>{visual.detail}</span>
          </>
        )}
      </p>
      {notes && (notes.problems.length > 0 || notes.warnings.length > 0) && (
        <div className="mt-3 flex flex-col gap-2">
          {[...notes.problems.map((n) => ["problem", n] as const), ...notes.warnings.map((n) => ["warning", n] as const)].map(([tone, n]) => (
            <Note key={`${tone}:${n.text}`} tone={tone}>
              {/* Only the plan's own text is in the plan's language; our notes are English. */}
              <span lang={n.fromPlan ? lang : undefined}>{n.text}</span>
            </Note>
          ))}
        </div>
      )}
    </article>
  );
}
