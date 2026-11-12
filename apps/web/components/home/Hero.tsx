import { Button, cn, Icon, type IconName } from "@/components/ui";

// Hero (Stitch "ByteReel — Home Landing Page", docs/design/stitch/home-landing-v1.html): chip,
// tagline, headline, sub-copy, 3 feature points, primary CTA, and a phone showing a ByteReel
// explainer surrounded by 6 floating glossy tiles.

const POINTS = ["Storyboard in about 30 seconds", "Motion graphics timed to the voice", "Download or post to Instagram"];

// Positions are relative to the 280px phone; tiles overlap only its frame and empty top/bottom.
// Below `sm` there is no room beside the phone, so the tiles that would cover its text are hidden.
const TILES = [
  { label: "Explainer", className: "-top-4 -left-4 sm:-left-10 -rotate-8", delay: "0s" },
  { label: "AI ✨", className: "hidden sm:block top-10 -right-4 sm:-right-10 rotate-6", delay: "-1.2s" },
  { label: "हिंदी", lang: "hi", className: "top-1/3 -left-6 sm:-left-14 -rotate-5", delay: "-2.5s" },
  { label: "Reels ⚡", className: "hidden sm:block top-1/2 -right-6 sm:-right-12 rotate-9", delay: "-3.8s" },
  { label: "Voice 🎙️", className: "hidden sm:block bottom-12 -left-4 sm:-left-10 -rotate-12", delay: "-4.3s" },
  { label: "60s ⏱️", className: "-bottom-3 -right-2 sm:-right-8 rotate-7", delay: "-0.7s" },
] as const;

const STAGES: { icon: IconName; label: string; text: string; active?: boolean; dim?: boolean }[] = [
  { icon: "sun", label: "Stage 1", text: "1. Sunlight heats surface water" },
  { icon: "wind", label: "Stage 2 • Active", text: "2. Vapour rises into the air", active: true },
  { icon: "cloud", label: "Stage 3", text: "3. Clouds form & condense", dim: true },
];

const WAVE = ["h-2 bg-amber/40", "h-3.5 bg-amber/70", "h-5 bg-amber", "h-4 bg-amber", "h-2.5 bg-amber/70", "h-[18px] bg-amber", "h-3 bg-amber/60", "h-1.5 bg-amber/40"];

function PhoneMockup() {
  return (
    <div
      role="img"
      aria-label="Example reel: The Water Cycle"
      className="relative z-10 flex h-[560px] w-[280px] flex-col rounded-[28px] border border-line bg-surface-2 p-2.5 shadow-[0_25px_60px_#000000d9]"
    >
      <div aria-hidden="true" className="contents">
        {/* Notch */}
        <div className="absolute top-4 left-1/2 z-20 flex h-4 w-20 -translate-x-1/2 items-center justify-center gap-1.5 rounded-full bg-surface">
          <span className="size-2.5 rounded-full border border-amber/20 bg-bg" />
          <span className="h-1 w-7 rounded-full bg-bg" />
        </div>
        <div className="flex h-full flex-col overflow-hidden rounded-[20px] border border-white/5 bg-screen px-4 pt-9 pb-4">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-amber">Science 101</p>
              <p className="font-display text-lg font-bold leading-tight">The Water Cycle</p>
            </div>
            <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted">0:42 / 1:04</span>
          </div>
          <ul className="my-auto flex flex-col gap-3 py-2">
            {STAGES.map((s) => (
              <li
                key={s.label}
                className={cn(
                  "relative flex items-center gap-3 rounded-xl border p-2.5",
                  s.active ? "border-amber/40 bg-surface-2 shadow-[0_0_15px_#f5a52426]" : "border-line bg-surface",
                  s.dim && "opacity-60",
                )}
              >
                <span
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg",
                    s.active ? "bg-amber text-on-amber" : s.dim ? "bg-surface-2 text-muted" : "bg-amber/15 text-amber",
                  )}
                >
                  <Icon name={s.icon} className="size-4" />
                </span>
                <span>
                  <span className={cn("block font-mono text-[10px] uppercase", s.active ? "font-bold text-amber" : "text-muted")}>
                    {s.label}
                  </span>
                  <span className={cn("block text-xs", s.active ? "font-bold" : "font-medium")}>{s.text}</span>
                </span>
                {s.active && <span className="absolute top-3 right-2.5 size-2 rounded-full bg-amber motion-safe:animate-ping" />}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2 border-t border-line pt-2">
            <div className="flex h-5 items-center justify-center gap-1">
              {WAVE.map((w, i) => (
                <span key={i} className={cn("w-1 rounded-full", w)} />
              ))}
            </div>
            <p className="rounded-lg border border-line bg-surface-2/90 px-2 py-1.5 text-center text-[11px] leading-tight text-gold-cream">
              “...and that <span className="rounded bg-amber px-1 font-bold text-on-amber">water vapour</span> slowly cools down
              to form droplets.”
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="bg-atmosphere overflow-hidden">
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 py-12 sm:px-6 md:py-20 lg:grid-cols-12 lg:gap-8">
        <div className="flex flex-col items-start gap-6 lg:col-span-7">
          <span className="inline-flex items-center gap-2 rounded-full border border-amber/20 bg-surface-2 px-3.5 py-1.5 font-mono text-xs text-amber-light">
            <span aria-hidden="true" className="text-sm">
              🎬
            </span>
            Idea in. Reel out.
          </span>
          <p className="font-display text-[19px] font-bold tracking-tight text-muted">
            Explain<span className="font-extrabold text-amber">.</span> Animate<span className="font-extrabold text-amber">.</span>{" "}
            Post<span className="font-extrabold text-amber">.</span>
          </p>
          <h1 className="text-[40px] leading-[1.05] font-extrabold tracking-tight sm:text-5xl lg:text-[56px] xl:text-[60px]">
            Turn any topic into a <span className="text-gradient-gold min-[360px]:whitespace-nowrap">ready-to-post Reel</span>
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            Type an idea or paste your notes. ByteReel writes the script, animates every concept and adds a natural voice in
            English, Hindi or Hinglish.
          </p>
          <ul className="flex w-full max-w-lg flex-col gap-3.5 pt-2">
            {POINTS.map((point, i) => (
              <li key={point} className="flex items-center gap-4 font-medium">
                <span className="flex size-7 shrink-0 items-center justify-center rounded border border-line bg-surface-2 font-mono text-xs font-bold text-amber shadow-inner">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {point}
              </li>
            ))}
          </ul>
          <div className="flex w-full flex-col items-start gap-4 pt-4 sm:flex-row sm:items-center">
            <Button href="/signup">Create your first reel</Button>
            <p className="font-mono text-xs text-muted/70">No credit card · Free in beta</p>
          </div>
        </div>

        <div className="relative flex items-center justify-center py-10 lg:col-span-5">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute size-[440px] max-w-full rounded-full bg-[radial-gradient(circle,#f5a52459_0%,transparent_68%)] blur-[28px]"
          />
          <div className="relative">
            <PhoneMockup />
            {TILES.map((tile) => (
              <span
                key={tile.label}
                aria-hidden="true"
                lang={"lang" in tile ? tile.lang : undefined}
                style={{ animationDelay: tile.delay }}
                className={cn(
                  "absolute z-20 rounded-2xl border border-amber/30 bg-tile px-4 py-2 font-display text-[15px] font-bold whitespace-nowrap shadow-tile backdrop-blur-sm motion-safe:animate-float",
                  tile.className,
                )}
              >
                <span className="text-gradient-tile">{tile.label}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
