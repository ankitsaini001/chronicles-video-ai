"use client";

import { cleanIdeaText } from "@bytereel/db/idea-text";
import { useEffect, useId, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";

// Inline narration editor for one scene card (F17; ARCHITECTURE §11: "storyboard narration editing
// is inline"). One text box per narration block (most scenes have one or two). Save sends only the
// blocks that changed; each saved block becomes a new storyboard version (D3), so Undo can always go
// back. Escape cancels. Text is counted after the same cleaning the server does (line breaks and
// runs of spaces become one space), so the counter and the server agree.

export const NARRATION_MAX = 300;

/** Same cleaning as the server (packages/db/src/storyboard-edits.ts cleanNarrationText). */
export function cleanNarration(raw: string): string {
  return cleanIdeaText(raw).replace(/\s+/g, " ");
}

type NarrationEditorProps = {
  sceneLabel: string;
  blocks: { id: string; text: string }[];
  lang: string;
  busy: boolean;
  /** Saves the changed blocks; resolves when done (the screen reloads on success). */
  onSave: (changed: { id: string; text: string }[]) => Promise<void>;
  onCancel: () => void;
};

export function NarrationEditor({ sceneLabel, blocks, lang, busy, onSave, onCancel }: NarrationEditorProps) {
  const baseId = useId();
  const [texts, setTexts] = useState(() => blocks.map((b) => b.text));
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus(), []);

  const cleaned = texts.map(cleanNarration);
  const changed = blocks.map((b, i) => ({ id: b.id, text: cleaned[i]! })).filter((b, i) => b.text !== blocks[i]!.text);
  const problem = cleaned.some((t) => t.length === 0) ? "Narration can't be empty." : cleaned.some((t) => t.length > NARRATION_MAX) ? `Each part can be at most ${NARRATION_MAX} characters.` : null;

  return (
    <form
      className="mb-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && !problem && changed.length) void onSave(changed);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {blocks.map((block, i) => {
        const id = `${baseId}-${block.id}`;
        const count = cleaned[i]!.length;
        return (
          <div key={block.id} className="flex flex-col gap-1.5">
            <label htmlFor={id} className="font-mono text-[11px] tracking-wider text-muted uppercase">
              {blocks.length > 1 ? `Narration, part ${i + 1} of ${blocks.length}` : "Narration"}
              <span className="sr-only">, {sceneLabel}</span>
            </label>
            <div className={cn("relative rounded-2xl border bg-surface-2 p-3 pb-7 transition-colors focus-within:border-gold-cream", count > NARRATION_MAX || count === 0 ? "border-danger" : "border-line")}>
              <textarea
                ref={i === 0 ? first : undefined}
                id={id}
                lang={lang}
                rows={3}
                value={texts[i]}
                maxLength={NARRATION_MAX * 2}
                disabled={busy}
                onChange={(e) => setTexts((all) => all.map((t, j) => (j === i ? e.target.value : t)))}
                aria-describedby={`${id}-count`}
                className="block w-full resize-y bg-transparent text-base leading-relaxed text-text outline-none"
              />
              <span id={`${id}-count`} className={cn("absolute right-3 bottom-2 font-mono text-[11px]", count > NARRATION_MAX ? "text-danger" : "text-muted")}>
                {count} / {NARRATION_MAX}
              </span>
            </div>
          </div>
        );
      })}
      {problem && <p className="text-sm text-danger">{problem}</p>}
      <p className="text-xs text-muted">Saving makes a new version. You can undo it.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={busy || !!problem || changed.length === 0}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
