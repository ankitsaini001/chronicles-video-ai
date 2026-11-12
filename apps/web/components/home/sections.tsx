import Image from "next/image";
import type { ReactNode } from "react";
import { Button, Card, cn } from "@/components/ui";

// Home page sections below the hero, word for word from the approved Stitch "ByteReel — Home v2".

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-amber">{children}</p>;
}

function Section({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn("scroll-mt-24 border-b border-line", className)}>
      <div className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6 md:py-24">{children}</div>
    </section>
  );
}

/* ---------- How it works ---------- */

const STEPS = [
  { title: "Idea", text: "Type a topic or paste your notes." },
  { title: "Storyboard", text: "Review the script and visuals scene by scene. Ask for changes in plain words." },
  { title: "Video", text: "AI voice, motion graphics and captions come together. Preview it and fix any caption." },
  {
    title: "Publish",
    text: "Download the MP4 or post it to Instagram, now or on a schedule. Nothing posts without your approval.",
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works">
      <Eyebrow>How it works</Eyebrow>
      <h2 className="mt-3 text-3xl font-bold sm:text-[40px]">From idea to Reel in four steps</h2>
      <ol className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step, i) => (
          <li key={step.title}>
            <Card className="h-full">
              <p className="font-mono text-sm text-amber">{String(i + 1).padStart(2, "0")}</p>
              <h3 className="mt-3 text-xl font-bold">{step.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">{step.text}</p>
            </Card>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* ---------- Examples ---------- */

const EXAMPLES = [
  { title: "The Water Cycle", language: "English", seconds: 64, image: "/examples/water-cycle.svg" },
  { title: "बचत खाता बनाम FD", lang: "hi", language: "हिंदी", seconds: 72, image: "/examples/savings-vs-fd.svg" },
  { title: "Opportunity cost kya hai?", language: "Hinglish", seconds: 68, image: "/examples/opportunity-cost.svg" },
  { title: "How UPI works", language: "English", seconds: 81, image: "/examples/how-upi-works.svg" },
] as const;

export function Examples() {
  return (
    <Section id="examples">
      <Eyebrow>Examples</Eyebrow>
      <h2 className="mt-3 text-3xl font-bold sm:text-[40px]">Sample reels made with ByteReel</h2>
      <ul className="mt-12 grid grid-cols-1 gap-5 min-[480px]:grid-cols-2 lg:grid-cols-4">
        {EXAMPLES.map((ex) => (
          <li key={ex.title}>
            <Card className="h-full p-3">
              <div className="relative aspect-[320/420] overflow-hidden rounded-xl border border-line bg-screen">
                <Image src={ex.image} alt="" fill unoptimized className="object-cover" />
                <span
                  lang={"lang" in ex ? ex.lang : undefined}
                  className="absolute top-2.5 left-2.5 rounded-full bg-bg/80 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-text"
                >
                  {ex.language}
                </span>
                <span className="absolute top-2.5 right-2.5 rounded-full bg-bg/80 px-2 py-0.5 font-mono text-[10px] text-muted">
                  {ex.seconds}s
                </span>
              </div>
              <h3 lang={"lang" in ex ? ex.lang : undefined} className="mt-4 px-1 font-display text-base font-bold">
                {ex.title}
              </h3>
              <p className="mt-1 px-1 pb-1 text-xs text-muted">Sample reel</p>
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ---------- Languages ---------- */

const LANGUAGES = [
  { name: "English", sample: "“Compound interest explained in 60 seconds.”" },
  { name: "हिंदी", lang: "hi", sample: "“पौधों में प्रकाश संश्लेषण कैसे होता है? आसान भाषा में समझें।”" },
  { name: "Hinglish", sample: "“Compound interest ko simple example se samjho.”" },
] as const;

export function Languages() {
  return (
    <Section id="languages">
      <Eyebrow>Languages</Eyebrow>
      <h2 className="mt-3 text-3xl font-bold sm:text-[40px]">Explain in the language your audience speaks</h2>
      <ul className="mt-12 grid gap-5 md:grid-cols-3">
        {LANGUAGES.map((l) => {
          const lang = "lang" in l ? l.lang : undefined;
          return (
            <li key={l.name}>
              <Card className="flex h-full flex-col">
                <h3 lang={lang} className="text-xl font-bold">
                  {l.name}
                </h3>
                <p lang={lang} className="mt-3 text-sm leading-relaxed text-muted">
                  {l.sample}
                </p>
                {/* Voice samples arrive in F13; until then these are labels, not buttons. */}
                <div className="mt-auto flex flex-wrap gap-2 border-t border-line pt-5">
                  {/* Same muted style for both, with no amber ▶, so they don't look clickable (amber = clickable). */}
                  {["Female voice", "Male voice"].map((voice) => (
                    <span
                      key={voice}
                      className="inline-flex items-center rounded-full border border-line px-3.5 py-1.5 text-xs font-medium text-muted"
                    >
                      {voice}
                    </span>
                  ))}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/* ---------- Why ByteReel ---------- */

const ICONS = {
  visuals:
    "M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.25 2.25L18 6.75",
  chat: "M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a.75.75 0 01-.974-.94 3.754 3.754 0 00.56-1.748A8.17 8.17 0 013 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z",
  edit: "M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10",
  shield:
    "M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z",
} as const;

// Typed with the ICONS keys, so a mistyped icon name is a type error.
const REASONS: { icon: keyof typeof ICONS; title: string; text: string }[] = [
  { icon: "visuals", title: "Visuals that explain", text: "Diagrams, flows, timelines, comparisons and charts that move with the narration." },
  { icon: "chat", title: "Change it by chatting", text: "Say “make scene 3 simpler” and ByteReel updates the storyboard." },
  { icon: "edit", title: "Captions you can correct", text: "Fix any caption word before you download or publish." },
  {
    icon: "shield",
    title: "You stay in control",
    text: "You approve the storyboard before the video is made, and the video before it is published.",
  },
];

export function WhyByteReel() {
  return (
    <Section>
      <Eyebrow>Why ByteReel</Eyebrow>
      <h2 className="mt-3 text-3xl font-bold sm:text-[40px]">Made for clear explanations</h2>
      <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {REASONS.map((r) => (
          <li key={r.title}>
            <Card className="h-full">
              <span className="flex size-10 items-center justify-center rounded-lg border border-line bg-surface-2">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" strokeWidth={1.75} className="size-5 stroke-amber">
                  <path strokeLinecap="round" strokeLinejoin="round" d={ICONS[r.icon]} />
                </svg>
              </span>
              <h3 className="mt-6 text-lg font-bold">{r.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">{r.text}</p>
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ---------- FAQ ---------- */

const FAQ = [
  {
    q: "Do I need video editing skills?",
    a: "No. You type an idea or paste notes, review the storyboard, and ByteReel makes the video.",
  },
  {
    q: "Which languages are supported?",
    a: (
      <>
        English, Hindi (<span lang="hi">हिंदी</span>) and Hinglish. For every video you choose a female or male voice.
      </>
    ),
  },
  { q: "How long are the videos?", a: "Between 60 and 90 seconds, in vertical 1080 × 1920 format." },
  {
    q: "Can I post directly to Instagram?",
    a: "Yes. Connect your Instagram professional account to post now or schedule. You can also download the MP4.",
  },
  { q: "Is ByteReel free?", a: "Yes, ByteReel is free during the private beta." },
];

export function Faq() {
  return (
    <Section>
      <div className="text-center">
        <Eyebrow>FAQ</Eyebrow>
        <h2 className="mt-3 text-3xl font-bold sm:text-[40px]">Questions, answered</h2>
      </div>
      <div className="mx-auto mt-12 flex max-w-3xl flex-col gap-3">
        {FAQ.map((item, i) => (
          <details
            key={item.q}
            open={i === 0}
            className="group rounded-2xl border border-line bg-surface open:shadow-card [&_summary::-webkit-details-marker]:hidden"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-6 py-5 font-display font-bold">
              {item.q}
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="size-5 shrink-0 text-amber transition group-open:rotate-180"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <p className="border-t border-line px-6 py-5 text-sm leading-relaxed text-muted">{item.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

/* ---------- Final call to action ---------- */

export function FinalCta() {
  return (
    <section className="border-b border-line bg-[radial-gradient(60%_80%_at_50%_50%,#f5a5241f,transparent_70%)]">
      <div className="mx-auto max-w-4xl px-4 py-20 text-center sm:px-6 md:py-28">
        <Eyebrow>Ready?</Eyebrow>
        <h2 className="mt-4 text-4xl font-extrabold sm:text-5xl">
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
