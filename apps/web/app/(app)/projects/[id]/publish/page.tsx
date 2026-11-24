import { findProjectRender, getDb, getInstagramConnection, getOwnedProject, readDbConfig } from "@bytereel/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ProjectStepper } from "@/components/app/ProjectStepper";
import { CaptionBox } from "@/components/publish/CaptionBox";
import { InstagramCard, type CardConnection } from "@/components/publish/InstagramCard";
import { PlainLinkButton } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { instagramNotice } from "@/lib/instagram/messages";
import { storyboardChangedSince } from "@/lib/video/review-state";
import { thumbnailLink } from "@/lib/video/storage";

// ④ Publish (F28; Stitch "ByteReel — Step 4 Connect Instagram", decision 1). Opens from the video's
// "Publish →" when the video is ready. Left: the video's thumbnail, its version and Download MP4.
// Right: the Instagram card (components/publish/InstagramCard.tsx): connect, or "Publishing to
// @username" + Disconnect, and (F29) the CAPTION box with the saved caption (`captionDraft`, read
// here so reopening never asks the AI again). Publish now / Schedule come with F30–F31.
// Only the owner sees it (another user's project, a missing one, a bad id → the same 404 page). A
// project whose video isn't ready, is archived, or was made from an older storyboard (the same
// storyboardChangedSince rule as the video page's "Publish →") goes back to /projects/[id].
// The way back from Instagram adds ?instagram=connected or ?instagram_error=…, shown as one line.

export const metadata: Metadata = { title: "Publish" };

export default async function PublishPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const user = await requireUser();
  const { id } = await params;
  const settings = readDbConfig(process.env);
  if (!settings.ok) throw new Error(settings.problems.join(" "));
  const db = getDb(settings.config);
  const project = await getOwnedProject(db, user.id, id);
  if (!project) notFound();
  const projectId = project._id.toHexString();
  if (project.state !== "video_ready" || project.currentRenderId === null) redirect(`/projects/${projectId}`);
  const render = await findProjectRender(db, project, "current");
  if (!render || render.status !== "ready") redirect(`/projects/${projectId}`);
  if (storyboardChangedSince({ state: project.state, currentPlanVersionId: project.currentPlanVersionId, renderPlanVersionId: render.planVersionId })) redirect(`/projects/${projectId}`);

  const [thumbnailUrl, connectionDoc] = await Promise.all([thumbnailLink(render.thumbnailKey).catch(() => null), getInstagramConnection(db, user.id)]);
  const connection: CardConnection | null =
    connectionDoc && connectionDoc.status !== "revoked" ? { username: connectionDoc.username, profilePictureUrl: connectionDoc.profilePictureUrl, status: connectionDoc.status } : null;
  const notice = instagramNotice(await searchParams);
  const seconds = render.metrics?.durationMs ? Math.round(render.metrics.durationMs / 1000) : null;

  return (
    <div className="mx-auto flex w-full flex-col">
      <div className="relative mb-8 flex flex-col items-center gap-4 sm:mb-12 sm:flex-row sm:justify-center">
        <Link href="/dashboard" className="self-start text-xs font-medium text-muted transition-colors hover:text-text sm:absolute sm:left-0 sm:self-center">
          ← My videos
        </Link>
        <ProjectStepper current="publish" hrefs={{ storyboard: `/projects/${projectId}/storyboard`, video: `/projects/${projectId}/video` }} />
      </div>

      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 items-center gap-10 lg:grid-cols-12">
        <div className="flex flex-col items-center lg:col-span-4">
          <div className="relative aspect-[9/16] w-[200px] overflow-hidden rounded-[20px] border border-line bg-screen shadow-card sm:w-[240px]">
            {thumbnailUrl ? (
              // A short-lived private link (15 min): a plain <img>, nothing for Next.js to optimise.
              <img src={thumbnailUrl} alt={`Your video: ${project.title}`} className="absolute inset-0 size-full object-cover" />
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
          <InstagramCard projectId={projectId} connection={connection} notice={notice}>
            {/* Rendered by the card only while Instagram is connected (F29 decision 5). */}
            <CaptionBox
              projectId={projectId}
              renderId={render._id.toHexString()}
              initialDraft={project.captionDraft ? { text: project.captionDraft.text, source: project.captionDraft.source } : null}
            />
          </InstagramCard>
        </div>
      </div>
    </div>
  );
}
