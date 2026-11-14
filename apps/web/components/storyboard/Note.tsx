import type { ReactNode } from "react";
import { cn } from "@/components/ui";

// A short note on the storyboard (Stitch "Step 2 Storyboard": the amber warning strip).
// "warning": something to check (the AI's warnings); "problem": must be fixed before approving.

export function Note({ tone, children, className }: { tone: "warning" | "problem"; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed",
        tone === "warning" ? "border-warning/25 bg-warning-bg text-warning" : "border-danger/40 bg-danger-bg text-text",
        className,
      )}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className={cn("mt-px size-4 shrink-0 fill-current", tone === "problem" && "text-danger")}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
        />
      </svg>
      <span className="min-w-0 break-words">
        <span className="sr-only">{tone === "warning" ? "Note: " : "Needs fixing: "}</span>
        {children}
      </span>
    </div>
  );
}
