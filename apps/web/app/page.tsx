// Temporary placeholder (F02). Step 2 shows the Ember Gold colours; the full style sheet page
// comes in step 4 and the real home page in F03.
const SWATCHES = [
  { name: "bg", className: "bg-bg" },
  { name: "surface", className: "bg-surface" },
  { name: "surface-2", className: "bg-surface-2" },
  { name: "amber", className: "bg-amber" },
  { name: "amber-deep", className: "bg-amber-deep" },
  { name: "gold-cream", className: "bg-gold-cream" },
  { name: "text", className: "bg-text" },
  { name: "muted", className: "bg-muted" },
] as const;

const STATUSES = [
  { label: "Ready", className: "bg-success-bg text-success" },
  { label: "Making video…", className: "bg-progress-bg text-progress" },
  { label: "Storyboard ready", className: "bg-warning-bg text-warning" },
  { label: "Failed · Retry", className: "bg-danger-bg text-danger" },
] as const;

export default function HomePage() {
  return (
    <main className="bg-atmosphere min-h-dvh px-4 py-16">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-4xl font-bold">
          Byte<span className="text-gradient-gold">Reel</span>
        </h1>
        <p className="mt-2 text-muted">The website is being built. (F02 step 2: Ember Gold colours)</p>

        <div className="mt-10 rounded-2xl border border-line bg-surface p-6 shadow-card">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {SWATCHES.map((s) => (
              <div key={s.name}>
                <div className={`h-14 rounded-xl border border-line ${s.className}`} />
                <p className="mt-2 text-sm text-muted">{s.name}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            {STATUSES.map((s) => (
              <span key={s.label} className={`rounded-full px-3 py-1 text-sm ${s.className}`}>
                {s.label}
              </span>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <span className="bg-button rounded-full px-6 py-3 font-bold text-on-amber shadow-glow">
              Amber button fill
            </span>
            <span className="rounded-full border border-line px-6 py-3">Line border</span>
          </div>
        </div>
      </div>
    </main>
  );
}
