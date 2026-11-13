import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";

// Selectable chip (pill) for choices like language and voice (docs/BRAND.md §5, Stitch "Step 1 Idea").
// Unselected: surface-2 + thin line. Selected: amber border + warm amber-tinted background.
// `selected` is announced to screen readers via aria-pressed (an on/off toggle). With
// role="radio" it is announced via aria-checked instead: single choices (language, voice) use
// <ChoiceChips>, which wraps radio chips in a labelled role="radiogroup" with arrow-key moves.

type ChipProps = Omit<ComponentPropsWithRef<"button">, "children"> & {
  selected?: boolean;
  /** Optional leading icon, e.g. "▶" for a voice preview. */
  icon?: ReactNode;
  children: ReactNode;
};

export function Chip({ selected = false, icon, className, children, type = "button", ...props }: ChipProps) {
  const isRadio = props.role === "radio";
  return (
    <button
      {...props}
      type={type}
      aria-pressed={isRadio ? undefined : selected}
      aria-checked={isRadio ? selected : undefined}
      className={cn(
        "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition",
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
