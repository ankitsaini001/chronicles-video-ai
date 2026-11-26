import {
  findProjectRender,
  findUnconfirmedPostOfOwner,
  getDb,
  getInstagramConnection,
  getJob,
  isCheckablePost,
  isUnconfirmedPost,
  postRetryMode,
  readDbConfig,
  toJobResource,
  type ProjectDocument,
  type RenderDocument,
} from "@bytereel/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ProjectStepper } from "@/components/app/ProjectStepper";
import { InstagramCard, type CardConnection } from "@/components/publish/InstagramCard";
import { PublishedScreen } from "@/components/publish/PublishedScreen";
import { PublishForm } from "@/components/publish/PublishForm";
import { PublishStatusScreen } from "@/components/publish/PublishStatusScreen";
import { Button, PlainLinkButton } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { instagramNotice } from "@/lib/instagram/messages";
import { loadProjectWithJobs } from "@/lib/plan/jobs";
import { storyboardChangedSince } from "@/lib/video/review-state";
import { thumbnailLink } from "@/lib/video/storage";

// ④ Publish (F28–F30; Stitch "ByteReel — Step 4 Publish" and "ByteReel — Published"). One address for
// the whole publish step; what it shows follows the project (the server owns state):
// - `video_ready`: the video on the left (thumbnail, version, Download MP4), on the right the
//   Instagram card (connect, or "Publishing to @username" + Disconnect) and, while connected, the
//   publish form (F30): CAPTION (F29), WHEN (Publish now; Schedule "coming soon"), the approval tick,
//   and Publish now ↗ in the bar at the bottom.
// - `publishing`: the progress view (Sending your video to Instagram → Instagram is processing it →
//   Publishing; "Checking whether your post went live…" after a lost answer), polling C6.
// - `publish_failed`: the plain reason with Try again (H6); when the approval was cancelled by a change
//   (or can't be used any more) the publish form again, with a note to approve again (a new H2).
// - A publish that may be live but can't be tried again (code review MUST 1): only "Check again" (H6
//   in its reconcile-only mode), whatever the project's step; no new approval until it is settled.
// - `published`: "Your reel is live!" with View on Instagram ↗.
// Only the owner sees it (another user's project, a missing one, a bad id → the same 404 page). An
// archived project, a video that isn't ready, or one made from an older storyboard go back to
// /projects/[id]. The way back from Instagram adds ?instagram=connected or ?instagram_error=….

export const metadata: Metadata = { title: "Publish" };

const AGAIN_NOTE = "Something changed after you approved this post, so it wasn't posted. Check it and approve it again.";
const CHECK_NOTE = "We couldn't confirm whether your last post went live. Check again looks at Instagram first; your reel is never posted twice.";

export default async function PublishPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const user = await requireUser();
  const { id } = await params;
  const settings = readDbConfig(process.env);
  if (!settings.ok) throw new Error(settings.problems.join(" "));
  const db = getDb(settings.config);
  const loaded = await loadProjectWithJobs(db, user.id, id);
  if (!loaded) notFound();
  const { project, latestPost } = loaded;
  const projectId = project._id.toHexString();
  if (project.state === "archived" || project.currentRenderId === null) redirect(`/projects/${projectId}`);
  const render = await findProjectRender(db, project, "current");
  if (!render || render.status !== "ready") redirect(`/projects/${projectId}`);
  const thumbnailUrl = await thumbnailLink(render.thumbnailKey).catch(() => null);

  const frame = (screen: ReactNode, links: boolean) => (
    <div className="mx-auto flex w-full flex-col">
      <div className="relative mb-8 flex flex-col items-center gap-4 sm:mb-12 sm:flex-row sm:justify-center">
        <Link href="/dashboard" className="self-start text-xs font-medium text-muted transition-colors hover:text-text sm:absolute sm:left-0 sm:self-center">
          ← My videos
        </Link>
        <ProjectStepper current="publish" hrefs={links ? { storyboard: `/projects/${projectId}/storyboard`, video: `/projects/${projectId}/video` } : {}} />
      </div>
      {screen}
    </div>
  );

  if (project.state === "published" && latestPost?.state === "published") {
    return frame(
      <PublishedScreen
        title={project.title}
        username={latestPost.destination.username}
        publishedAt={latestPost.publishedAt ?? latestPost.updatedAt}
        timeZone={user.timezone}
        permalink={latestPost.permalink}
        thumbnailUrl={thumbnailUrl}
      />,
      false,
    );
  }

  if (project.state === "publishing" && latestPost) {
    return frame(
      <PublishStatusScreen
        projectId={projectId}
        postId={latestPost._id.toHexString()}
        title={project.title}
        thumbnailUrl={thumbnailUrl}
        username={latestPost.destination.username}
        mode="publishing"
        job={loaded.activeJob ? toJobResource(loaded.activeJob) : null}
        failure={null}
      />,
      false,
    );
  }

  // F30 code review MUST 1: a publish that may be live and can't simply be tried again (its approval
  // was cancelled by a change, or no longer matches) → only "Check again" (H6 reads Instagram; it
  // never posts). Approving again is blocked until the check confirms it or proves it wasn't posted.
  // The SAME rule as H6 (postRetryMode), so the button always matches what the server will do.
  if (latestPost && isCheckablePost(latestPost) && (await postRetryMode(db, latestPost)) === "check") {
    return frame(
      <PublishStatusScreen
        projectId={projectId}
        postId={latestPost._id.toHexString()}
        title={project.title}
        thumbnailUrl={thumbnailUrl}
        username={latestPost.destination.username}
        mode="check"
        job={null}
        failure={{ message: CHECK_NOTE, retryable: true }}
      />,
      true,
    );
  }

  const query = await searchParams;
  const form = (again: string | null) => publishForm({ db, user, project, render, thumbnailUrl, again, query });

  if (project.state === "publish_failed" && latestPost?.state === "publish_failed") {
    const failure = latestPost.lastError ?? { code: "INTERNAL", message: "Something went wrong on our side. Please try again." };
    const mustApprove = failure.code === "APPROVAL_STALE";
    const job = latestPost.jobId ? await getJob(db, latestPost.jobId) : null;
    return frame(
      <PublishStatusScreen
        projectId={projectId}
        postId={latestPost._id.toHexString()}
        title={project.title}
        thumbnailUrl={thumbnailUrl}
        username={latestPost.destination.username}
        mode="failed"
        job={job && job.ownerId.equals(project.ownerId) ? toJobResource(job) : null}
        failure={{ message: failure.message, retryable: !mustApprove }}
        showFormFirst={mustApprove}
      >
        {/* A publish that may have gone out is only ever tried again (it checks Instagram first); never a new approval. */}
        {!isUnconfirmedPost(latestPost) ? await form(mustApprove ? failure.message : null) : null}
      </PublishStatusScreen>,
      true,
    );
  }

  const invalidated = latestPost?.state === "approval_invalidated";
  if (project.state === "video_ready" || ((project.state === "publish_failed" || project.state === "scheduled") && (invalidated || !latestPost))) {
    if (storyboardChangedSince({ state: project.state === "scheduled" ? "publish_failed" : project.state, currentPlanVersionId: project.currentPlanVersionId, renderPlanVersionId: render.planVersionId })) redirect(`/projects/${projectId}`);
    return frame(await form(project.state === "video_ready" ? null : AGAIN_NOTE), true);
  }

  // A publish-step state this page has no view for yet (a scheduled post comes with F31): a plain note.
  // (Never back to /projects/[id], which sends the publish step here.)
  if (project.state === "scheduled" || project.state === "published" || project.state === "publishing" || project.state === "publish_failed") {
    return frame(
      <section className="mx-auto w-full max-w-xl rounded-2xl border border-line bg-surface p-6 text-center shadow-card sm:p-10">
        <h1 className="mb-3 font-display text-2xl font-bold tracking-tight text-text">{project.title}</h1>
        <p className="mb-8 text-[15px] leading-relaxed text-muted">This post is on its way. Please check back in a few minutes.</p>
        <Button href="/dashboard" variant="secondary">
          Back to My videos
        </Button>
      </section>,
      false,
    );
  }
  redirect(`/projects/${projectId}`);
}

/** The publish step's form view: the video on the left, the Instagram card and the publish form on the right. */
async function publishForm(input: {
  db: ReturnType<typeof getDb>;
  user: { id: string };
  project: ProjectDocument;
  render: RenderDocument;
  thumbnailUrl: string | null;
  again: string | null;
  query: { [key: string]: string | string[] | undefined };
}) {
  const { project, render } = input;
  const projectId = project._id.toHexString();
  const connectionDoc = await getInstagramConnection(input.db, input.user.id);
  // Re-review founder note: an unconfirmed post (any project) → a plain warning before connecting.
  const unconfirmed = await findUnconfirmedPostOfOwner(input.db, input.user.id);
  const connection: CardConnection | null =
    connectionDoc && connectionDoc.status !== "revoked" ? { username: connectionDoc.username, profilePictureUrl: connectionDoc.profilePictureUrl, status: connectionDoc.status } : null;
  const notice = instagramNotice(input.query);
  const seconds = render.metrics?.durationMs ? Math.round(render.metrics.durationMs / 1000) : null;
  return (
    <div className="mx-auto w-full max-w-5xl pb-28">
      <div className="mb-8 flex flex-wrap items-center gap-3.5">
        <h1 className="font-display text-2xl font-bold tracking-tight break-words text-text sm:text-3xl">{project.title}</h1>
        {input.again ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/25 bg-warning-bg px-3 py-1 text-xs font-medium text-warning">Needs your approval</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-success/20 bg-success-bg px-3 py-1 text-xs font-medium text-success">
            <span aria-hidden="true" className="size-2 rounded-full bg-success shadow-[0_0_6px_#4ade80]" />
            Ready to publish
          </span>
        )}
      </div>
      <div className="grid w-full grid-cols-1 items-start gap-10 lg:grid-cols-12">
        <div className="flex flex-col items-center lg:col-span-4">
          <div className="relative aspect-[9/16] w-[200px] overflow-hidden rounded-[20px] border border-line bg-screen shadow-card sm:w-[240px]">
            {input.thumbnailUrl ? (
              // A short-lived private link (15 min): a plain <img>, nothing for Next.js to optimise.
              <img src={input.thumbnailUrl} alt={`Your video: ${project.title}`} className="absolute inset-0 size-full object-cover" />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted">{project.title}</span>
            )}
          </div>
          <p className="mt-4 font-mono text-xs tracking-wide text-muted">
            Video version {render.renderNumber}
            {seconds !== null && ` · ${seconds} s`}
          </p>
          <PlainLinkButton href={`/api/v1/projects/${projectId}/renders/${render._id.toHexString()}/media?kind=download&redirect=true`} variant="secondary" arrow={false} className="mt-3">
            <span aria-hidden="true">⬇</span> Download MP4
          </PlainLinkButton>
        </div>

        <div className="flex justify-center lg:col-span-8">
          <InstagramCard projectId={projectId} connection={connection} notice={notice} unconfirmedOn={unconfirmed?.destination.username ?? null}>
            {/* Rendered by the card only while Instagram is connected (F29 decision 5). */}
            {connectionDoc && (
              <PublishForm
                // A new video or another account mounts a NEW form: the approval tick can never carry over.
                key={`${render._id.toHexString()}:${render.mp4Sha256}:${connectionDoc._id.toHexString()}`}
                projectId={projectId}
                renderId={render._id.toHexString()}
                mp4Sha256={render.mp4Sha256}
                connectionId={connectionDoc._id.toHexString()}
                username={connectionDoc.username}
                videoVersion={render.renderNumber}
                stateVersion={project.stateVersion}
                initialDraft={project.captionDraft ? { text: project.captionDraft.text, source: project.captionDraft.source } : null}
                again={input.again}
              />
            )}
          </InstagramCard>
        </div>
      </div>
    </div>
  );
}
