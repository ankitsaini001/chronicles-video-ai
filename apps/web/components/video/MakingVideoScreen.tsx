"use client";

import type { JobResource } from "@bytereel/db";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiSend, newIdempotencyKey } from "@/components/storyboard/client";
import { Button, cn } from "@/components/ui";
import { videoSteps, waitingText, type VideoStepStatus } from "@/lib/video/steps";

// ③ Video while it is made (F23; Stitch "ByteReel — Step 3 Making video"): a phone frame on the left,
// the four steps on the right (Recording narration → Timing animations → Adding captions →
// Rendering). It polls C6 every 2 s (every 15 s while the tab is hidden; it stops when the job ends
// or the page is left), like the storyboard job panel; the work continues on the server, so coming
// back shows the live state. Cancel (E3) and Try again (E2). When the video is ready: its thumbnail
// in the phone and "Your video is ready"; watching and downloading it here is F24.

export type MakingVideoScreenProps = {
  projectId: string;
  title: string;
  state: "generating" | "generate_failed" | "video_ready";
  /** The video job (the running one, or the newest one after it ended). */
  job: JobResource | null;
  /** The ready video's thumbnail (a short-lived private link), when there is one. */
  thumbnailUrl: string | null;
  /** The failure shown after a failed job (`project.lastError`). */
  error: { code: string; message: string } | null;
  allowedActions: string[];
  archived: boolean;
};

const POLL_MS = 2000;
const HIDDEN_POLL_MS = 15000;
const MAX_ERROR_BACKOFF_MS = 10000;

type Status = { state?: string; pollAfterMs?: number | null; activeJob?: JobResource | null; allowedActions?: string[] };

export function MakingVideoScreen(props: MakingVideoScreenProps) {
  const router = useRouter();
  const [job, setJob] = useState<JobResource | null>(props.job);
  const [actions, setActions] = useState(props.allowedActions);
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const retryKey = useRef<string | null>(null);
  const generating = props.state === "generating";

  // Live state while the video is being made.
  useEffect(() => {
    if (!generating) return;
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
      let response: Response;
      try {
        response = await fetch(`/api/v1/projects/${props.projectId}/status`, { credentials: "same-origin", cache: "no-store" });
      } catch {
        failures++;
        return schedule(Math.min(POLL_MS * 2 ** failures, MAX_ERROR_BACKOFF_MS));
      }
      if (stopped) return;
      if (response.status === 401) return window.location.assign("/login");
      if (!response.ok) {
        failures++;
        return schedule(Math.min(POLL_MS * 2 ** failures, MAX_ERROR_BACKOFF_MS));
      }
      failures = 0;
      const status = (await response.json().catch(() => ({}))) as Status;
      if (status.state !== "generating" || status.pollAfterMs == null) {
        stopped = true;
        // Cancelled or the storyboard must change: back to the storyboard. Ready or failed: this page again.
        if (status.state === "storyboard_ready") return router.replace(`/projects/${props.projectId}/storyboard`);
        return router.refresh();
      }
      if (status.activeJob) setJob(status.activeJob);
      if (status.allowedActions) setActions(status.allowedActions);
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
  }, [generating, props.projectId, router]);

  async function cancel() {
    if (!job || busy) return;
    setBusy("cancel");
    setProblem(null);
    const answer = await apiSend<JobResource>("POST", `/api/v1/jobs/${job.id}/cancel`, {});
    if (!answer.ok) {
      setBusy(null);
      return setProblem(answer.message);
    }
    setJob(answer.json);
    // A waiting video stops at once; a running one within a few seconds (the poll sees it).
    if (answer.json.state === "cancelled") router.replace(`/projects/${props.projectId}/storyboard`);
  }

  async function retry() {
    if (!job || busy) return;
    setBusy("retry");
    setProblem(null);
    retryKey.current ??= newIdempotencyKey();
    const answer = await apiSend("POST", `/api/v1/jobs/${job.id}/retry`, {}, { "Idempotency-Key": retryKey.current });
    if (!answer.ok) {
      if (answer.status < 500 && answer.code !== "IDEMPOTENCY_IN_PROGRESS") retryKey.current = null;
      setBusy(null);
      return setProblem(answer.message);
    }
    router.refresh();
  }

  const waiting = generating && (!job || job.state === "queued");
  const cancelling = generating && job?.cancelRequestedAt != null;
  const steps = videoSteps(props.state === "video_ready" ? { state: "succeeded", stages: [], progress: { stage: "", percent: 100, message: "" } } : job);
  const ready = props.state === "video_ready";
  const failed = props.state === "generate_failed";
  const canRetry = failed && actions.includes("retry_job") && job !== null && !props.archived;
  const canCancel = generating && actions.includes("cancel_job") && !cancelling;

  const heading = ready ? "Your video is ready" : failed ? "We couldn't finish your video" : "Making your video";
  return (
    <div className="mx-auto grid w-full max-w-4xl grid-cols-1 items-center gap-10 md:grid-cols-12 lg:gap-14">
      <div className="flex justify-center md:col-span-5">
        <Phone thumbnailUrl={ready ? props.thumbnailUrl : null} working={generating} />
      </div>
      <section aria-labelledby="video-heading" className="rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-10 md:col-span-7">
        <p className="mb-2 text-sm font-medium break-words text-muted">{props.title}</p>
        <h1 id="video-heading" className="mb-3 font-display text-3xl font-bold tracking-tight text-text sm:text-4xl">
          {heading}
        </h1>
        <p role="status" aria-live="polite" className="mb-8 text-[15px] leading-relaxed text-muted">
          {ready
            ? "Watching and downloading it here comes in the next update."
            : failed
              ? "Your storyboard and any recorded narration are saved."
              : cancelling
                ? "Stopping…"
                : waiting
                  ? `${waitingText(job?.queue?.ahead)} You can leave this page; we'll start it for you.`
                  : "You can leave this page. We'll keep working and save everything."}
        </p>

        <ol aria-label="Steps" className="mb-9 flex flex-col gap-4">
          {steps.map((step) => (
            <li key={step.label} className="flex items-center gap-3.5">
              <StepIcon status={step.status} />
              <span className={cn("text-[15px]", step.status === "todo" ? "text-muted" : "font-medium text-text")}>
                {step.label}
                {step.status === "active" && step.detail && step.detail.includes("%") && <span className="ml-2 font-mono text-xs text-muted">{step.detail.replace(/^Rendering · /, "")}</span>}
                <span className="sr-only">{` (${STATUS_WORDS[step.status]})`}</span>
              </span>
            </li>
          ))}
        </ol>

        {failed && (
          <p role="alert" className="mb-6 rounded-2xl border border-danger/40 bg-danger-bg px-4 py-3 text-[15px] text-text">
            {props.error?.message ?? "Something went wrong on our side. Please try again."}
          </p>
        )}
        {problem && (
          <p role="alert" className="mb-6 text-sm text-danger">
            {problem}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-5">
          {canRetry && (
            <Button type="button" onClick={() => void retry()} disabled={busy !== null}>
              {busy === "retry" ? "Starting…" : "Try again"}
            </Button>
          )}
          <Button href="/dashboard" variant="secondary">
            Back to My videos
          </Button>
          {canCancel && (
            <button type="button" onClick={() => void cancel()} disabled={busy !== null} className="min-h-11 cursor-pointer px-1 text-sm font-medium text-muted transition-colors hover:text-danger disabled:opacity-50">
              {busy === "cancel" ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

const STATUS_WORDS: Record<VideoStepStatus, string> = { done: "done", active: "in progress", todo: "not started", failed: "failed" };

function StepIcon({ status }: { status: VideoStepStatus }) {
  if (status === "done") {
    return (
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-success/30 bg-success-bg text-success">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="size-3.5">
          <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
        </svg>
      </span>
    );
  }
  if (status === "active") return <span aria-hidden="true" className="size-6 shrink-0 rounded-full border-2 border-amber/15 border-t-amber motion-safe:animate-spin" />;
  if (status === "failed") {
    return (
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-danger/40 bg-danger-bg text-danger">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className="size-3">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-muted/20">
      <span className="size-1.5 rounded-full bg-muted/20" />
    </span>
  );
}

/** The 9:16 phone frame: a soft shimmering placeholder while working, the thumbnail when ready. */
function Phone({ thumbnailUrl, working }: { thumbnailUrl: string | null; working: boolean }) {
  return (
    <div aria-hidden="true" className="relative aspect-[9/16] w-[240px] rounded-[28px] border border-line bg-surface-2 p-2.5 shadow-card sm:w-[280px]">
      <div className="absolute top-4 left-1/2 z-10 flex h-4 w-20 -translate-x-1/2 items-center justify-center rounded-full bg-bg/80">
        <span className="mr-2 size-2.5 rounded-full bg-surface-2" />
        <span className="h-1 w-8 rounded-full bg-surface-2" />
      </div>
      <div className="relative flex size-full flex-col justify-between overflow-hidden rounded-[20px] border border-line bg-screen p-6">
        {thumbnailUrl ? (
          // A short-lived signed address: a plain <img>, nothing for Next.js to optimise.
          <img src={thumbnailUrl} alt="" className="absolute inset-0 size-full object-cover" />
        ) : (
          <>
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-amber/5 via-transparent to-amber/5" />
            <div className="mt-6 flex items-center justify-between">
              <span className="h-1.5 w-8 rounded-full bg-surface-2" />
              <span className="size-3 rounded-full bg-surface-2" />
            </div>
            <div className={cn("my-auto flex flex-col items-center gap-3", working && "motion-safe:animate-pulse")}>
              <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="size-24 text-amber/40">
                <path d="M18 42h28a12 12 0 0 0 2-23.8 16 16 0 0 0-31.5-2.2A10 10 0 0 0 18 42z" />
              </svg>
              <span className="h-px w-24 bg-gradient-to-r from-transparent via-amber/20 to-transparent" />
            </div>
            <div className="flex flex-col gap-2.5 pb-2">
              <span className={cn("h-3.5 w-full rounded-full bg-progress-bg", working && "motion-safe:animate-pulse")} />
              <span className={cn("mx-auto h-3 w-3/4 rounded-full bg-progress-bg", working && "motion-safe:animate-pulse")} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
