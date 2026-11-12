import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button, Card, Chip, Input } from "@/components/ui";

// Developer-only style sheet: every basic building block with the Ember Gold tokens, to compare
// against the approved Stitch designs. Not available in production builds.

export const metadata: Metadata = { title: "Style sheet", robots: { index: false } };

const SWATCHES = [
  ["bg", "bg-bg", "#0B0806"],
  ["surface", "bg-surface", "#15100B"],
  ["surface-2", "bg-surface-2", "#1A120A"],
  ["screen", "bg-screen", "#120C07"],
  ["amber", "bg-amber", "#F5A524"],
  ["amber-deep", "bg-amber-deep", "#E8901A"],
  ["gold-cream", "bg-gold-cream", "#FFE2A8"],
  ["text", "bg-text", "#F7EFE6"],
  ["muted", "bg-muted", "#B5A795"],
  ["logo-circle", "bg-logo-circle", "#1A1A2E"],
] as const;

const STATUSES = [
  ["Video ready", "bg-success-bg text-success"],
  ["Making video…", "bg-progress-bg text-progress"],
  ["Storyboard ready", "bg-warning-bg text-warning"],
  ["Failed · Retry", "bg-danger-bg text-danger"],
] as const;

function Label({ children }: { children: string }) {
  return <p className="mb-4 font-mono text-xs uppercase tracking-[0.08em] text-amber-light">{children}</p>;
}

export default function StyleGuidePage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="bg-atmosphere min-h-dvh px-4 py-12 sm:px-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <header>
          <p className="font-mono text-xs uppercase tracking-[0.08em] text-muted">Developer only · F02</p>
          <h1 className="mt-2 text-4xl font-extrabold">
            Byte<span className="text-gradient-gold">Reel</span> style sheet
          </h1>
          <p className="mt-2 max-w-prose text-muted">
            The basic building blocks in the approved Ember Gold style (docs/BRAND.md).
          </p>
        </header>

        <Card>
          <Label>01 · Colours</Label>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {SWATCHES.map(([name, cls, hex]) => (
              <div key={name}>
                <div className={`h-12 rounded-xl border border-line ${cls}`} />
                <p className="mt-2 text-sm">{name}</p>
                <p className="font-mono text-xs text-muted">{hex}</p>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            {STATUSES.map(([label, cls]) => (
              <span key={label} className={`rounded-full px-3 py-1 text-sm font-medium ${cls}`}>
                {label}
              </span>
            ))}
          </div>
        </Card>

        <Card>
          <Label>02 · Typography</Label>
          <p className="font-display text-5xl font-extrabold leading-[1.05]">
            Turn any topic into a <span className="text-gradient-gold">ready-to-post Reel</span>
          </p>
          <h2 className="mt-6 text-3xl font-bold">Heading 2 · Exo 2</h2>
          <h3 className="mt-3 text-[22px] font-bold">Heading 3 · Exo 2</h3>
          <p className="mt-3 font-display text-[19px] font-bold text-muted">
            Explain<span className="text-amber">.</span> Animate<span className="text-amber">.</span> Post
            <span className="text-amber">.</span>
          </p>
          <p className="mt-3 max-w-prose text-base">Body text in Ubuntu. Short sentences, active verbs.</p>
          <p className="mt-2 text-[13px] text-muted">Small muted text in Ubuntu.</p>
          <p lang="hi" className="mt-3 text-lg font-medium">हिंदी · पानी का चक्र कैसे काम करता है · महिला आवाज़ · पुरुष आवाज़</p>
          <p className="mt-3 font-mono text-xs uppercase tracking-[0.08em] text-amber-light">Label · JetBrains Mono · 1:12</p>
        </Card>

        <Card>
          <Label>03 · Buttons</Label>
          <div className="flex flex-wrap items-center gap-4">
            <Button>Create your first reel</Button>
            <Button variant="secondary">Back to home</Button>
            <Button size="sm">Sign in</Button>
            <Button arrow={false}>Save changes</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className="mt-6 max-w-sm">
            <Button fullWidth>Create storyboard</Button>
          </div>
        </Card>

        <Card>
          <Label>04 · Inputs</Label>
          <div className="grid max-w-md gap-5">
            <Input id="sg-name" label="Name" placeholder="Your name" />
            <Input id="sg-email" label="Email" type="email" placeholder="you@example.com" />
            <Input id="sg-password" label="Password" type="password" helper="8 to 128 characters" />
            <Input
              id="sg-error"
              label="Email"
              type="email"
              defaultValue="not-an-email"
              error="Please enter a valid email address."
            />
            <Input id="sg-disabled" label="Disabled" disabled defaultValue="Can't edit this" />
          </div>
        </Card>

        <Card>
          <Label>05 · Chips</Label>
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.08em] text-muted">Language</p>
          <div className="flex flex-wrap gap-3">
            <Chip selected>English</Chip>
            <Chip>
              <span lang="hi">हिंदी</span> Hindi
            </Chip>
            <Chip>Hinglish</Chip>
          </div>
          <p className="mt-6 mb-3 font-mono text-xs uppercase tracking-[0.08em] text-muted">Voice</p>
          <div className="flex flex-wrap gap-3">
            <Chip selected icon="▶">
              Female voice
            </Chip>
            <Chip icon="▶">Male voice</Chip>
          </div>
        </Card>
      </div>
    </main>
  );
}
