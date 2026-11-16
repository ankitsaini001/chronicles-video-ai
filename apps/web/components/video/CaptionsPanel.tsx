"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CAPTION_MESSAGES } from "@bytereel/db/caption-messages";
import { captionTextProblem } from "@bytereel/pipeline/timing/caption-fit";
import { apiSend, newIdempotencyKey } from "@/components/storyboard/client";
import { Button, cn } from "@/components/ui";
import type { CaptionPhrase, RenderDetailResource } from "@/lib/video/captions";

// The Captions tab on ③ Video (F25; Stitch "Step 3 Review video": time + phrase rows, an "Edited"
// tag, "Save caption fixes"). It lists the caption phrases of the project's video (API F2) and lets
// the creator fix their TEXT; the narration audio stays the same (PRD §6.3). To change the spoken
// words, the storyboard is edited instead (a new video).
// - Clicking a row's time plays the video from there (the latest version).
// - A changed row is marked "Edited" with its own Undo, until saved.
// - Save caption fixes (F4) sends only the changed rows, with an Idempotency-Key per save attempt
//   (the same key again only when the same fixes are sent again after a network or server problem).
//   Before sending, each changed row is checked here with the SAME rule as the server (caption-fit.ts:
//   no emoji, fits on screen), so most mistakes never use up one of the 10 saves an hour. The server
//   stays the authority: it checks again (the phrase exists, the timing) and its messages are shown
//   on the row. Then the page shows the progress (Updating captions → Rendering).
// - After a failed caption fix: a note, with Try again (E2) only when trying again can help; a fix
//   that can't be applied asks to fix the captions again here. A cancelled fix shows no note.

export type LastCaptionJob = { id: string; message: string; canRetry: boolean };

export type CaptionsPanelProps = {
  projectId: string;
  /** The project's video (the captions are fixed on it). */
  renderId: string;
  renderNumber: number;
  /** The project's stateVersion the page was loaded with (another tab's change → "refresh"). */
  stateVersion: number;
  canEdit: boolean;
  canEditStoryboard: boolean;
  /** The player is showing another (older) version. */
  showingOtherVersion: boolean;
  lastJob: LastCaptionJob | null;
  onSeek: (seconds: number) => void;
};

const keyOf = (p: Pick<CaptionPhrase, "sceneId" | "phraseIndex">) => `${p.sceneId}#${p.phraseIndex}`;
/** A copy of `record` without `key`. */
const without = (record: Record<string, string>, key: string) => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
/** The same cleaning the server does for comparing (single spaces, trimmed). */
const clean = (text: string) => text.replace(/\s+/g, " ").trim();

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function CaptionsPanel(props: CaptionsPanelProps) {
  const router = useRouter();
  const [phrases, setPhrases] = useState<CaptionPhrase[] | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "retry" | null>(null);
  const saveKey = useRef<{ body: string; key: string } | null>(null);
  const retryKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoadProblem(null);
    const answer = await apiSend<RenderDetailResource>("GET", `/api/v1/projects/${props.projectId}/renders/${props.renderId}`);
    if (!answer.ok) return setLoadProblem(answer.message);
    setPhrases(answer.json.captions);
  }, [props.projectId, props.renderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = (phrases ?? []).filter((p) => drafts[keyOf(p)] !== undefined && clean(drafts[keyOf(p)]!) !== p.text);

  function edit(phrase: CaptionPhrase, value: string) {
    const key = keyOf(phrase);
    setDrafts((d) => ({ ...d, [key]: value }));
    setRowErrors((e) => without(e, key));
  }

  function undo(phrase: CaptionPhrase) {
    const key = keyOf(phrase);
    setDrafts((d) => without(d, key));
    setRowErrors((e) => without(e, key));
  }

  async function save() {
    if (busy || changed.length === 0) return;
    setProblem(null);
    // The same rule as the server, before sending (a refusal would still count toward the hourly limit).
    const local: Record<string, string> = {};
    for (const phrase of changed) {
      const text = clean(drafts[keyOf(phrase)]!);
      const found = text === "" ? "empty" : captionTextProblem(text);
      if (found) local[keyOf(phrase)] = found === "empty" ? CAPTION_MESSAGES.EMPTY : found === "emoji" ? CAPTION_MESSAGES.EMOJI : CAPTION_MESSAGES.TOO_LONG;
    }
    setRowErrors(local);
    if (Object.keys(local).length > 0) return;
    setBusy("save");
    const edits = changed.map((p) => ({ sceneId: p.sceneId, phraseIndex: p.phraseIndex, text: clean(drafts[keyOf(p)]!) }));
    const body = JSON.stringify(edits);
    if (saveKey.current?.body !== body) saveKey.current = { body, key: newIdempotencyKey() };
    const answer = await apiSend("POST", `/api/v1/projects/${props.projectId}/renders/${props.renderId}/caption-overrides`, { edits, expectedStateVersion: props.stateVersion }, { "Idempotency-Key": saveKey.current.key });
    if (answer.ok) return router.refresh(); // the page now shows the progress (Updating captions → Rendering)
    // A refusal is final for these fixes: the next click is a new attempt (a new key).
    if (answer.status > 0 && answer.status < 500 && answer.code !== "IDEMPOTENCY_IN_PROGRESS") saveKey.current = null;
    setBusy(null);
    const issues = (answer.details?.issues ?? []) as { path?: string; message?: string }[];
    const onRows: Record<string, string> = {};
    for (const issue of issues) {
      const index = /^edits\[(\d+)\]/.exec(issue.path ?? "")?.[1];
      const phrase = index !== undefined ? changed[Number(index)] : undefined;
      if (phrase && issue.message && !onRows[keyOf(phrase)]) onRows[keyOf(phrase)] = issue.message;
    }
    setRowErrors(onRows);
    if (Object.keys(onRows).length === 0) setProblem(answer.message);
  }

  async function retry() {
    if (!props.lastJob || busy) return;
    setBusy("retry");
    setProblem(null);
    retryKey.current ??= newIdempotencyKey();
    const answer = await apiSend("POST", `/api/v1/jobs/${props.lastJob.id}/retry`, {}, { "Idempotency-Key": retryKey.current });
    if (answer.ok) return router.refresh();
    if (answer.status < 500 && answer.code !== "IDEMPOTENCY_IN_PROGRESS") retryKey.current = null;
    setBusy(null);
    setProblem(answer.message);
  }

  return (
    <section aria-labelledby="captions-heading" className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="flex gap-6 border-b border-line bg-surface-2 px-6 pt-4">
        <h2 id="captions-heading" className="border-b-2 border-amber pb-3 text-sm font-medium text-text">
          Captions
        </h2>
      </div>
      <div className="flex flex-col gap-5 p-6">
        <p className="text-sm text-muted">
          Fix a word in the captions. The narration audio stays the same.
          {props.canEditStoryboard && (
            <>
              {" "}
              <Link href={`/projects/${props.projectId}/storyboard`} className="font-medium text-amber-light underline-offset-4 hover:underline">
                Change the spoken words instead → Edit storyboard
              </Link>
            </>
          )}
        </p>

        {props.lastJob && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-text">
            <span className="min-w-0 flex-1 break-words">{`We couldn't update your captions. ${props.lastJob.message}`}</span>
            {props.lastJob.canRetry && (
              <button type="button" onClick={() => void retry()} disabled={busy !== null} className="min-h-11 cursor-pointer px-1 text-sm font-medium text-amber-light hover:underline disabled:opacity-50">
                {busy === "retry" ? "Starting…" : "Try again"}
              </button>
            )}
          </div>
        )}

        {props.showingOtherVersion && <p className="text-xs text-muted">These are the captions of your latest video (version {props.renderNumber}).</p>}

        {phrases === null ? (
          loadProblem ? (
            <p role="alert" className="text-sm text-danger">
              {loadProblem}{" "}
              <button type="button" onClick={() => void load()} className="cursor-pointer font-medium text-text underline-offset-4 hover:underline">
                Try again
              </button>
            </p>
          ) : (
            <p className="text-sm text-muted">Loading captions…</p>
          )
        ) : phrases.length === 0 ? (
          <p className="text-sm text-muted">This video has no captions.</p>
        ) : (
          <ol aria-label="Caption phrases" className="-mr-2 flex max-h-[28rem] flex-col gap-3 overflow-y-auto pr-2">
            {phrases.map((phrase) => {
              const key = keyOf(phrase);
              const draft = drafts[key];
              const edited = draft !== undefined && clean(draft) !== phrase.text;
              const error = rowErrors[key];
              const time = clock(phrase.startMs);
              return (
                <li key={key} className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => props.onSeek(phrase.startMs / 1000)}
                    aria-label={`Play from ${time}`}
                    className="min-h-11 w-12 shrink-0 cursor-pointer text-right font-mono text-xs text-muted transition-colors hover:text-amber"
                  >
                    {time}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="relative flex items-center">
                      <input
                        type="text"
                        value={draft ?? phrase.text}
                        onChange={(event) => edit(phrase, event.target.value)}
                        disabled={!props.canEdit || busy !== null}
                        maxLength={200}
                        aria-label={`Caption at ${time}`}
                        aria-invalid={error ? true : undefined}
                        className={cn(
                          "min-h-11 w-full rounded-[12px] border bg-surface-2 px-3.5 py-2.5 text-sm text-text transition-colors focus:border-gold-cream focus:outline-none disabled:opacity-70",
                          error ? "border-danger" : edited ? "border-amber pr-20 shadow-[0_0_12px_rgba(245,165,36,0.2)]" : "border-line",
                        )}
                      />
                      {edited && (
                        <span className="pointer-events-none absolute right-3 rounded border border-amber/25 bg-progress-bg px-2 py-0.5 font-mono text-[10px] font-semibold text-amber uppercase">
                          Edited
                        </span>
                      )}
                    </div>
                    {(edited || error) && (
                      <div className="mt-1 flex flex-wrap items-center gap-3">
                        {error && (
                          <p role="alert" className="text-xs text-danger">
                            {error}
                          </p>
                        )}
                        {edited && (
                          <button type="button" onClick={() => undo(phrase)} disabled={busy !== null} className="cursor-pointer text-xs font-medium text-muted hover:text-text disabled:opacity-50">
                            Undo
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {problem && (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        )}

        {props.canEdit && phrases !== null && phrases.length > 0 && (
          <div className="pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={() => void save()} disabled={changed.length === 0 || busy !== null}>
              {busy === "save" ? "Saving…" : "Save caption fixes"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
