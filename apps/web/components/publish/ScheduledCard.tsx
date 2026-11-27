"use client";

import { istDateTimeLabel } from "@bytereel/db/post-schedule";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiSend } from "@/components/storyboard/client";
import { Note } from "@/components/storyboard/Note";

// ④ Publish, a scheduled post (F31; Stitch "ByteReel — Step 4 Post Scheduled"): "Scheduled for Sat 28
// Nov, 7:00 PM IST", the account it goes to, the approved caption as plain read-only text, a note that
// any change cancels the approval, and in the bar at the bottom Back to video, Change time and Cancel
// schedule (red outline). No amber primary button: nothing needs doing.
// - Cancel schedule: H5 (after a confirm); the page then shows the publish form again.
// - Change time: H5, then the publish form opens with Schedule chosen at the old time and the caption
//   kept (the approved caption is the saved caption); the creator ticks the approval again (a NEW H2).
// - At the time (if the page is still open, within a day), it reloads so the progress view shows.

export type ScheduledCardProps = {
  projectId: string;
  postId: string;
  scheduledAt: string;
  username: string;
  profilePictureUrl: string | null;
  caption: string;
};

const DAY_MS = 24 * 60 * 60_000;

export function ScheduledCard(props: ScheduledCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<"change" | "cancel" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const due = new Date(props.scheduledAt);

  useEffect(() => {
    const wait = Date.parse(props.scheduledAt) - Date.now() + 5_000;
    if (wait > DAY_MS) return;
    const timer = setTimeout(() => router.refresh(), Math.max(wait, 5_000));
    return () => clearTimeout(timer);
  }, [props.scheduledAt, router]);

  async function cancel(then: "change" | "cancel") {
    if (busy) return;
    if (then === "cancel" && !window.confirm("Cancel this scheduled post? It won't be posted.")) return;
    setBusy(then);
    setProblem(null);
    const answer = await apiSend("POST", `/api/v1/posts/${props.postId}/cancel`, {});
    if (!answer.ok) {
      setBusy(null);
      setProblem(answer.message);
      return;
    }
    if (then === "change") return router.replace(`/projects/${props.projectId}/publish?when=schedule&at=${encodeURIComponent(props.scheduledAt)}`);
    router.refresh();
  }

  return (
    <section aria-labelledby="scheduled-heading" data-testid="publish-scheduled" className="flex w-full flex-col gap-6 rounded-2xl border border-line bg-surface p-6 text-left shadow-card sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 rounded-full border border-amber/30 bg-warning-bg px-3 py-1 font-mono text-[11px] font-semibold tracking-widest text-amber uppercase">
          <span aria-hidden="true" className="size-2 rounded-full bg-amber shadow-[0_0_8px_#f5a524] motion-safe:animate-pulse" />
          Scheduled
        </span>
        <span className="font-mono text-[11px] text-muted">IST (UTC+5:30)</span>
      </div>

      <div className="flex flex-col gap-3">
        <h2 id="scheduled-heading" data-testid="scheduled-time" className="font-display text-2xl font-bold tracking-tight break-words text-text sm:text-3xl">
          Scheduled for {istDateTimeLabel(due)}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-tr from-amber via-amber-deep to-[#f7b44a] p-[2px]">
            {props.profilePictureUrl ? (
              // Instagram's own picture link: a plain <img>.
              <img src={props.profilePictureUrl} alt="" className="size-full rounded-full object-cover" />
            ) : (
              <span className="flex size-full items-center justify-center rounded-full bg-surface-2 font-display text-sm font-bold text-text">{props.username.charAt(0).toUpperCase()}</span>
            )}
          </span>
          <p className="flex flex-wrap items-center gap-1.5 text-[15px] break-all text-text">
            <span className="text-muted">Posting to</span>
            <span className="font-semibold">@{props.username}</span>
            <span className="ml-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted">Instagram Reel</span>
          </p>
        </div>
        <p className="text-[15px] text-muted">Keep this page or close it; it will post by itself at that time.</p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="font-mono text-xs font-semibold tracking-widest text-amber uppercase">Approved caption</h3>
        <p data-testid="scheduled-caption" className="rounded-2xl border border-line bg-surface-2 p-4 text-[15px] leading-relaxed break-words whitespace-pre-line text-text">
          {props.caption}
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface-2/60 p-4">
        <span aria-hidden="true" className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-amber/60 font-mono text-[11px] font-bold text-amber">
          i
        </span>
        <p className="text-sm leading-relaxed text-muted">Changing the video, narration, voice or caption cancels this approval. You&apos;ll be asked to approve again.</p>
      </div>

      {problem && (
        <div role="alert" data-testid="scheduled-problem">
          <Note tone="problem">{problem}</Note>
        </div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur-md sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 sm:gap-3">
          <Link
            href={`/projects/${props.projectId}/video`}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line px-4 text-sm text-text transition-colors hover:border-amber/40 hover:bg-surface-2 sm:px-5"
          >
            <span aria-hidden="true">←</span> <span className="hidden sm:inline">Back to video</span>
            <span className="sm:hidden">Back</span>
          </Link>
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => void cancel("change")}
              disabled={busy !== null}
              data-testid="scheduled-change-time"
              className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-line px-3.5 text-sm text-text transition-colors hover:border-amber/40 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 sm:px-5"
            >
              {busy === "change" ? "Opening…" : "Change time"}
            </button>
            <button
              type="button"
              onClick={() => void cancel("cancel")}
              disabled={busy !== null}
              data-testid="scheduled-cancel"
              className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-danger/40 px-3.5 text-sm font-medium text-danger transition-colors hover:border-danger hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-50 sm:px-5"
            >
              {busy === "cancel" ? "Cancelling…" : "Cancel schedule"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
