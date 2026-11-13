import Image from "next/image";
import type { ReactNode } from "react";
import { Button, cn, Icon, type IconName, PlayIcon } from "@/components/ui";
import { SITE } from "@/lib/site";

// Home page sections below the hero. Layout and look from the Stitch "ByteReel — Home Landing
// Page" (docs/design/stitch/home-landing-v1.html). Copy follows the design, except claims V1 can't
// back up (made-up creators, view counts, user numbers, voice names, extra platforms/languages),
// which use the honest wording from the approved Home v2. See docs/features/F03-home-page.md.

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mb-2 font-mono text-xs font-medium uppercase tracking-widest text-amber">{children}</p>;
}

function Heading({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("text-3xl font-extrabold tracking-tight sm:text-[44px] sm:leading-[1.1]", className)}>{children}</h2>;
}

function Section({ id, band, children }: { id?: string; band?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={cn("scroll-mt-20 border-t border-amber/25 py-20 md:py-24", band && "bg-surface/50")}>
      <div className="mx-auto max-w-7xl px-4 sm:px-6">{children}</div>
    </section>
  );
}

const cardBase = "rounded-2xl border border-line bg-surface transition duration-300 hover:border-amber/40";

/* ---------- How it works ---------- */

const STEPS: { title: string; text: string; icon: IconName; noteIcon: IconName; note: string }[] = [
  {
    title: "Idea",
    text: `Type a topic or paste your notes. ${SITE.name} drafts a storyboard made for vertical viewing.`,
    icon: "bulb",
    noteIcon: "clock",
    note: "About 30 seconds",
  },
  {
    title: "Storyboard",
    text: "Review the narration and visuals scene by scene. Ask for changes in plain words.",
    icon: "storyboard",
    noteIcon: "chat",
    note: "Chat to edit",
  },
  {
    title: "Video",
    text: "AI voice, motion graphics and captions come together. Preview it and fix any caption.",
    icon: "video",
    noteIcon: "captions",
    note: "Synced captions",
  },
  {
    title: "Publish",
    text: "Download the MP4 in 1080 × 1920 or post it to Instagram, now or on a schedule. Nothing posts without your approval.",
    icon: "send",
    noteIcon: "check",
    note: "1080p HD",
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works">
      <div className="mb-16 max-w-2xl">
        <Eyebrow>Process</Eyebrow>
        <Heading>From raw notes to vertical reel in four steps</Heading>
      </div>
      <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step, i) => (
          <li key={step.title} className={cn(cardBase, "group flex flex-col justify-between p-6")}>
            <div>
              <div className="mb-8 flex items-center justify-between">
                <span className="font-mono text-[22px] font-bold text-amber">{String(i + 1).padStart(2, "0")}</span>
                <span className="flex size-10 items-center justify-center rounded-full border border-line bg-surface-2 text-amber transition-transform motion-safe:group-hover:scale-110">
                  <Icon name={step.icon} className="size-[18px]" />
                </span>
              </div>
              <h3 className="mb-3 text-[22px] font-bold">{step.title}</h3>
              <p className="text-muted">{step.text}</p>
            </div>
            <p className="mt-8 flex items-center gap-1.5 border-t border-amber/25 pt-4 font-mono text-[11px] text-gold-cream/70">
              <Icon name={step.noteIcon} className="size-3.5 text-amber" />
              {step.note}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* ---------- Examples (showcase) ---------- */

// Image files carry a version suffix (-v2): Next.js caches resized images by URL, so a changed
// image must get a new file name or visitors keep seeing the old one.
const EXAMPLES = [
  {
    title: "The Water Cycle",
    topic: "Earth Science",
    language: "English",
    seconds: 64,
    voice: "Female voice",
    image: "/examples/water-cycle-v2.jpg",
  },
  {
    title: "बचत खाता बनाम FD",
    lang: "hi",
    topic: "Personal Finance",
    language: "हिंदी Hindi",
    seconds: 72,
    voice: "Male voice",
    image: "/examples/savings-vs-fd-v2.jpg",
  },
  {
    title: "What is opportunity cost?",
    topic: "Economics",
    language: "English",
    seconds: 68,
    voice: "Female voice",
    image: "/examples/opportunity-cost-v2.jpg",
  },
  {
    title: "How UPI works",
    topic: "Tech Explainer",
    language: "English",
    seconds: 81,
    voice: "Male voice",
    image: "/examples/how-upi-works-v2.jpg",
  },
] as const;

export function Examples() {
  return (
    <Section id="examples" band>
      <div className="mb-16 flex flex-col justify-between gap-6 md:flex-row md:items-end">
        <div>
          <Eyebrow>Showcase</Eyebrow>
          <Heading>What your reels can look like</Heading>
        </div>
        <p className="font-mono text-xs text-muted">Sample reels · 1080 × 1920 vertical</p>
      </div>
      <ul className="grid gap-6 min-[480px]:grid-cols-2 lg:grid-cols-4">
        {EXAMPLES.map((ex) => {
          const lang = "lang" in ex ? ex.lang : undefined;
          return (
            <li key={ex.title} className="flex flex-col overflow-hidden rounded-2xl border border-line bg-surface">
              <div className="relative flex aspect-[9/16] flex-col justify-between overflow-hidden bg-[#0e0a07] p-5">
                <Image
                  src={ex.image}
                  alt=""
                  fill
                  sizes="(min-width: 1024px) 300px, (min-width: 480px) 50vw, 100vw"
                  className="object-cover opacity-60"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-bg from-10% via-bg/40 via-45% to-bg/80" />
                <div className="relative flex items-center justify-between">
                  <span
                    lang={lang}
                    className="rounded-full border border-line bg-surface-2/80 px-2.5 py-1 font-mono text-[10px] text-gold-cream backdrop-blur-md"
                  >
                    {ex.language}
                  </span>
                  <span className="rounded bg-black/60 px-2 py-0.5 font-mono text-[10px] text-muted">{ex.seconds}s</span>
                </div>
                {/* Decorative: sample videos aren't playable yet, so no hover effects (nothing to click). */}
                <span
                  aria-hidden="true"
                  className="relative mx-auto flex size-12 items-center justify-center rounded-full bg-amber/90 text-on-amber shadow-[0_0_20px_#f5a52499]"
                >
                  <PlayIcon className="ml-0.5 size-5" />
                </span>
                <div className="relative">
                  <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-amber">{ex.topic}</p>
                  <h3 lang={lang} className="text-lg leading-tight font-bold">
                    {ex.title}
                  </h3>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-line bg-surface-2 p-4 text-xs text-muted">
                <span>Sample reel</span>
                <span className="font-mono text-amber">{ex.voice}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/* ---------- Languages ---------- */

// Hinglish is supported in the app but not advertised on the home page (founder, 2026-11-13).

const LANGUAGES = [
  {
    chip: "English",
    note: "Clear narration",
    title: "Clear, simple English",
    sampleLabel: "Sample narration script",
    sample: "“Compound interest explained in 60 seconds with practical Indian examples.”",
  },
  {
    chip: "हिंदी (Hindi)",
    note: "Native Devanagari",
    highlight: true,
    lang: "hi",
    title: "शुद्ध एवं सरल हिंदी वाचन",
    sampleLabel: "नमूना स्क्रिप्ट (Sample)",
    sample: "“पौधों में प्रकाश संश्लेषण (Photosynthesis) कैसे होता है? आसान भाषा में समझें।”",
  },
] as const;

export function Languages() {
  return (
    <Section id="languages">
      <div className="mb-16 max-w-2xl">
        <Eyebrow>Voice &amp; languages</Eyebrow>
        <Heading>Speak to your learners in their own language</Heading>
      </div>
      <ul className="grid gap-8 md:grid-cols-2">
        {LANGUAGES.map((l) => {
          const lang = "lang" in l ? l.lang : undefined;
          return (
            <li key={l.chip} className={cn(cardBase, "flex flex-col justify-between p-6")}>
              <div>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <span lang={lang} className="rounded-full border border-line bg-surface-2 px-3 py-1 font-mono text-xs text-gold-cream">
                    {l.chip}
                  </span>
                  <span className={cn("font-mono text-[11px]", "highlight" in l ? "font-semibold text-amber" : "text-muted")}>
                    {l.note}
                  </span>
                </div>
                <h3 lang={lang} className="mb-4 text-[22px] font-bold">
                  {l.title}
                </h3>
                <div className="mb-6 rounded-xl border border-line bg-surface-2 p-4">
                  <p lang={lang} className="mb-1 font-mono text-[10px] uppercase text-muted">
                    {l.sampleLabel}
                  </p>
                  <p lang={lang} className="italic">
                    {l.sample}
                  </p>
                </div>
              </div>
              {/* Voice samples arrive in F13; until then this is information, not a player. */}
              <div className="border-t border-amber/25 pt-4">
                <div className="flex items-center gap-3 rounded-xl border border-line bg-bg/60 p-2">
                  <span className="flex size-8 items-center justify-center rounded-full border border-line bg-surface-2 text-amber">
                    <Icon name="mic" className="size-4" />
                  </span>
                  <span className="flex flex-col">
                    <span className="text-xs font-bold">Female or male voice</span>
                    <span className="font-mono text-[10px] text-muted">You choose for every video</span>
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/* ---------- Why us ---------- */

const REASONS: { icon: IconName; title: string; text: ReactNode }[] = [
  {
    icon: "sparkles",
    title: "Explanations, not just decoration",
    text: "Diagrams, flowcharts, timelines, side-by-side comparisons and charts that move with the narration.",
  },
  {
    icon: "chat",
    title: "Change it by chatting",
    text: (
      <>
        Don&apos;t like a scene? Just say <strong className="text-gold-cream">“make scene 3 simpler”</strong> or{" "}
        <strong className="text-gold-cream">“add a cricket analogy”</strong> and {SITE.name} updates the storyboard.
      </>
    ),
  },
  {
    icon: "captions",
    title: "Captions you can correct",
    text: "Fix any caption word before you download or publish, including Indian names, places and technical terms.",
  },
  {
    icon: "tune",
    title: "You stay in control",
    text: "No surprises. You approve the storyboard before the video is made, and the video before anything is posted.",
  },
];

export function WhyUs() {
  return (
    <Section band>
      <div className="mb-16 max-w-2xl">
        <Eyebrow>Why {SITE.name}</Eyebrow>
        <Heading>Designed for depth, speed, and total creator control</Heading>
      </div>
      <ul className="grid gap-8 md:grid-cols-2">
        {REASONS.map((r) => (
          <li key={r.title} className={cn(cardBase, "p-8")}>
            <span className="flex size-12 items-center justify-center rounded-full border border-line bg-surface-2 text-amber shadow-[0_0_15px_#f5a52426]">
              <Icon name={r.icon} className="size-5" />
            </span>
            <h3 className="mt-6 mb-3 text-[22px] font-bold">{r.title}</h3>
            <p className="leading-relaxed text-muted">{r.text}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ---------- FAQ ---------- */

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "Do I need video editing or animation skills?",
    a: `None at all. ${SITE.name} handles the script, motion graphics, voice and captions. You bring the idea or your notes.`,
  },
  {
    q: "Which languages are supported?",
    a: (
      <>
        English and Hindi (<span lang="hi">हिंदी</span>). For every video you choose a female or male voice.
      </>
    ),
  },
  { q: "How long are the generated videos?", a: "Between 60 and 90 seconds, in vertical 1080 × 1920 format, made for Instagram Reels." },
  {
    q: "Can I post directly to Instagram?",
    a: "Yes. Connect your Instagram professional account to post now or schedule. You can also download the MP4.",
  },
  { q: `Is ${SITE.name} free during the beta?`, a: `Yes, ${SITE.name} is free during the private beta.` },
];

export function Faq() {
  return (
    <Section id="faq">
      <div className="mb-12 text-center">
        <Eyebrow>Common questions</Eyebrow>
        <Heading>Everything you need to know</Heading>
      </div>
      <div className="mx-auto flex max-w-[848px] flex-col gap-4">
        {FAQ.map((item) => (
          <details key={item.q} className={cn(cardBase, "group [&_summary::-webkit-details-marker]:hidden")}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-6 py-6 font-display text-lg font-bold">
              {item.q}
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-amber transition group-open:rotate-180">
                <Icon name="chevron" className="size-4" />
              </span>
            </summary>
            <p className="border-t border-line px-6 py-5 leading-relaxed text-muted">{item.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

/* ---------- Final call to action ---------- */

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-amber/25 bg-[radial-gradient(50%_70%_at_50%_45%,#f5a52429,transparent_70%)]">
      <div className="mx-auto max-w-4xl px-4 py-24 text-center sm:px-6 md:py-28">
        <Eyebrow>Ready to create?</Eyebrow>
        <h2 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-[60px] sm:leading-[1.05]">
          Your next explainer is <span className="text-gradient-gold">one idea away</span>
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-base text-muted sm:text-lg">
          Type a topic or paste your notes. Your storyboard is ready in about 30 seconds.
        </p>
        <div className="mt-10">
          <Button href="/signup">Create your first reel</Button>
        </div>
      </div>
    </section>
  );
}
