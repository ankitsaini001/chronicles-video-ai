"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Chip } from "./Chip";
import { cn } from "./cn";

// A single choice shown as chips (Stitch "Step 1 Idea": LANGUAGE and VOICE), with real radio
// semantics (WAI-ARIA "Radio Group" pattern, F02 review note):
// - the chips sit in a role="radiogroup" named by the visible label
// - each chip is role="radio" with aria-checked
// - Tab reaches only the chosen chip; ←/→ (and ↑/↓) move to the previous/next chip and choose it,
//   Home/End jump to the first/last; Space or Enter on a chip chooses it.

export type ChoiceOption<T extends string> = { value: T; label: ReactNode };

type ChoiceChipsProps<T extends string> = {
  /** Visible group label, e.g. "Language". */
  label: string;
  options: readonly ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
};

export function ChoiceChips<T extends string>({ label, options, value, onChange, disabled = false, className }: ChoiceChipsProps<T>) {
  const labelId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    refs.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = options.length - 1;
    const next: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowDown: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowUp: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const target = next[event.key];
    if (target === undefined) return;
    event.preventDefault();
    choose(target);
  }

  // If the value matches no option, the first chip still takes the Tab stop.
  const checkedIndex = Math.max(0, options.findIndex((o) => o.value === value));

  return (
    <div className={className}>
      <p id={labelId} className="mb-2.5 font-mono text-xs uppercase tracking-wider text-muted">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={labelId} aria-disabled={disabled || undefined} className={cn("flex flex-wrap gap-2.5")}>
        {options.map((option, index) => {
          const checked = option.value === value;
          return (
            <Chip
              key={option.value}
              ref={(el) => {
                refs.current[index] = el;
              }}
              role="radio"
              selected={checked}
              tabIndex={index === checkedIndex ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {option.label}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
