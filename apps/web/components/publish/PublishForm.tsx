"use client";

import { POST_CAPTION_LIMITS, postCaptionLength } from "@bytereel/db/post-caption";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState } from "react";
import { apiSend, newIdempotencyKey } from "@/components/storyboard/client";
import { Note } from "@/components/storyboard/Note";
import { Button } from "@/components/ui";
import { CaptionBox, type CaptionDraftView } from "./CaptionBox";

// ④ Publish, the publish form (F30; Stitch "ByteReel — Step 4 Publish"): the CAPTION box (F29), WHEN
// (Publish now, selected; Schedule greyed out, "Coming soon" until F31), the approval tick ("I approve
// posting video version N to @username.") and, in the bar at the bottom, Back to video and
// "Publish now ↗", which stays disabled until the box is ticked. Any change to the caption unticks
// it: the creator approves exactly what is on screen (PRD §7).
// Publish now (H2) first saves the caption (H7), then sends the exact video (renderId + its MP4
// fingerprint), the account (connectionId) and the caption with a new Idempotency-Key (kept for a
// repeat of the same click, like Try again elsewhere). Success → the page shows the progress view.
// `again`: the earlier approval was cancelled (or the post must be approved again): a note says so.

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
};

export function PublishForm(props: PublishFormProps) {
  const router = useRouter();
  const [caption, setCaption] = useState(props.initialDraft?.text ?? "");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; refresh: boolean } | null>(null);
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const key = useRef<string | null>(null);
  const approveId = useId();

  const shownCaption = useRef(props.initialDraft?.text ?? "");
  const onTextChange = useCallback((text: string) => {
    if (shownCaption.current === text) return;
    shownCaption.current = text;
    setCaption(text);
    // The creator approves exactly what is on screen: a different caption needs a new tick.
    setApproved(false);
  }, []);

  const length = postCaptionLength(caption);
  const captionOk = caption.trim() !== "" && length <= POST_CAPTION_LIMITS.textMax;
  const canPublish = approved && captionOk && !busy;

  async function publish() {
    if (!canPublish) return;
    setBusy(true);
    setProblem(null);
    await flushRef.current?.();
    key.current ??= newIdempotencyKey();
    const answer = await apiSend(
      "POST",
      `/api/v1/projects/${props.projectId}/posts`,
      { mode: "now", renderId: props.renderId, mp4Sha256: props.mp4Sha256, connectionId: props.connectionId, caption, expectedStateVersion: props.stateVersion },
      { "Idempotency-Key": key.current },
    );
    if (answer.ok) return router.refresh();
    // A refused click may be tried again with a new key; a lost answer keeps the same one.
    if (answer.status > 0 && answer.status < 500 && answer.code !== "IDEMPOTENCY_IN_PROGRESS") key.current = null;
    setBusy(false);
    setProblem({ text: answer.message, refresh: answer.code === "STALE_VERSION" || answer.code === "APPROVAL_STALE" || answer.code === "INVALID_STATE" });
  }

  return (
    <div className="flex w-full flex-col gap-5">
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
          <div role="radio" aria-checked="true" tabIndex={0} data-testid="when-now" className="rounded-xl border-2 border-amber bg-amber/10 p-4 shadow-[0_0_15px_#f5a52426]">
            <div className="mb-1 flex items-center gap-2.5">
              <span aria-hidden="true" className="flex size-4 items-center justify-center rounded-full border border-amber">
                <span className="size-2 rounded-full bg-amber" />
              </span>
              <span className="text-[15px] font-bold text-text">Publish now</span>
            </div>
            <p className="pl-6.5 text-xs text-muted">Post to your account straight away</p>
          </div>
          <div role="radio" aria-checked="false" aria-disabled="true" data-testid="when-schedule" className="cursor-not-allowed rounded-xl border border-line bg-surface-2 p-4 opacity-55">
            <div className="mb-1 flex items-center gap-2.5">
              <span aria-hidden="true" className="size-4 rounded-full border border-muted/50" />
              <span className="text-[15px] font-bold text-text">Schedule</span>
              <span className="ml-auto rounded-full border border-line px-2 py-0.5 font-mono text-[10px] tracking-wide text-muted uppercase">Coming soon</span>
            </div>
            <p className="pl-6.5 text-xs text-muted">Pick a date and time</p>
          </div>
        </div>
      </section>

      <section aria-label="Your approval" className="rounded-r-2xl border border-l-4 border-line border-l-amber bg-surface-2 p-4 text-left shadow-card">
        <div className="flex items-start gap-3">
          <input
            id={approveId}
            type="checkbox"
            checked={approved}
            disabled={!captionOk || busy}
            onChange={(event) => setApproved(event.target.checked)}
            data-testid="publish-approve"
            aria-describedby={`${approveId}-help`}
            className="mt-0.5 size-5 shrink-0 cursor-pointer accent-amber disabled:cursor-not-allowed"
          />
          <div>
            <label htmlFor={approveId} className="cursor-pointer text-sm font-medium break-words text-text select-none">
              I approve posting video version {props.videoVersion} to @{props.username}.
            </label>
            <p id={`${approveId}-help`} className="mt-1 text-xs leading-relaxed text-muted">
              {captionOk ? "If you change the video or caption, you'll need to approve again." : "Write a caption first (up to 2,200 characters)."}
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
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-4 text-sm text-text transition-colors hover:border-amber/40 hover:bg-surface-2 sm:px-5"
          >
            <span aria-hidden="true">←</span> <span className="hidden min-[380px]:inline">Back to video</span>
            <span className="min-[380px]:hidden">Back</span>
          </Link>
          <Button type="button" onClick={() => void publish()} disabled={!canPublish} data-testid="publish-now">
            {busy ? "Publishing…" : "Publish now"}
          </Button>
        </div>
      </div>
    </div>
  );
}
