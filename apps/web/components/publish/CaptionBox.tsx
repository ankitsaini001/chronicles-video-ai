"use client";

import { POST_CAPTION_LIMITS, POST_CAPTION_MESSAGES, postCaptionLength } from "@bytereel/db/post-caption";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiSend } from "@/components/storyboard/client";
import { Note } from "@/components/storyboard/Note";
import { Button, cn } from "@/components/ui";

// ④ Publish, the CAPTION box (F29; Stitch "Step 4 Publish", CAPTION block). Shown only when Instagram
// is connected (decision 5). One text box with the caption and its hashtags at the end, a counter
// "128 / 2,200" (red over Instagram's limit) and ✨ Suggest again (H1).
// - No caption saved yet: the AI suggests one automatically, ONCE (decision 1). `autoAsked` (this tab)
//   stops React's strict mode and remounts from asking twice; on the server H1's `onlyIfEmpty` and its
//   60 s lease stop a reload or a second tab from spending another request. While another request is
//   still writing (409 suggestion_in_progress) the box waits, checks ONCE more after ~10 s, then offers
//   Suggest again.
// - Typing saves by itself (H7): ~1.5 s after the last key, when the box loses focus and when the page
//   is left; a quiet "Saved" note. Every save carries a growing `clientSeq`, so a late, older save never
//   overwrites a newer one; text counts as saved only after the server said so. Coming back to the page
//   from the browser's back/forward cache saves anything still unsaved. Over 2,200 characters nothing
//   is saved until it is shortened.
// - Suggest again replaces the text; after the creator's own edits it asks first (Escape = keep mine).
// - Busy, refused and limit answers show the server's plain line; typing your own caption always works.

const SAVE_DELAY_MS = 1500;
/** H1 has 30 s for the AI; this leaves room for the request itself. */
const SUGGEST_TIMEOUT_MS = 45_000;
/** After 409 suggestion_in_progress: check once more after this long. */
const RECHECK_MS = 10_000;
const MAX = POST_CAPTION_LIMITS.textMax;

/** Projects whose automatic first suggestion was already asked for in this browser tab. */
const autoAsked = new Set<string>();

/** H7 `clientSeq`: milliseconds, and always higher than the last one this tab sent. */
let lastSeq = 0;
function nextSeq(): number {
  lastSeq = Math.max(Date.now(), lastSeq + 1);
  return lastSeq;
}

export type CaptionDraftView = { text: string; source: "ai" | "edited" };
type SaveState = "idle" | "saving" | "saved" | "failed";

export function CaptionBox({ projectId, renderId, initialDraft }: { projectId: string; renderId: string; initialDraft: CaptionDraftView | null }) {
  const draftUrl = `/api/v1/projects/${projectId}/caption-draft`;
  const [text, setText] = useState(initialDraft?.text ?? "");
  const [edited, setEdited] = useState(initialDraft?.source === "edited");
  const [suggesting, setSuggesting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [confirming, setConfirming] = useState(false);
  /** The text on screen and the text the server has, readable from timers and the page-leave handler. */
  const latest = useRef(initialDraft?.text ?? "");
  // No saved caption = an empty box: nothing to save until the creator types (or the AI writes).
  const saved = useRef<string>(initialDraft?.text ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Saves run one after another, so an older text never lands after a newer one. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const suggestButton = useRef<HTMLButtonElement>(null);
  const confirmRow = useRef<HTMLDivElement>(null);

  const length = postCaptionLength(text);
  const tooLong = length > MAX;

  const flush = useCallback((): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const run = async () => {
      const value = latest.current;
      if (value === saved.current || postCaptionLength(value) > MAX) return;
      setSaveState("saving");
      const answer = await apiSend("PUT", draftUrl, { text: value, clientSeq: nextSeq() });
      if (answer.ok) {
        saved.current = value;
        setSaveState("saved");
      } else if (answer.status === 0) {
        // No answer at all: the connection. The next change or leaving the box tries again.
        setSaveState("failed");
      } else {
        // The server's own plain line (e.g. "You're going a bit fast…", the video changed).
        setSaveState("idle");
        setProblem(answer.message);
      }
    };
    queue.current = queue.current.then(run, run);
    return queue.current;
  }, [draftUrl]);

  /** Shows a saved draft (from H1, or one another tab saved). */
  const show = useCallback((draft: CaptionDraftView) => {
    latest.current = draft.text;
    saved.current = draft.text;
    setText(draft.text);
    setEdited(draft.source === "edited");
    setSaveState("idle");
  }, []);

  const suggest = useCallback(
    async (onlyIfEmpty: boolean, isRecheck = false) => {
      setConfirming(false);
      setProblem(null);
      setSuggesting(true);
      await flush();
      const answer = await apiSend<{ draft: CaptionDraftView }>(
        "POST",
        `/api/v1/projects/${projectId}/caption-suggestions`,
        onlyIfEmpty ? { renderId, onlyIfEmpty: true } : { renderId },
        {},
        SUGGEST_TIMEOUT_MS,
      );
      if (answer.ok) {
        setSuggesting(false);
        return show(answer.json.draft);
      }
      const reason = answer.code === "INVALID_STATE" ? answer.details?.reason : undefined;
      const existing = reason === "draft_exists" ? (answer.details?.draft as CaptionDraftView | undefined) : undefined;
      if (existing) {
        setSuggesting(false);
        return show(existing);
      }
      if (reason === "suggestion_in_progress" && !isRecheck) {
        // Another request (a reload, another tab) is writing it: keep "Writing…" and look once more.
        recheck.current = setTimeout(() => void suggest(true, true), RECHECK_MS);
        return;
      }
      setSuggesting(false);
      setProblem(answer.message);
    },
    [flush, projectId, renderId, show],
  );

  // The automatic first suggestion (decision 1): only when nothing is saved, once per project in this tab.
  useEffect(() => {
    if (initialDraft || autoAsked.has(projectId)) return;
    autoAsked.add(projectId);
    void suggest(true);
    // Runs once on mount by design (the guard above also makes a second run do nothing).
  }, []);

  // Leaving the page (closing the tab, or a link to another screen) saves what was typed; coming back
  // from the browser's back/forward cache saves whatever didn't make it.
  useEffect(() => {
    const saveOnLeave = () => {
      const value = latest.current;
      if (value === saved.current || postCaptionLength(value) > MAX) return;
      void fetch(draftUrl, {
        method: "PUT",
        keepalive: true,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value, clientSeq: nextSeq() }),
      })
        .then((response) => {
          if (response.ok && latest.current === value) saved.current = value;
        })
        .catch(() => undefined);
    };
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) void flush();
    };
    window.addEventListener("pagehide", saveOnLeave);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", saveOnLeave);
      window.removeEventListener("pageshow", onShow);
      if (timer.current) clearTimeout(timer.current);
      if (recheck.current) clearTimeout(recheck.current);
      saveOnLeave();
    };
  }, [draftUrl, flush]);

  // The confirm row takes the focus (its first button) when it opens.
  useEffect(() => {
    if (confirming) confirmRow.current?.querySelector("button")?.focus();
  }, [confirming]);

  function change(value: string) {
    latest.current = value;
    setText(value);
    setEdited(true);
    setConfirming(false);
    setSaveState("idle");
    if (problem) setProblem(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  function pressSuggest() {
    if (suggesting) return;
    // After the creator's own edits, a new suggestion would replace them: ask first.
    if (edited && text.trim() !== "") return setConfirming(true);
    void suggest(false);
  }

  function keepMine() {
    setConfirming(false);
    suggestButton.current?.focus();
  }

  const status = suggesting
    ? POST_CAPTION_MESSAGES.SUGGESTING
    : tooLong
      ? POST_CAPTION_MESSAGES.TOO_LONG
      : saveState === "saving"
        ? POST_CAPTION_MESSAGES.SAVING
        : saveState === "saved"
          ? POST_CAPTION_MESSAGES.SAVED
          : saveState === "failed"
            ? POST_CAPTION_MESSAGES.NOT_SAVED
            : "";

  return (
    <section aria-labelledby="caption-heading" data-testid="caption-box" className="flex w-full flex-col gap-3.5 rounded-2xl border border-line bg-surface p-5 text-left shadow-card sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <label id="caption-heading" htmlFor="caption-text" className="font-mono text-xs font-semibold tracking-widest text-amber uppercase">
          Caption
        </label>
        <button
          ref={suggestButton}
          type="button"
          onClick={pressSuggest}
          disabled={suggesting}
          data-testid="caption-suggest"
          className="flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3.5 py-1.5 text-xs text-text transition-colors hover:border-amber/40 hover:text-gold-cream disabled:pointer-events-none disabled:opacity-50"
        >
          <span aria-hidden="true" className="text-amber">
            ✨
          </span>
          {suggesting ? "Writing…" : text.trim() === "" ? "Suggest a caption" : "Suggest again"}
        </button>
      </div>

      {confirming && (
        <div
          ref={confirmRow}
          role="alertdialog"
          aria-labelledby="caption-confirm"
          data-testid="caption-confirm"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              keepMine();
            }
          }}
          className="flex flex-col gap-3 rounded-xl border border-warning/25 bg-warning-bg px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p id="caption-confirm" className="text-xs leading-relaxed text-warning">
            {POST_CAPTION_MESSAGES.CONFIRM_REPLACE} Your own changes will be lost.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => void suggest(false)} data-testid="caption-confirm-replace">
              Replace
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={keepMine} data-testid="caption-confirm-keep">
              Keep mine
            </Button>
          </div>
        </div>
      )}

      <div className={cn("rounded-xl border bg-surface-2 p-4 transition-colors focus-within:border-gold-cream/70", tooLong ? "border-danger/60" : "border-line")}>
        <textarea
          id="caption-text"
          data-testid="caption-text"
          value={text}
          onChange={(event) => change(event.target.value)}
          onBlur={() => void flush()}
          readOnly={suggesting}
          aria-busy={suggesting}
          aria-describedby="caption-count caption-status"
          aria-invalid={tooLong}
          rows={7}
          placeholder={suggesting ? "" : "Write what your post should say, with your hashtags at the end."}
          className={cn("block w-full resize-y border-0 bg-transparent p-0 text-sm leading-relaxed text-text placeholder:text-muted focus:outline-none", suggesting && "opacity-60")}
        />
      </div>

      <div className="flex items-start justify-between gap-3">
        <p id="caption-status" role="status" aria-live="polite" data-testid="caption-status" className={cn("min-h-4 text-xs leading-snug", tooLong ? "text-danger" : "text-muted")}>
          {status}
        </p>
        <span id="caption-count" data-testid="caption-count" className={cn("shrink-0 font-mono text-xs", tooLong ? "font-semibold text-danger" : "text-muted")}>
          {length.toLocaleString("en-IN")} / {MAX.toLocaleString("en-IN")}
        </span>
      </div>

      {problem && (
        <div role="alert" data-testid="caption-problem">
          <Note tone="problem" label="Caption: ">
            {problem}
          </Note>
        </div>
      )}
    </section>
  );
}
