import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./cn";

// Selectable chip (pill) for choices like language and voice (docs/BRAND.md §5, Stitch "Step 1 Idea").
// Unselected: surface-2 + thin line. Selected: amber border + warm amber-tinted background.
// `selected` is announced to screen readers via aria-pressed.

type ChipProps = Omit<ComponentPropsWithoutRef<"button">, "children"> & {
  selected?: boolean;
  /** Optional leading icon, e.g. "▶" for a voice preview. */
  icon?: ReactNode;
  children: ReactNode;
};

export function Chip({ selected = false, icon, className, children, type = "button", ...props }: ChipProps) {
  return (
    <button
      {...props}
      type={type}
      aria-pressed={selected}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
        "disabled:pointer-events-none disabled:opacity-50",
        selected
          ? "border-amber bg-progress-bg text-text"
          : "border-line bg-surface-2 text-muted hover:border-amber/40 hover:text-text",
        className,
      )}
    >
      {icon && (
        <span aria-hidden="true" className="text-amber">
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}
