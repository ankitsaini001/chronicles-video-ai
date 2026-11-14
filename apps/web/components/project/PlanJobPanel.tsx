"use client";

import { cleanIdeaText } from "@bytereel/db/idea-text";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";

// The storyboard job on the project page (F15, API.md §8): while the AI writes the storyboard it
// polls C6 every 2 s (every 15 s while the tab is hidden; it stops when the job ends or the page is
// left) and shows the job's progress; work continues on the server even if the page is closed, so
// coming back shows the same progress. When the job ends, the page reloads its server data.
// After a failure: the plain message, **Try again** (E2) and **Edit idea** (C4 inline, then E2).
// One primary button at a time. Status changes are announced (aria-live).

export type PlanJobPanelProps = {
  projectId: string;
  state: "planning" | "plan_failed";
  stateVersion: number;
  /** The newest plan job (the one Try again retries). */
  jobId: string | null;
  progress: { percent: number; message: string } | null;
  lastError: { code: string; message: string } | null;
  allowedActions: string[];
  /** True when the project has used all its storyboard requests (20; decided on the server). */
  requestsUsedUp: boolean;
  /** When the current job was started or retried (ISO), for the "taking longer" line. */
  queuedAt: string | null;
  idea: { text: string; min: number; max: number };
};

const POLL_MS = 2000;
const HIDDEN_POLL_MS = 15000;
const MAX_ERROR_BACKOFF_MS = 10000;
/** After this long, the page says the storyboard is taking longer than usual (one line, nothing else changes). */
const SLOW_AFTER_MS = 3 * 60_000;

const MESSAGES = {
  OFFLINE: "Couldn't reach the server. Check your internet connection and try again.",
  INTERNAL: "Something went wrong on our side. Please try again.",
} as const;

type ApiError = { error?: { code?: string; message?: string; details?: { issues?: { path?: string; message?: string }[] } } };
type Status = { state?: string; pollAfterMs?: number | null; activeJob?: { progress?: { percent?: number; message?: string } } | null };

function newIdempotencyKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The failure text for the job's error code (API.md §4.3). */
function failureText(code: string | undefined, fallback: string | undefined): string {
  switch (code) {
    case "PLAN_INVALID":
      return "Couldn't build a good storyboard, try rephrasing.";
    case "PROVIDER_BUSY":
      return "Our AI is very busy right now. Your idea is saved; please try again in a few minutes.";
    case "PROVIDER_REJECTED":
      return "We can't make a video about this topic. Please edit your idea.";
    default:
      return fallback ?? MESSAGES.INTERNAL;
  }
}

export function PlanJobPanel(props: PlanJobPanelProps) {
  return props.state === "planning" ? <Progress {...props} /> : <Failed {...props} />;
}

function Progress({ projectId, progress, queuedAt }: PlanJobPanelProps) {
  const router = useRouter();
  const [current, setCurrent] = useState(progress ?? { percent: 0, message: "Writing your storyboard…" });
  const startedMs = queuedAt ? Date.parse(queuedAt) : NaN;
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const schedule = (ms: number) => {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(poll, ms);
    };
    const nextDelay = () => (document.visibilityState === "hidden" ? HIDDEN_POLL_MS : POLL_MS);
    async function poll() {
      if (stopped) return;
      let response: Response;
      try {
        response = await fetch(`/api/v1/projects/${projectId}/status`, { credentials: "same-origin", cache: "no-store" });
      } catch {
        failures++;
        return schedule(Math.min(POLL_MS * 2 ** failures, MAX_ERROR_BACKOFF_MS));
      }
      if (stopped) return;
      if (response.status === 401) return window.location.assign("/login");
      if (response.status === 404) return router.refresh();
      if (!response.ok) {
        failures++;
        return schedule(Math.min(POLL_MS * 2 ** failures, MAX_ERROR_BACKOFF_MS));
      }
      failures = 0;
      if (Number.isFinite(startedMs) && Date.now() - startedMs > SLOW_AFTER_MS) setSlow(true);
      const status = (await response.json().catch(() => ({}))) as Status;
      if (status.state !== "planning" || status.pollAfterMs == null) {
        stopped = true;
        return router.refresh(); // done or failed: the server page shows the result
      }
      const p = status.activeJob?.progress;
      if (p?.message) setCurrent({ percent: typeof p.percent === "number" ? p.percent : 0, message: p.message });
      schedule(nextDelay());
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
  }, [projectId, router, startedMs]);

  const percent = Math.max(5, Math.min(100, current.percent));
  return (
    <div className="flex flex-col gap-4">
      <p role="status" aria-live="polite" className="font-display text-xl font-bold text-text">
        {current.message}
      </p>
      <div
        role="progressbar"
        aria-label="Storyboard progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 w-full overflow-hidden rounded-full bg-progress-bg"
      >
        <div className="h-full rounded-full bg-progress transition-[width] duration-700 motion-safe:animate-pulse" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-sm text-muted">This usually takes 1–2 minutes. You can leave this page; we'll keep working and your storyboard will be here when you come back.</p>
      {slow && <p className="text-sm text-text">This is taking longer than usual. Our AI may be busy; we're still working on it.</p>}
    </div>
  );
}

function Failed({ projectId, stateVersion, jobId, lastError, allowedActions, requestsUsedUp, idea }: PlanJobPanelProps) {
  const router = useRouter();
  const textId = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(idea.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const retryKey = useRef<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const canRetry = allowedActions.includes("retry_job") && jobId !== null;
  const canEdit = allowedActions.includes("edit_idea");
  const count = cleanIdeaText(text).length;

  useEffect(() => {
    if (editing) textRef.current?.focus();
  }, [editing]);

  /** E2 Try again. The same key is re-sent after a lost answer, so one click can't start two runs. */
  async function retry(): Promise<boolean> {
    if (!jobId) return false;
    retryKey.current ??= newIdempotencyKey();
    let response: Response;
    try {
      response = await fetch(`/api/v1/jobs/${jobId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": retryKey.current },
        credentials: "same-origin",
        body: "{}",
      });
    } catch {
      setError(MESSAGES.OFFLINE);
      return false;
    }
    if (response.ok) return true;
    const json = (await response.json().catch(() => ({}))) as ApiError;
    if (response.status < 500 && json.error?.code !== "IDEMPOTENCY_IN_PROGRESS") retryKey.current = null;
    if (response.status === 401) window.location.assign("/login");
    setError(response.status >= 500 ? MESSAGES.INTERNAL : (json.error?.message ?? MESSAGES.INTERNAL));
    return false;
  }

  async function onTryAgain() {
    if (busy) return;
    setBusy(true);
    setError(null);
    if (await retry()) return router.refresh();
    setBusy(false);
  }

  async function onSaveAndRetry() {
    if (busy) return;
    const clean = cleanIdeaText(text);
    if (clean.length < idea.min) return setTextError(`Please write at least ${idea.min} characters.`);
    if (clean.length > idea.max) return setTextError(`Please shorten it to ${idea.max.toLocaleString("en-US")} characters.`);
    setTextError(null);
    setError(null);
    setBusy(true);
    if (clean !== cleanIdeaText(idea.text)) {
      let response: Response;
      try {
        response = await fetch(`/api/v1/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ text: clean, expectedStateVersion: stateVersion }),
        });
      } catch {
        setBusy(false);
        return setError(MESSAGES.OFFLINE);
      }
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as ApiError;
        setBusy(false);
        if (response.status === 401) return window.location.assign("/login");
        const issue = json.error?.details?.issues?.find((i) => i.path === "text");
        if (issue) return setTextError(`Your idea ${issue.message}.`);
        return setError(response.status >= 500 ? MESSAGES.INTERNAL : (json.error?.message ?? MESSAGES.INTERNAL));
      }
    }
    if (await retry()) return router.refresh();
    setBusy(false);
    router.refresh(); // the idea was saved: show it (and the new version number) even if the retry was refused
  }

  return (
    <div className="flex flex-col gap-5">
      <p role="alert" className="rounded-2xl border border-danger/40 bg-danger-bg px-4 py-3 text-base text-text">
        {failureText(lastError?.code, lastError?.message)}
      </p>
      {requestsUsedUp && <p className="text-sm text-muted">This project has used all its storyboard requests. Start a new project to keep going.</p>}

      {editing ? (
        <div className="flex flex-col gap-3">
          <label htmlFor={textId} className="font-mono text-xs uppercase tracking-wider text-muted">
            Your idea
          </label>
          <div className={cn("rounded-2xl border bg-surface-2 p-4 pb-9 relative transition-colors focus-within:border-gold-cream", textError ? "border-danger" : "border-line")}>
            <textarea
              ref={textRef}
              id={textId}
              rows={5}
              value={text}
              maxLength={idea.max * 4}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={textError ? true : undefined}
              aria-describedby={`${textId}-count${textError ? ` ${textId}-error` : ""}`}
              className="block w-full resize-y bg-transparent text-base leading-relaxed text-text outline-none placeholder:text-muted"
            />
            <span id={`${textId}-count`} className={cn("absolute right-4 bottom-3 font-mono text-xs", count > idea.max ? "text-danger" : "text-muted")}>
              {count.toLocaleString("en-US")} / {idea.max.toLocaleString("en-US")}
            </span>
          </div>
          {textError && (
            <p id={`${textId}-error`} className="text-sm text-danger">
              {textError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={onSaveAndRetry} disabled={busy}>
              {busy ? "Starting…" : "Save and try again"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => { setEditing(false); setText(idea.text); setTextError(null); }} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {canRetry && (
            <Button type="button" onClick={onTryAgain} disabled={busy}>
              {busy ? "Starting…" : "Try again"}
            </Button>
          )}
          {canEdit && (
            <Button type="button" variant={canRetry ? "secondary" : "primary"} onClick={() => setEditing(true)} disabled={busy}>
              Edit idea
            </Button>
          )}
        </div>
      )}
      <p aria-live="polite" className="text-sm text-danger empty:hidden">
        {error}
      </p>
    </div>
  );
}
