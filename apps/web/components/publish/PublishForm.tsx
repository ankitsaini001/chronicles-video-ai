"use client";

import { POST_CAPTION_LIMITS, postCaptionLength } from "@bytereel/db/post-caption";
import { earliestScheduleTime, fromIstParts, istApprovalLabel, istDateLabel, istParts, latestScheduleTime, scheduleProblem, SCHEDULE_LIMITS, toIstIso } from "@bytereel/db/post-schedule";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { apiSend, newIdempotencyKey } from "@/components/storyboard/client";
import { Note } from "@/components/storyboard/Note";
import { Button, cn } from "@/components/ui";
import { CaptionBox, type CaptionDraftView } from "./CaptionBox";

// ④ Publish, the publish form (F30; Stitch "ByteReel — Step 4 Publish"; F31: "Step 4 Schedule" and
// "Step 4 Needs Approval"): the CAPTION box (F29), WHEN (Publish now, or Schedule with a DATE and a
// TIME in India time, 5-minute steps, between 10 minutes and 7 days from now), the approval tick ("I
// approve posting video version N to @username", plus "on Sat 28 Nov at 7:00 PM IST" when scheduled)
// and, in the bar at the bottom, Back to video and the one primary button: "Publish now" or "Schedule
// post" ("Approve and schedule" when a change cancelled the earlier approval). It stays disabled until
// the box is ticked. Any change to the caption, the choice or the time unticks it: the creator approves
// exactly what is on screen (PRD §7).
// The button (H2) first saves the caption (H7), then sends the exact video (renderId + its MP4
// fingerprint), the account (connectionId), the caption and (scheduled) the time as ISO with +05:30,
// with a new Idempotency-Key (kept for a repeat of the same click). Success → the page shows the
// progress view (Publish now) or the Scheduled view.
// F30 code review: the page mounts a new form (React `key`) when the video or the account changes, so
// the tick can't carry over; a refused request and any caption change untick it.
// `again`: the earlier approval was cancelled (or the post must be approved again): a note says so.
// `banner` (F31): the big warning on top (Needs approval: …, Missed its time). `cancelPostId` (F31): the
// post that "Cancel schedule" (H5) cancels (a scheduled post whose approval a change cancelled).

export type PublishFormProps = {
  projectId: string;
  renderId: string;
  mp4Sha256: string;
  connectionId: string;
  username: string;
  videoVersion: number;
  stateVersion: number;
  initialDraft: CaptionDraftView | null;
  again?: string | null;
  /** F31: the time the page was made (ISO), so the server and the browser draw the same picker. */
  nowIso: string;
  /** F31: open with Schedule chosen (Change time, a post that needs approval again). */
  initialMode?: "now" | "scheduled";
  /** F31: the time to show first (ISO); used only when it is still between 10 minutes and 7 days away. */
  initialScheduledAt?: string | null;
  banner?: { title: string; text: string } | null;
  cancelPostId?: string | null;
};

/** Every 5-minute time of a day, "HH:MM" (24 h) → "7:05 PM". */
const TIMES: { value: string; label: string }[] = Array.from({ length: (24 * 60) / SCHEDULE_LIMITS.stepMinutes }, (_, i) => {
  const minutes = i * SCHEDULE_LIMITS.stepMinutes;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return { value, label: `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}` };
});

/** The picker's first value: the given time when still allowed, else about an hour from now (a 5-minute step). */
function firstPick(nowIso: string, initial: string | null | undefined): { date: string; time: string } {
  const now = new Date(nowIso);
  const given = initial ? new Date(initial) : null;
  if (given && !Number.isNaN(given.getTime()) && scheduleProblem(given, now) === null) return istParts(given);
  return istParts(earliestScheduleTime(new Date(now.getTime() + 50 * 60_000)));
}

export function PublishForm(props: PublishFormProps) {
  const router = useRouter();
  const [caption, setCaption] = useState(props.initialDraft?.text ?? "");
  const [mode, setMode] = useState<"now" | "scheduled">(props.initialMode ?? "now");
  const [pick, setPick] = useState(() => firstPick(props.nowIso, props.initialScheduledAt));
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<{ text: string; refresh: boolean } | null>(null);
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const key = useRef<string | null>(null);
  const approveId = useId();
  const dateId = useId();
  const timeId = useId();

  const shownCaption = useRef(props.initialDraft?.text ?? "");
  const onTextChange = useCallback((text: string) => {
    if (shownCaption.current === text) return;
    shownCaption.current = text;
    setCaption(text);
    // The creator approves exactly what is on screen: a different caption needs a new tick (and is a
    // new request, so a new Idempotency-Key).
    setApproved(false);
    key.current = null;
  }, []);

  /** Any change of WHEN is a different approval: untick, new key. */
  const changeWhen = (next: () => void) => {
    next();
    setApproved(false);
    key.current = null;
    setProblem(null);
  };

  const length = postCaptionLength(caption);
  const captionOk = caption.trim() !== "" && length <= POST_CAPTION_LIMITS.textMax;
  const scheduled = mode === "scheduled";
  const at = scheduled ? fromIstParts(pick.date, pick.time) : null;
  const pageNow = useMemo(() => new Date(props.nowIso), [props.nowIso]);
  // The picker's limits come from when the page was made; the exact window is checked at the click.
  const dateMin = istParts(earliestScheduleTime(pageNow)).date;
  const dateMax = istParts(latestScheduleTime(pageNow)).date;
  const timeOk = !scheduled || at !== null;
  const canPublish = approved && captionOk && timeOk && !busy && !cancelling;
  const primary = scheduled ? (props.cancelPostId ? "Approve and schedule" : "Schedule post") : "Publish now";

  async function publish() {
    if (!canPublish) return;
    // The window and the 5-minute step, against the clock right now (the server checks again).
    const timeProblem = scheduled ? (at ? scheduleProblem(at, new Date()) : "Pick a date and time.") : null;
    if (timeProblem) {
      setApproved(false);
      setProblem({ text: timeProblem, refresh: false });
      return;
    }
    setBusy(true);
    setProblem(null);
    // The key is made for THIS click before anything is awaited (code review nit), so a second click
    // during the caption save reuses it, and the request is sent with exactly the caption ticked.
    key.current ??= newIdempotencyKey();
    const idempotencyKey = key.current;
    const approvedCaption = caption;
    await flushRef.current?.();
    const answer = await apiSend(
      "POST",
      `/api/v1/projects/${props.projectId}/posts`,
      {
        mode,
        renderId: props.renderId,
        mp4Sha256: props.mp4Sha256,
        connectionId: props.connectionId,
        caption: approvedCaption,
        ...(scheduled && at ? { scheduledAt: toIstIso(at) } : {}),
        expectedStateVersion: props.stateVersion,
      },
      { "Idempotency-Key": idempotencyKey },
    );
    if (answer.ok) return router.refresh();
    // A refused click may be tried again with a new key; a lost answer keeps the same one.
    if (answer.status > 0 && answer.status < 500 && answer.code !== "IDEMPOTENCY_IN_PROGRESS") key.current = null;
    // Any refused Publish needs a new, deliberate tick (code review MUST 2).
    setApproved(false);
    setBusy(false);
    setProblem({ text: answer.message, refresh: answer.code === "STALE_VERSION" || answer.code === "APPROVAL_STALE" || answer.code === "INVALID_STATE" });
  }

  async function cancelSchedule() {
    if (!props.cancelPostId || cancelling || busy) return;
    if (!window.confirm("Cancel this scheduled post? It won't be posted.")) return;
    setCancelling(true);
    setProblem(null);
    const answer = await apiSend("POST", `/api/v1/posts/${props.cancelPostId}/cancel`, {});
    if (answer.ok) return router.refresh();
    setCancelling(false);
    setProblem({ text: answer.message, refresh: answer.code === "INVALID_STATE" });
  }

  return (
    <div className="flex w-full flex-col gap-5">
      {props.banner && (
        <div role="status" data-testid="publish-banner" className="flex items-start gap-3.5 rounded-2xl border border-warning/30 bg-warning-bg p-5 shadow-card">
          <WarningIcon />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-display text-base leading-snug font-bold break-words text-warning">{props.banner.title}</h2>
            <p className="text-sm leading-relaxed break-words text-warning/80">{props.banner.text}</p>
          </div>
        </div>
      )}
      {props.again && (
        <div role="status" data-testid="publish-again-note">
          <Note tone="warning">{props.again}</Note>
        </div>
      )}

      <CaptionBox projectId={props.projectId} renderId={props.renderId} initialDraft={props.initialDraft} onTextChange={onTextChange} flushRef={flushRef} readOnly={busy} />

      <section aria-labelledby="when-heading" data-testid="publish-when" className="flex flex-col gap-3.5 rounded-2xl border border-line bg-surface p-5 text-left shadow-card sm:p-6">
        <h2 id="when-heading" className="font-mono text-xs font-semibold tracking-widest text-amber uppercase">
          When
        </h2>
        <div role="radiogroup" aria-labelledby="when-heading" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <WhenChoice testId="when-now" title="Publish now" hint="Post to your account straight away" checked={!scheduled} disabled={busy} onSelect={() => changeWhen(() => setMode("now"))} />
          <WhenChoice testId="when-schedule" title="Schedule" hint="Pick a date and time (IST)" checked={scheduled} disabled={busy} onSelect={() => changeWhen(() => setMode("scheduled"))} />
        </div>
        {scheduled && (
          <div data-testid="schedule-picker" className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4">
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor={dateId} className="font-mono text-[11px] tracking-wider text-muted uppercase">
                  Date
                </label>
                <input
                  id={dateId}
                  type="date"
                  value={pick.date}
                  min={dateMin}
                  max={dateMax}
                  disabled={busy}
                  required
                  data-testid="schedule-date"
                  aria-describedby={`${dateId}-help`}
                  onChange={(event) => changeWhen(() => setPick((p) => ({ ...p, date: event.target.value })))}
                  className="min-h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] text-text [color-scheme:dark] focus:border-gold-cream focus:outline-none"
                />
                {at && <span className="sr-only">{istDateLabel(at)}</span>}
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor={timeId} className="font-mono text-[11px] tracking-wider text-muted uppercase">
                  Time (IST)
                </label>
                <select
                  id={timeId}
                  value={pick.time}
                  disabled={busy}
                  data-testid="schedule-time"
                  onChange={(event) => changeWhen(() => setPick((p) => ({ ...p, time: event.target.value })))}
                  className="min-h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] text-text [color-scheme:dark] focus:border-gold-cream focus:outline-none"
                >
                  {TIMES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p id={`${dateId}-help`} className="text-xs text-muted">
              Between 10 minutes and 7 days from now. Shown in India time (IST).
            </p>
          </div>
        )}
      </section>

      <section aria-label="Your approval" className="rounded-r-2xl border border-l-4 border-line border-l-amber bg-surface-2 p-4 text-left shadow-card">
        <div className="flex items-start gap-3">
          <input
            id={approveId}
            type="checkbox"
            checked={approved}
            disabled={!captionOk || !timeOk || busy}
            onChange={(event) => setApproved(event.target.checked)}
            data-testid="publish-approve"
            aria-describedby={`${approveId}-help`}
            className="mt-0.5 size-5 shrink-0 cursor-pointer accent-amber disabled:cursor-not-allowed"
          />
          <div>
            <label htmlFor={approveId} className="cursor-pointer text-sm font-medium break-words text-text select-none">
              I approve posting video version {props.videoVersion} to @{props.username}
              {scheduled && at ? ` on ${istApprovalLabel(at)}` : ""}.
            </label>
            <p id={`${approveId}-help`} className="mt-1 text-xs leading-relaxed text-muted">
              {!captionOk ? "Write a caption first (up to 2,200 characters)." : !timeOk ? "Pick a date and time first." : "If you change the video or caption, you'll need to approve again."}
            </p>
          </div>
        </div>
      </section>

      {problem && (
        <div role="alert" data-testid="publish-problem" className="flex flex-col gap-2">
          <Note tone="problem">{problem.text}</Note>
          {problem.refresh && (
            <button type="button" onClick={() => router.refresh()} className="self-start text-xs font-medium text-amber underline-offset-2 hover:underline">
              Refresh
            </button>
          )}
        </div>
      )}

      {/* The bar at the bottom (Stitch: fixed, Back to video on the left, the one primary button on the right). */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur-md sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <Link
            href={`/projects/${props.projectId}/video`}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line px-4 text-sm text-text transition-colors hover:border-amber/40 hover:bg-surface-2 sm:px-5"
          >
            <span aria-hidden="true">←</span> <span className="hidden min-[380px]:inline">Back to video</span>
            <span className="min-[380px]:hidden">Back</span>
          </Link>
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            {props.cancelPostId && (
              <button
                type="button"
                onClick={() => void cancelSchedule()}
                disabled={cancelling || busy}
                data-testid="publish-cancel-schedule"
                className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-danger/40 px-3.5 text-sm font-medium text-danger transition-colors hover:border-danger hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-50 sm:px-5"
              >
                {cancelling ? "Cancelling…" : "Cancel schedule"}
              </button>
            )}
            <Button type="button" onClick={() => void publish()} disabled={!canPublish} data-testid="publish-now">
              {busy ? (scheduled ? "Scheduling…" : "Publishing…") : primary}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WhenChoice(props: { testId: string; title: string; hint: string; checked: boolean; disabled: boolean; onSelect: () => void }) {
  return (
    <div
      role="radio"
      aria-checked={props.checked}
      aria-disabled={props.disabled || undefined}
      tabIndex={props.checked ? 0 : -1}
      data-testid={props.testId}
      onClick={() => !props.disabled && props.onSelect()}
      onKeyDown={(event) => {
        if (props.disabled) return;
        if (event.key === " " || event.key === "Enter" || event.key.startsWith("Arrow")) {
          event.preventDefault();
          props.onSelect();
        }
      }}
      className={cn(
        "cursor-pointer rounded-xl p-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-cream",
        props.checked ? "border-2 border-amber bg-amber/10 shadow-[0_0_15px_#f5a52426]" : "border border-line bg-surface-2 opacity-75 hover:opacity-100",
      )}
    >
      <div className="mb-1 flex items-center gap-2.5">
        <span aria-hidden="true" className={cn("flex size-4 items-center justify-center rounded-full border", props.checked ? "border-amber" : "border-muted/50")}>
          {props.checked && <span className="size-2 rounded-full bg-amber" />}
        </span>
        <span className="text-[15px] font-bold text-text">{props.title}</span>
      </div>
      <p className="pl-6.5 text-xs text-muted">{props.hint}</p>
    </div>
  );
}

function WarningIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 size-6 shrink-0 fill-warning">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
      />
    </svg>
  );
}
