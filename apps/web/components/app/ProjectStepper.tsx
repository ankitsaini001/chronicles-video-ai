import { cn } from "@/components/ui";

// The 4-step indicator on every project page (ARCHITECTURE §11 "UI rules", Stitch "Step 1 Idea"):
// 1 Idea → 2 Storyboard → 3 Video → 4 Publish. The current step is an amber pill. It only shows
// where you are; it is not navigation (the server decides which step is open).
// Phones: the other steps show just their number (their names stay readable for screen readers),
// so the row fits at 320px.

export type ProjectStep = "idea" | "storyboard" | "video" | "publish";

const STEPS: readonly { id: ProjectStep; label: string }[] = [
  { id: "idea", label: "Idea" },
  { id: "storyboard", label: "Storyboard" },
  { id: "video", label: "Video" },
  { id: "publish", label: "Publish" },
];

export function ProjectStepper({ current, className }: { current: ProjectStep; className?: string }) {
  return (
    <ol aria-label="Video steps" className={cn("flex items-center gap-1.5 sm:gap-2", className)}>
      {STEPS.map((step, index) => {
        const active = step.id === current;
        return (
          <li key={step.id} className="flex items-center gap-1.5 sm:gap-2" aria-current={active ? "step" : undefined}>
            {index > 0 && <span aria-hidden="true" className="h-px w-4 bg-amber/20 sm:w-8" />}
            <span
              className={cn(
                "flex h-8 items-center justify-center gap-1 rounded-full font-mono text-xs whitespace-nowrap",
                active ? "bg-amber px-4 font-bold text-on-amber shadow-[0_2px_12px_#f5a5244d]" : "min-w-8 border border-line px-2.5 text-muted sm:px-3.5",
              )}
            >
              {index + 1}{" "}
              <span className={active ? "" : "sr-only sm:not-sr-only"}>{step.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
