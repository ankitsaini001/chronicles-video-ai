import Link from "next/link";
import { cn } from "@/components/ui";

// The 4-step indicator on every project page (ARCHITECTURE §11 "UI rules", Stitch "Step 1 Idea",
// "Step 2 Storyboard"): 1 Idea → 2 Storyboard → 3 Video → 4 Publish. The current step is an amber
// pill; steps before it show a ✓. The server decides which step is open: a step is a link only when
// the page passes an address for it (F16: "2 Storyboard" once a storyboard exists).
// Phones: the other steps show just their number (their names stay readable for screen readers),
// so the row fits at 320px.

export type ProjectStep = "idea" | "storyboard" | "video" | "publish";

const STEPS: readonly { id: ProjectStep; label: string }[] = [
  { id: "idea", label: "Idea" },
  { id: "storyboard", label: "Storyboard" },
  { id: "video", label: "Video" },
  { id: "publish", label: "Publish" },
];

export function ProjectStepper({ current, hrefs = {}, className }: { current: ProjectStep; hrefs?: Partial<Record<ProjectStep, string>>; className?: string }) {
  const currentIndex = STEPS.findIndex((s) => s.id === current);
  return (
    <ol aria-label="Video steps" className={cn("flex items-center gap-1.5 sm:gap-2", className)}>
      {STEPS.map((step, index) => {
        const active = step.id === current;
        const done = index < currentIndex;
        const href = hrefs[step.id];
        const classes = cn(
          "flex h-8 items-center justify-center gap-1 rounded-full font-mono text-xs whitespace-nowrap",
          active ? "bg-amber px-4 font-bold text-on-amber shadow-[0_2px_12px_#f5a5244d]" : "min-w-8 border border-line px-2.5 sm:px-3.5",
          !active && (done ? "text-text" : "text-muted"),
          href && !active && "transition-colors hover:border-amber/40 hover:text-text",
        );
        const content = (
          <>
            {done ? (
              <span aria-hidden="true" className="font-bold text-amber">
                ✓
              </span>
            ) : (
              <>{index + 1} </>
            )}
            <span className={active ? "" : "sr-only sm:not-sr-only"}>
              {step.label}
              {done && <span className="sr-only"> (done)</span>}
            </span>
          </>
        );
        return (
          <li key={step.id} className="flex items-center gap-1.5 sm:gap-2" aria-current={active ? "step" : undefined}>
            {index > 0 && <span aria-hidden="true" className="h-px w-4 bg-amber/20 sm:w-8" />}
            {href ? (
              <Link href={href} className={classes}>
                {content}
              </Link>
            ) : (
              <span className={classes}>{content}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
