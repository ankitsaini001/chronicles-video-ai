"use client";

import { cleanIdeaText } from "@bytereel/db/idea-text";
import type { JobResource, RevisionResource } from "@bytereel/db";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { sceneNumber } from "@/lib/storyboard/view";
import { apiSend, CLIENT_MESSAGES, newIdempotencyKey } from "./client";

// "Ask for changes" (F18; Stitch "Step 2 Storyboard", right column): the change history as chat
// bubbles (D6), a scope choice ("Whole storyboard" or one scene) and a box for the request
// (3–500 characters). Sending (D5) starts a background job; while it runs the panel polls C6 every
// 2 s (every 15 s in a hidden tab, stops when it ends or the page is left) and shows the job's
// progress; when it ends the page re-reads the storyboard (new version, "Changed" tags). A failed
// change shows its message and Try again (E2). Each change uses 1 of the project's 20 AI requests.

const MIN = 3;
const MAX = 500;
const POLL_MS = 2000;
const HIDDEN_POLL_MS = 15000;
const MAX_ERROR_BACKOFF_MS = 10000;

type ChangesPanelProps = {
  projectId: string;
  baseVersionId: string;
  stateVersion: number;
  scenes: { id: string }[];
  revisions: RevisionResource[];
  activeJob: JobResource | null;
  /** The newest change request's job, when it failed. */
  failedJob: { id: string; message: string } | null;
  canRequest: boolean;
  canRetry: boolean;
  requestsUsedUp: boolean;
  /** Something else is happening on the screen (a save, an approval): don't start a change now. */
  disabled: boolean;
  announce: (text: string) => void;
};

export function ChangesPanel(props: ChangesPanelProps) {
  const { projectId, scenes, revisions, activeJob, failedJob } = props;
  const router = useRouter();
  const id = useId();
  const [scope, setScope] = useState("project");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(activeJob?.progress.message ?? null);
  const sendKey = useRef<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const running = activeJob !== null && activeJob.type === "revise";
  const count = cleanIdeaText(text).length;
  const sceneIndex = new Map(scenes.map((s, i) => [s.id, i]));

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [revisions.length]);

  // Poll C6 while a change runs (API.md §8.1).
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const schedule = (ms: number) => {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(poll, ms);
    };
    async function poll() {
      if (stopped) return;
      const answer = await apiSend<{ pollAfterMs: number | null; activeJob: JobResource | null }>("GET", `/api/v1/projects/${projectId}/status`);
      if (stopped) return;
      if (!answer.ok) {
        if (answer.status === 404) return router.refresh();
        failures++;
        return schedule(Math.min(POLL_MS * 2 ** failures, MAX_ERROR_BACKOFF_MS));
      }
      failures = 0;
      if (answer.json.pollAfterMs == null || !answer.json.activeJob) {
        stopped = true;
        return router.refresh();
      }
      setProgress(answer.json.activeJob.progress.message);
      schedule(document.visibilityState === "hidden" ? HIDDEN_POLL_MS : POLL_MS);
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule(POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [running, projectId, router]);

  async function send() {
    const message = cleanIdeaText(text);
    if (message.length < MIN) return setError(`Please write at least ${MIN} characters.`);
    if (message.length > MAX) return setError(`Please shorten it to ${MAX} characters.`);
    setBusy(true);
    setError(null);
    sendKey.current ??= newIdempotencyKey();
    const answer = await apiSend(
      "POST",
      `/api/v1/projects/${projectId}/revisions`,
      { stage: "storyboard", scope: scope === "project" ? "project" : "scene", ...(scope === "project" ? {} : { sceneId: scope }), message, basePlanVersionId: props.baseVersionId, expectedStateVersion: props.stateVersion },
      { "Idempotency-Key": sendKey.current },
    );
    if (!answer.ok) {
      // Same key again only when the answer was lost (offline / server error / still running).
      if (answer.status >= 400 && answer.status < 500 && answer.code !== "IDEMPOTENCY_IN_PROGRESS") sendKey.current = null;
      setBusy(false);
      return setError(answer.code === "STALE_VERSION" ? CLIENT_MESSAGES.STALE : answer.message);
    }
    props.announce("Working on your change.");
    router.refresh();
  }

  async function retry() {
    if (!failedJob) return;
    setBusy(true);
    setError(null);
    sendKey.current ??= newIdempotencyKey();
    const answer = await apiSend("POST", `/api/v1/jobs/${failedJob.id}/retry`, {}, { "Idempotency-Key": sendKey.current });
    if (!answer.ok) {
      if (answer.status >= 400 && answer.status < 500 && answer.code !== "IDEMPOTENCY_IN_PROGRESS") sendKey.current = null;
      setBusy(false);
      return setError(answer.message);
    }
    props.announce("Trying your change again.");
    router.refresh();
  }

  const locked = busy || running || props.disabled || !props.canRequest;
  const latest = revisions[revisions.length - 1];

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-amber/10 pb-4">
        <h2 id={`${id}-title`} className="font-display text-lg font-bold text-text">
          Ask for changes
        </h2>
        <label className="sr-only" htmlFor={`${id}-scope`}>
          What to change
        </label>
        <select
          id={`${id}-scope`}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          disabled={locked}
          className="min-h-9 max-w-full cursor-pointer rounded-full border border-line bg-surface-2 px-3 py-1 text-xs font-medium text-text hover:border-amber/40 disabled:opacity-50"
        >
          <option value="project">Whole storyboard</option>
          {scenes.map((s, i) => (
            <option key={s.id} value={s.id}>
              {sceneNumber(i)}
            </option>
          ))}
        </select>
      </div>

      {revisions.length > 0 && (
        <ol ref={listRef} aria-label="Change requests" className="mb-5 flex max-h-[360px] flex-col gap-3.5 overflow-y-auto pr-1">
          {revisions.map((r) => {
            const index = r.sceneId ? sceneIndex.get(r.sceneId) : undefined;
            const isLatest = r.id === latest?.id;
            const reply =
              r.status === "pending"
                ? running && isLatest
                  ? null
                  : "Waiting to start…"
                : r.status === "failed"
                  ? isLatest && failedJob
                    ? failedJob.message
                    : "Couldn't make this change."
                  : r.assistantReply;
            return (
              <li key={r.id} className="flex flex-col gap-2">
                <p className="max-w-[85%] self-end rounded-2xl rounded-tr-sm border border-amber/20 bg-progress-bg px-4 py-3 text-sm leading-relaxed break-words text-text">
                  {r.scope === "scene" && <span className="mr-1 font-mono text-[11px] text-amber uppercase">{index !== undefined ? sceneNumber(index) : "Scene"}:</span>}
                  {r.message}
                </p>
                {reply && (
                  <p className={cn("max-w-[88%] self-start rounded-2xl rounded-tl-sm border border-amber/10 bg-surface-2 px-4 py-3 text-sm leading-relaxed break-words", r.status === "failed" ? "text-danger" : "text-text")}>
                    {reply}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {running && (
        <div className="mb-4 flex flex-col gap-2">
          <p className="text-sm font-medium text-text">{progress ?? "Updating your storyboard…"}</p>
          <div role="progressbar" aria-label="Change progress" aria-valuetext={progress ?? "Working"} className="h-1.5 w-full overflow-hidden rounded-full bg-progress-bg">
            <div className="h-full w-2/5 rounded-full bg-progress motion-safe:animate-pulse" />
          </div>
          <p className="text-xs text-muted">This usually takes about a minute. You can leave this page; the change keeps going.</p>
        </div>
      )}

      {failedJob && props.canRetry && !running && (
        <button
          type="button"
          onClick={() => void retry()}
          disabled={busy || props.disabled}
          className="mb-4 inline-flex min-h-9 cursor-pointer items-center self-start rounded-full border border-line px-4 py-1.5 text-sm font-medium text-text transition hover:border-amber/40 disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? "Starting…" : "Try again"}
        </button>
      )}

      {props.requestsUsedUp ? (
        <p className="text-sm text-muted">This project has used all its 20 AI changes. You can still edit the narration yourself, or start a new project.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!locked) void send();
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={`${id}-text`} className="sr-only">
            Describe the change
          </label>
          <div className="relative flex items-end gap-2 rounded-2xl border border-line bg-surface-2 py-2 pr-2 pl-4 transition-colors focus-within:border-gold-cream">
            <textarea
              id={`${id}-text`}
              rows={2}
              value={text}
              maxLength={MAX * 2}
              disabled={locked}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!locked) void send();
                }
              }}
              placeholder="e.g. make it shorter, or scene 3: show this as a comparison"
              aria-describedby={`${id}-count`}
              className="block min-h-11 w-full resize-none bg-transparent py-1.5 text-sm leading-relaxed text-text outline-none placeholder:text-muted disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={locked || count < MIN || count > MAX}
              aria-label="Send change request"
              className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-amber/50 text-amber transition hover:bg-progress-bg disabled:pointer-events-none disabled:opacity-40"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="size-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </button>
          </div>
          <p id={`${id}-count`} className={cn("text-right font-mono text-[11px]", count > MAX ? "text-danger" : "text-muted")}>
            {count} / {MAX}
          </p>
        </form>
      )}
      <p aria-live="polite" className="text-sm text-danger empty:hidden">
        {error}
      </p>
    </section>
  );
}
