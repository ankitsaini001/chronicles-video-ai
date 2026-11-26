"use client";

import type { JobResource } from "@bytereel/db";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiSend, newIdempotencyKey } from "@/components/storyboard/client";
import { Button, cn } from "@/components/ui";

// ④ Publish while the reel is sent to Instagram, and after it failed (F30; the video page's progress
// and failure style, MakingVideoScreen). Three steps: Sending your video to Instagram → Instagram is
// processing it → Publishing. When Instagram's answer was lost the line says "Checking whether your
// post went live…" (reconcile). It polls C6 every 2 s (every 15 s while the tab is hidden; it stops
// when the post is done or the page is left); the work continues on the server, so leaving is fine.
// Failed: the plain reason, Try again (H6: the same approval, re-checked; it never posts twice) when it
// can help, and "approve again" (the publish form, `children`) when something must change first.
// Check (F30 code review MUST 1): an earlier publish may be live and can't be tried again; the only
// button is "Check again" (H6 reads Instagram and never posts). Published or proven not posted → the
// page reloads (Published screen, or the form to approve again); no clear answer → a plain line.

export type PublishStatusScreenProps = {
  projectId: string;
  postId: string;
  title: string;
  thumbnailUrl: string | null;
  username: string;
  mode: "publishing" | "failed" | "check";
  job: JobResource | null;
  /** The failure shown after a failed post. */
  failure: { message: string; retryable: boolean } | null;
  /** The publish form ("approve again"), shown on request or when Try again can't help. */
  children?: ReactNode;
  showFormFirst?: boolean;
};

const POLL_MS = 2000;
const HIDDEN_POLL_MS = 15000;
const MAX_ERROR_BACKOFF_MS = 10000;

type StepStatus = "done" | "active" | "todo" | "failed";
const STEPS: { label: string; stages: string[] }[] = [
  { label: "Sending your video to Instagram", stages: ["approve", "create_container"] },
  { label: "Instagram is processing it", stages: ["poll"] },
  { label: "Publishing", stages: ["publish", "reconcile"] },
];

/** Each of the three steps from the job's stages (API.md §8.2: approve → create_container → poll → publish (+ reconcile)). */
export function publishSteps(job: JobResource | null): { label: string; status: StepStatus }[] {
  const stages = job?.stages ?? [];
  const current = job?.progress.stage ?? "approve";
  return STEPS.map((step) => {
    const mine = stages.filter((s) => step.stages.includes(s.name));
    if (mine.some((s) => s.status === "failed")) return { label: step.label, status: "failed" };
    if (mine.some((s) => s.status === "running") || (job?.state === "running" && step.stages.includes(current) && !mine.every((s) => s.status === "succeeded"))) return { label: step.label, status: "active" };
    const real = mine.filter((s) => s.name !== "reconcile" || s.status !== "pending");
    if (real.length > 0 && real.every((s) => s.status === "succeeded" || s.status === "skipped")) return { label: step.label, status: "done" };
    return { label: step.label, status: "todo" };
  });
}

type Status = { state?: string; pollAfterMs?: number | null; activeJob?: JobResource | null };

export function PublishStatusScreen(props: PublishStatusScreenProps) {
  const router = useRouter();
  const [job, setJob] = useState<JobResource | null>(props.job);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(props.showFormFirst === true);
  const retryKey = useRef<string | null>(null);
  const publishing = props.mode === "publishing";

  useEffect(() => {
    if (!publishing) return;
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
      if (status.state !== "publishing") {
        stopped = true;
        // Published or failed: the page shows the Published screen or the reason.
        return router.refresh();
      }
      if (status.activeJob) setJob(status.activeJob);
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
  }, [publishing, props.projectId, router]);

  async function retry() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    retryKey.current ??= newIdempotencyKey();
    const answer = await apiSend<{ outcome?: string; message?: string }>("POST", `/api/v1/posts/${props.postId}/retry`, {}, { "Idempotency-Key": retryKey.current });
    if (answer.ok) {
      // Check again without a clear answer: nothing changed; say so (a new key for the next tap).
      if (answer.json?.outcome === "unknown") {
        retryKey.current = null;
        setBusy(false);
        setProblem(answer.json.message ?? "Instagram didn't give a clear answer yet. Please try again in a few minutes.");
        return;
      }
      return router.refresh();
    }
    if (answer.status > 0 && answer.status < 500 && answer.code !== "IDEMPOTENCY_IN_PROGRESS") retryKey.current = null;
    setBusy(false);
    setProblem(answer.message);
    // Something changed since the approval: the creator checks and approves again.
    if (answer.code === "APPROVAL_STALE" && props.children) setShowForm(true);
  }

  const steps = publishSteps(job);
  const checking = job?.progress.stage === "reconcile";
  const check = props.mode === "check";
  // The check view looks like the failed one (the reason box, one button), with "Check again".
  const failed = props.mode === "failed" || check;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <div className="grid grid-cols-1 items-center gap-10 md:grid-cols-12 lg:gap-14">
        <div className="flex justify-center md:col-span-5">
          <div className="relative aspect-[9/16] w-[200px] overflow-hidden rounded-[20px] border border-line bg-screen shadow-card sm:w-[240px]">
            {props.thumbnailUrl ? (
              // A short-lived private link (15 min): a plain <img>.
              <img src={props.thumbnailUrl} alt={`Your video: ${props.title}`} className={cn("absolute inset-0 size-full object-cover", publishing && "motion-safe:animate-pulse")} />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted">{props.title}</span>
            )}
          </div>
        </div>
        <section
          aria-labelledby="publish-status-heading"
          data-testid={check ? "publish-check" : failed ? "publish-failed" : "publish-progress"}
          className="rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-10 md:col-span-7"
        >
          <p className="mb-2 text-sm font-medium break-words text-muted">{props.title}</p>
          <h1 id="publish-status-heading" className="mb-3 font-display text-3xl font-bold tracking-tight text-text sm:text-4xl">
            {check ? "Did your reel go live?" : failed ? "Your reel wasn't posted" : "Publishing your reel"}
          </h1>
          <p role="status" aria-live="polite" data-testid="publish-status-line" className="mb-8 text-[15px] leading-relaxed break-words text-muted">
            {check
              ? `We sent it to @${props.username}, but Instagram's answer got lost.`
              : failed
                ? "Your video and caption are saved."
                : checking
                  ? "Checking whether your post went live… We never post it twice."
                  : `To @${props.username}. You can leave this page; we'll keep going.`}
          </p>

          <ol aria-label="Steps" className={cn("mb-9 flex flex-col gap-4", check && "hidden")}>
            {steps.map((step) => (
              <li key={step.label} className="flex items-center gap-3.5">
                <StepIcon status={step.status} />
                <span className={cn("text-[15px]", step.status === "todo" ? "text-muted" : "font-medium text-text")}>
                  {step.label}
                  {step.status === "active" ? "…" : ""}
                  <span className="sr-only">{` (${STATUS_WORDS[step.status]})`}</span>
                </span>
              </li>
            ))}
          </ol>

          {failed && (
            <p role="alert" data-testid="publish-failure" className="mb-6 rounded-2xl border border-danger/40 bg-danger-bg px-4 py-3 text-[15px] text-text">
              {props.failure?.message ?? "Something went wrong on our side. Please try again."}
            </p>
          )}
          {problem && (
            <p role="alert" data-testid="publish-retry-problem" className="mb-6 text-sm text-danger">
              {problem}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-5">
            {check && (
              <Button type="button" onClick={() => void retry()} disabled={busy} data-testid="publish-check-again">
                {busy ? "Checking…" : "Check again"}
              </Button>
            )}
            {!check && failed && props.failure?.retryable && !showForm && (
              <Button type="button" onClick={() => void retry()} disabled={busy} data-testid="publish-retry">
                {busy ? "Starting…" : "Try again"}
              </Button>
            )}
            <Button href="/dashboard" variant="secondary">
              Back to My videos
            </Button>
            {failed && props.children && !showForm && (
              <button type="button" onClick={() => setShowForm(true)} data-testid="publish-approve-again" className="inline-flex min-h-11 cursor-pointer items-center px-1 text-sm font-medium text-muted transition-colors hover:text-text">
                Change the caption and approve again
              </button>
            )}
          </div>
        </section>
      </div>
      {failed && showForm && props.children}
    </div>
  );
}

const STATUS_WORDS: Record<StepStatus, string> = { done: "done", active: "in progress", todo: "not started", failed: "failed" };

function StepIcon({ status }: { status: StepStatus }) {
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
