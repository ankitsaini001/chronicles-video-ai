"use client";

import type { JobResource, RenderSummaryResource, RevisionResource } from "@bytereel/db";
import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ChangesPanel } from "@/components/storyboard/ChangesPanel";
import { apiSend } from "@/components/storyboard/client";
import { Note } from "@/components/storyboard/Note";
import { Button, cn } from "@/components/ui";
import { afterPlayerError, LinkRequests, type Resume } from "@/lib/video/player-link";
import { CaptionsPanel, type LastCaptionJob } from "./CaptionsPanel";
import { VideoVersionMenu } from "./VideoVersionMenu";

// ③ Video when it is ready (F24; Stitch "ByteReel — Step 3 Review video"): the real MP4 in the phone
// frame (HTML5 player, the thumbnail as its poster), and on the right the title, "Video ready", the
// "Video version N ▾" picker (F1), Download MP4, Publish → (F28: opens ④ Publish, only while the
// video is ready and up to date), Back to My videos and Edit storyboard. Below it, the Captions tab (F25, CaptionsPanel): fix
// caption text without changing the narration; clicking a phrase's time plays the latest version from
// there.
// F26: next to Captions, the "Ask for changes" tab (the F18 panel with `stage: video`): a change
// makes a new storyboard version; when it is ready the page opens the storyboard to approve it
// ("Approve & make new video"). While it runs the video still plays and downloads, the Captions tab
// waits, and the tab shows the progress. An unclear request stays here with the reply. The screen
// also shows the project's video after a change (`storyboardChanged`: "Back to video" from the
// storyboard), read-only: the new storyboard is approved there.
//
// The player's address is a 15-minute private link (F3 kind=video). When it has expired, the browser
// fails as soon as it needs more of the file (play after a long pause, seeking): the screen quietly
// gets a fresh link and goes on at the same second. If a link applied less than 10 s ago fails too, it
// shows a message instead (no endless loop). Both decisions live in lib/video/player-link.ts.
//
// Download MP4 asks F3 kind=download for the link (as JSON), then opens it: the browser saves the file
// and the page stays. A problem (logged out, gone, too many requests, a server error) shows as a plain
// line here, never as a raw error page. The href (redirect=true) stays for middle-click / new tab.

export type ReviewVideoScreenProps = {
  projectId: string;
  title: string;
  /** The project's current storyboard version (the note when a video was made from an older one). */
  currentPlanVersionId: string | null;
  /** The project's video (`currentRenderId`). */
  render: RenderSummaryResource;
  /** Its 15-minute private link, made by the page after the owner check (null → fetched here). */
  videoUrl: string | null;
  canEditStoryboard: boolean;
  /** F25: the project's stateVersion (sent with caption fixes). */
  stateVersion: number;
  /** F25: `edit_captions` is allowed (video_ready, no job running, not archived). */
  canEditCaptions: boolean;
  /** F25: the last caption fix on this video failed or was cancelled (with Try again when allowed). */
  lastCaptionJob: LastCaptionJob | null;
  /** F26: the "Ask for changes" tab (D5/D6 `stage: video`). */
  changes: VideoChanges;
  /** F26: the storyboard has changes this video doesn't have yet (they are approved on the storyboard). */
  storyboardChanged: boolean;
  /** F26: why caption fixes can't be made now (a change runs, or the storyboard changed). */
  captionsNote: string | null;
  /** F28: "Publish →" to ④ Publish (video_ready, not archived, the storyboard unchanged). */
  canPublish: boolean;
};

/** F26: what the "Ask for changes" tab needs (the props of ChangesPanel on the video page). */
export type VideoChanges = {
  baseVersionId: string;
  scenes: { id: string }[];
  /** Video-stage change requests, oldest first (D6 `stage=video`). */
  revisions: RevisionResource[];
  activeJob: JobResource | null;
  failedJob: { id: string; message: string } | null;
  canRequest: boolean;
  canRetry: boolean;
  requestsUsedUp: boolean;
  unavailableNote: string | null;
};

type Tab = "captions" | "changes";

const PLAY_PROBLEM = "We couldn't play this video. Please reload the page.";

export function ReviewVideoScreen(props: ReviewVideoScreenProps) {
  const [shown, setShown] = useState(props.render);
  const [src, setSrc] = useState<string | null>(props.videoUrl);
  const [problem, setProblem] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const resume = useRef<Resume | null>(null);
  /** When the current link was applied (0 = the page's own first link). */
  const lastApplied = useRef(0);
  const [requests] = useState(() => new LinkRequests());
  // A change that is running opens on its tab (its progress); otherwise Captions first.
  const changeRunning = props.changes.activeJob?.type === "revise";
  const [tab, setTab] = useState<Tab>(changeRunning ? "changes" : "captions");
  const [notice, setNotice] = useState("");

  async function loadLink(renderId: string, then: Resume) {
    const mine = requests.start();
    const answer = await apiSend<{ url: string }>("GET", `/api/v1/projects/${props.projectId}/renders/${renderId}/media?kind=video`);
    if (!requests.isLatest(mine)) return;
    if (!answer.ok) return setProblem(answer.message);
    resume.current = then;
    lastApplied.current = Date.now();
    setProblem(null);
    setSrc(answer.json.url);
  }

  useEffect(() => {
    // The page couldn't make the link (e.g. a short storage hiccup): try once from here.
    if (props.videoUrl === null) void loadLink(props.render.id, { time: 0, play: false });
  }, []);

  function choose(render: RenderSummaryResource) {
    if (render.id === shown.id) return;
    setShown(render);
    setSrc(null);
    setProblem(null);
    void loadLink(render.id, { time: 0, play: true });
  }

  /** Play the latest version from `seconds` (a caption's time); switches back to it when another version is shown. */
  function seekTo(seconds: number) {
    if (shown.id !== props.render.id) {
      setShown(props.render);
      setSrc(null);
      setProblem(null);
      void loadLink(props.render.id, { time: seconds, play: true });
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = seconds;
    void video.play().catch(() => undefined);
  }

  function onError() {
    const video = videoRef.current;
    if (!video || src === null) return;
    const next = afterPlayerError({ now: Date.now(), lastAppliedAt: lastApplied.current, currentTime: video.currentTime, paused: video.paused });
    if (next.action === "give_up") return setProblem(PLAY_PROBLEM);
    void loadLink(shown.id, next.resume);
  }

  function onLoadedMetadata() {
    const video = videoRef.current;
    const then = resume.current;
    resume.current = null;
    if (!video || !then) return;
    if (then.time > 0) video.currentTime = then.time;
    if (then.play) void video.play().catch(() => undefined);
  }

  async function download(event: MouseEvent<HTMLAnchorElement>) {
    // Middle-click, Ctrl/Cmd/Shift/Alt-click: the plain link (opened by the browser itself).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (downloading) return;
    setDownloading(true);
    setProblem(null);
    const answer = await apiSend<{ url: string }>("GET", `/api/v1/projects/${props.projectId}/renders/${shown.id}/media?kind=download`);
    setDownloading(false);
    if (!answer.ok) return setProblem(answer.message);
    // An attachment link: the browser saves the file and this page stays open.
    window.location.assign(answer.json.url);
  }

  const fromOlderStoryboard = props.currentPlanVersionId !== null && shown.planVersionId !== props.currentPlanVersionId;
  const downloadHref = `/api/v1/projects/${props.projectId}/renders/${shown.id}/media?kind=download&redirect=true`;

  return (
    <div className="mx-auto grid w-full max-w-4xl grid-cols-1 items-start gap-10 md:grid-cols-12 lg:gap-14">
      <div className="flex justify-center md:sticky md:top-8 md:col-span-5">
        <div className="relative aspect-[9/16] w-[240px] rounded-[28px] border border-line bg-surface-2 p-2.5 shadow-card sm:w-[280px]">
          <div className="relative size-full overflow-hidden rounded-[20px] border border-line bg-screen">
            <video
              // A new player for each version; a renewed link on the same version keeps it.
              key={shown.id}
              ref={videoRef}
              data-testid="video-player"
              controls
              playsInline
              preload="metadata"
              poster={shown.thumbnailUrl ?? undefined}
              src={src ?? undefined}
              onError={onError}
              onLoadedMetadata={onLoadedMetadata}
              aria-label={`Your video: ${props.title}`}
              className="absolute inset-0 size-full bg-black object-contain"
            />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-6 md:col-span-7">
      <section aria-labelledby="video-heading" className="rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-10">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h1 id="video-heading" className="font-display text-3xl font-bold tracking-tight break-words text-text sm:text-4xl">
            {props.title}
          </h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success-bg px-2.5 py-0.5 text-xs font-medium text-success">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" />
            Video ready
          </span>
        </div>
        <p className="mb-6 text-[15px] leading-relaxed text-muted">Watch it here, then download the MP4.</p>

        <div className="mb-6">
          <VideoVersionMenu projectId={props.projectId} shown={shown} onChoose={choose} />
        </div>

        {props.storyboardChanged ? (
          <Note tone="warning" className="mb-6">
            Your storyboard has changes that aren&apos;t in this video yet. Approve them on the storyboard to make a new video.
          </Note>
        ) : (
          fromOlderStoryboard && (
            <Note tone="warning" className="mb-6">
              Made from an older version of your storyboard.
            </Note>
          )
        )}
        {problem && (
          <p role="alert" className="mb-6 text-sm text-danger">
            {problem}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-4">
          {/* A plain link (not next/link): a click asks for the file's private link first; the href is for middle-click. */}
          <a
            href={downloadHref}
            onClick={(event) => void download(event)}
            aria-disabled={downloading || undefined}
            data-testid="download-mp4"
            className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2.5 rounded-full bg-button px-6 py-3 text-[15px] font-bold text-on-amber shadow-glow transition motion-safe:hover:-translate-y-0.5 aria-disabled:opacity-70"
          >
            <span aria-hidden="true">⬇</span>
            {downloading ? "Getting your file…" : "Download MP4"}
          </a>
          {props.canPublish && (
            <Button href={`/projects/${props.projectId}/publish`} variant="secondary" data-testid="publish-link">
              Publish →
            </Button>
          )}
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-5 border-t border-line pt-6">
          <Button href="/dashboard" variant="secondary">
            Back to My videos
          </Button>
          {props.canEditStoryboard && (
            <Link href={`/projects/${props.projectId}/storyboard`} className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-muted transition-colors hover:text-text">
              {props.storyboardChanged ? "Back to storyboard" : "Edit storyboard"}
            </Link>
          )}
        </div>
      </section>

      <section aria-label="Captions and changes" className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <p role="status" aria-live="polite" className="sr-only">
          {notice}
        </p>
        <div role="tablist" aria-label="Captions and changes" className="flex gap-6 border-b border-line bg-surface-2 px-6 pt-4">
          {(
            [
              ["captions", "Captions"],
              ["changes", "Ask for changes"],
            ] as const
          ).map(([name, label]) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`video-tab-${name}`}
              aria-selected={tab === name}
              aria-controls={`video-panel-${name}`}
              onClick={() => setTab(name)}
              className={cn(
                "-mb-px min-h-11 cursor-pointer border-b-2 pb-3 text-sm font-medium transition-colors",
                tab === name ? "border-amber text-text" : "border-transparent text-muted hover:text-text",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Both stay mounted (hidden when not shown): unsaved caption fixes and a running change's polling survive a tab switch. */}
        <div role="tabpanel" id="video-panel-captions" aria-labelledby="video-tab-captions" hidden={tab !== "captions"}>
          <CaptionsPanel
            projectId={props.projectId}
            renderId={props.render.id}
            renderNumber={props.render.renderNumber}
            stateVersion={props.stateVersion}
            canEdit={props.canEditCaptions}
            canEditStoryboard={props.canEditStoryboard}
            showingOtherVersion={shown.id !== props.render.id}
            lastJob={props.lastCaptionJob}
            onSeek={seekTo}
            waitNote={props.captionsNote}
          />
        </div>
        <div role="tabpanel" id="video-panel-changes" aria-labelledby="video-tab-changes" hidden={tab !== "changes"}>
          <ChangesPanel
            // A fresh panel after every change of the project (like the storyboard's), so it starts clean.
            key={props.stateVersion}
            stage="video"
            projectId={props.projectId}
            baseVersionId={props.changes.baseVersionId}
            stateVersion={props.stateVersion}
            scenes={props.changes.scenes}
            revisions={props.changes.revisions}
            activeJob={props.changes.activeJob}
            failedJob={props.changes.failedJob}
            canRequest={props.changes.canRequest}
            canRetry={props.changes.canRetry}
            requestsUsedUp={props.changes.requestsUsedUp}
            unavailableNote={props.changes.unavailableNote}
            disabled={false}
            announce={setNotice}
          />
        </div>
      </section>
      </div>
    </div>
  );
}
