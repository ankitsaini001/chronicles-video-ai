import { Button, Icon, type IconName } from "@/components/ui";
import type { Me, Usage } from "@/lib/account/me";

// The first-visit My videos page (F21, founder's request from F11: the empty page felt too empty).
// Shown while the creator has no projects in My videos. One primary button ("Create your first
// video"), a "How it works" strip and three small cards from B1 (getMe): today's limits, this
// month's voice characters and the Instagram status. No sidebar (phones need the width).

const STEPS: readonly { icon: IconName; title: string; text: string }[] = [
  { icon: "bulb", title: "Idea", text: "Type a topic or paste your notes." },
  { icon: "storyboard", title: "Storyboard", text: "Check the scenes and the words." },
  { icon: "video", title: "Video", text: "We add the voice, visuals and captions." },
  { icon: "send", title: "Post", text: "Approve it, then post to Instagram." },
];

const number = (n: number) => n.toLocaleString("en-IN");
const usageText = (u: Usage) => `${number(u.used)} of ${number(u.limit)}`;

const INSTAGRAM_STATUS: Record<Me["instagram"]["status"], string> = {
  not_connected: "Not connected",
  active: "Connected",
  expired: "Needs reconnecting",
  revoked: "Needs reconnecting",
  error: "Needs attention",
};

export function FirstVisit({ me }: { me: Me }) {
  return (
    <>
      <h1 className="mb-6 font-display text-3xl font-extrabold tracking-tight text-text sm:mb-8 sm:text-4xl">My videos</h1>

      <section aria-labelledby="first-video-title" className="mb-6 rounded-2xl border border-line bg-surface p-5 shadow-card sm:mb-8 sm:p-10">
        <h2 id="first-video-title" className="mb-2 font-display text-2xl font-bold text-text">
          Make your first video
        </h2>
        <p className="mb-8 max-w-xl text-base leading-relaxed text-muted">Turn any topic into a ready-to-post Reel in a few minutes. Here is how it works:</p>

        <ol aria-label="How it works" className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-4">
              <span className="flex items-center gap-2">
                <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-full bg-progress-bg text-amber">
                  <Icon name={step.icon} className="size-5" />
                </span>
                <span className="font-mono text-[11px] tracking-wider text-muted uppercase">Step {i + 1}</span>
              </span>
              <span className="font-display text-base font-bold text-text">{step.title}</span>
              <span className="text-sm leading-snug text-muted">{step.text}</span>
            </li>
          ))}
        </ol>

        <Button href="/projects/new">Create your first video</Button>
      </section>

      <section aria-labelledby="limits-title">
        <h2 id="limits-title" className="mb-3 font-mono text-xs tracking-wider text-muted uppercase">
          Your free limits
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
          <li className="rounded-2xl border border-line bg-surface p-5">
            <h3 className="mb-3 font-display text-base font-bold text-text">Today</h3>
            <dl className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Videos</dt>
                <dd className="text-text">{usageText(me.usage.videosToday)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Projects</dt>
                <dd className="text-text">{usageText(me.usage.projectsToday)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted">Resets at midnight.</p>
          </li>
          <li className="rounded-2xl border border-line bg-surface p-5">
            <h3 className="mb-3 font-display text-base font-bold text-text">This month</h3>
            <dl className="text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Voice characters</dt>
                <dd className="text-text">{usageText(me.usage.voiceCharactersThisMonth)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted">Resets on the 1st.</p>
          </li>
          <li className="rounded-2xl border border-line bg-surface p-5">
            <h3 className="mb-3 font-display text-base font-bold text-text">Instagram</h3>
            <p className="text-sm text-text">
              {INSTAGRAM_STATUS[me.instagram.status]}
              {me.instagram.status === "active" && me.instagram.username ? ` as @${me.instagram.username}` : ""}
            </p>
            <p className="mt-3 text-xs text-muted">{me.instagram.status === "not_connected" ? "You connect it at step 4, when your first video is ready." : "Manage it in Settings."}</p>
          </li>
        </ul>
      </section>
    </>
  );
}
