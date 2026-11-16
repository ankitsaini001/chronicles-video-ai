"use client";

import type { RenderSummaryResource } from "@bytereel/db";
import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { apiSend } from "@/components/storyboard/client";
import { Note } from "@/components/storyboard/Note";
import { Button } from "@/components/ui";
import { afterPlayerError, LinkRequests, type Resume } from "@/lib/video/player-link";
import { CaptionsPanel, type LastCaptionJob } from "./CaptionsPanel";
import { VideoVersionMenu } from "./VideoVersionMenu";

// ③ Video when it is ready (F24; Stitch "ByteReel — Step 3 Review video"): the real MP4 in the phone
// frame (HTML5 player, the thumbnail as its poster), and on the right the title, "Video ready", the
// "Video version N ▾" picker (F1), Download MP4, Back to My videos and Edit storyboard. Publishing
// comes later (F28+), so it shows "coming soon". Below it, the Captions tab (F25, CaptionsPanel): fix
// caption text without changing the narration; clicking a phrase's time plays the latest version from
// there. "Ask for changes" is F26.
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
};

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

        {fromOlderStoryboard && (
          <Note tone="warning" className="mb-6">
            Made from an older version of your storyboard.
          </Note>
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
          <Button type="button" variant="secondary" disabled>
            Publish — coming soon
          </Button>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-5 border-t border-line pt-6">
          <Button href="/dashboard" variant="secondary">
            Back to My videos
          </Button>
          {props.canEditStoryboard && (
            <Link href={`/projects/${props.projectId}/storyboard`} className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-muted transition-colors hover:text-text">
              Edit storyboard
            </Link>
          )}
        </div>
      </section>

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
      />
      </div>
    </div>
  );
}
