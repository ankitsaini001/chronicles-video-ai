import { Button, cn } from "@/components/ui";

// Hero (Stitch "ByteReel — Home v2"; BRAND §7–8): chip, tagline, headline, sub-copy, 3 feature
// points, primary CTA, and a phone showing a ByteReel explainer with floating glossy tiles.

const POINTS = ["Storyboard in about 30 seconds", "Motion graphics timed to the voice", "Download or post to Instagram"];

// Floating glossy tiles around the phone. Positions are relative to the phone column.
// Positions are relative to the phone + its side gutters (see the wrapper in Hero), so tiles sit
// beside the phone and only touch its frame, never the screen content.
const TILES = [
  { label: "Explainer", className: "left-2 -top-3 -rotate-12", delay: "0s" },
  { label: "AI", className: "right-0 top-[6%] rotate-6 text-xs", delay: "-1.5s" },
  { label: "हिंदी", lang: "hi", className: "left-0 top-[30%] -rotate-6", delay: "-3s" },
  { label: "Reels", className: "-right-2 top-[36%] rotate-3", delay: "-4.5s" },
  { label: "Voice", className: "left-2 bottom-[10%] rotate-3", delay: "-2s" },
  { label: "60s", className: "right-0 bottom-[12%] rotate-9 text-xs", delay: "-5s" },
] as const;

const PHONE_STEPS = [
  { text: "Sunlight heats surface water", active: false },
  { text: "Vapour rises into the air", active: true },
  { text: "Clouds form", active: false },
];

function PhoneMockup() {
  return (
    <div
      role="img"
      aria-label="Example reel: The Water Cycle"
      className="relative mx-auto aspect-[9/18] w-[min(100%,300px)] rounded-[36px] border border-amber/40 bg-surface-2 p-3 shadow-card"
    >
      <div aria-hidden="true" className="flex h-full flex-col rounded-[28px] border border-amber/25 bg-screen p-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-amber">Science</p>
        <p className="mt-1 font-display text-lg font-bold">The Water Cycle</p>
        <ul className="mt-4 flex flex-col gap-2.5">
          {PHONE_STEPS.map((step) => (
            <li
              key={step.text}
              className={cn(
                "flex items-center justify-between rounded-xl border px-3 py-2.5 text-xs",
                step.active ? "border-amber bg-progress-bg text-amber-light" : "border-line text-muted",
              )}
            >
              {step.text}
              {step.active && <span aria-hidden="true" className="size-2 rounded-full bg-amber shadow-[0_0_8px_#f5a524]" />}
            </li>
          ))}
        </ul>
        <p className="mt-auto rounded-xl border border-line px-3 py-3 text-center text-xs italic text-text/90">
          “Heat turns water into vapour.”
        </p>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="bg-atmosphere overflow-hidden border-b border-line">
      <div className="mx-auto grid max-w-[1240px] items-center gap-14 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3.5 py-1.5 text-xs font-medium text-amber-light">
            <span aria-hidden="true">🎬</span> Idea in. Reel out.
          </span>
          <p className="mt-8 font-display text-[19px] font-bold text-muted">
            Explain<span className="text-amber">.</span> Animate<span className="text-amber">.</span> Post
            <span className="text-amber">.</span>
          </p>
          <h1 className="mt-3 text-4xl leading-[1.05] font-extrabold sm:text-5xl lg:text-[56px] xl:text-[60px]">
            Turn any topic into a{" "}
            <span className="text-gradient-gold min-[360px]:whitespace-nowrap">ready-to-post Reel</span>
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            Type an idea or paste your notes. ByteReel writes the script, animates every concept and adds a natural voice in
            English, Hindi or Hinglish.
          </p>
          <ul className="mt-8 flex flex-col gap-3">
            {POINTS.map((point, i) => (
              <li key={point} className="flex items-center gap-4 text-[15px]">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 font-mono text-xs text-amber">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {point}
              </li>
            ))}
          </ul>
          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Button href="/signup">Create your first reel</Button>
            <p className="text-[13px] text-muted">Free during the private beta</p>
          </div>
        </div>

        <div className="relative py-4">
          <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle,#f5a52440,transparent_65%)]" />
          <div className="relative mx-auto w-full max-w-[300px] sm:max-w-[440px] sm:px-[70px]">
            <PhoneMockup />
            {TILES.map((tile) => (
              <span
                key={tile.label}
                aria-hidden="true"
                lang={"lang" in tile ? tile.lang : undefined}
                style={{ animationDelay: tile.delay }}
                className={cn(
                  "absolute hidden rounded-2xl bg-tile px-4 py-2 font-display text-sm font-bold shadow-tile motion-safe:animate-float sm:block",
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
