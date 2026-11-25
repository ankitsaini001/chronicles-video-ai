import { Button, cn } from "@/components/ui";
import { postedAtLabel, viewOnInstagramHref } from "@/lib/publish/labels";

// ④ Published (F30; Stitch "ByteReel — Published"): the video's thumbnail with a green tick, the
// "Published" badge, "Your reel is live!", "<title> was posted to @username on 12 Nov 2026, 7:02 pm."
// (the creator's timezone), View on Instagram ↗ (the post's link; the profile if Instagram gave none),
// Create another video and Back to My videos. No buttons change anything here.

export function PublishedScreen(props: { title: string; username: string; publishedAt: Date; timeZone: string; permalink: string | null; thumbnailUrl: string | null }) {
  return (
    <div className="relative mx-auto flex w-full max-w-[560px] flex-col items-center">
      <div aria-hidden="true" className="pointer-events-none absolute top-1/2 left-1/2 -z-10 size-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(245,165,36,0.13)_0%,rgba(245,165,36,0.04)_45%,transparent_70%)]" />
      <section aria-labelledby="published-heading" data-testid="published" className="flex w-full flex-col items-center rounded-2xl border border-line bg-surface p-6 text-center shadow-card sm:p-10">
        <div className="relative mb-6 aspect-[9/16] w-[110px] rounded-xl border border-line bg-screen shadow-inner">
          {props.thumbnailUrl ? (
            // A short-lived private link (15 min): a plain <img>.
            <img src={props.thumbnailUrl} alt={`Your video: ${props.title}`} className="absolute inset-0 size-full rounded-xl object-cover" />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] text-muted">{props.title}</span>
          )}
          <span aria-hidden="true" className="absolute -top-2.5 -right-2.5 flex size-7 items-center justify-center rounded-full border border-success bg-success-bg text-success shadow-[0_2px_8px_rgba(74,222,128,0.25)]">
            <svg viewBox="0 0 20 20" fill="currentColor" className="size-4">
              <path fillRule="evenodd" clipRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" />
            </svg>
          </span>
        </div>
        <p className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success-bg px-3 py-1 text-xs font-medium text-success">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success motion-safe:animate-pulse" />
          Published
        </p>
        <h1 id="published-heading" className="mb-3 font-display text-2xl font-extrabold tracking-tight text-text sm:text-3xl">
          Your reel is live!
        </h1>
        <p data-testid="published-line" className="mb-8 max-w-[430px] text-[15px] leading-relaxed break-words text-muted">
          {props.title} was posted to @{props.username} on {postedAtLabel(props.publishedAt, props.timeZone)}.
        </p>
        <div className="flex w-full flex-col items-center gap-3.5">
          <a
            href={viewOnInstagramHref(props.permalink, props.username)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="view-on-instagram"
            className={cn("inline-flex min-h-11 w-full items-center justify-center gap-3 rounded-full bg-button py-[9px] pr-[9px] pl-[26px] text-[15px] font-bold text-on-amber shadow-glow transition motion-safe:hover:-translate-y-0.5")}
          >
            <span className="flex-1 pl-10 text-center">View on Instagram</span>
            <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-black/15 text-lg">
              ↗
            </span>
          </a>
          <Button href="/projects/new" variant="secondary" fullWidth>
            Create another video
          </Button>
          <Button href="/dashboard" variant="secondary" arrow={false} className="mt-1 border-0 text-sm font-medium text-muted hover:bg-transparent hover:text-text">
            Back to My videos
          </Button>
        </div>
      </section>
    </div>
  );
}
