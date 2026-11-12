import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./cn";

// Text input from docs/BRAND.md §5: surface-2 background, 1px line, 16px radius,
// gold-cream focus ring. Label above, optional helper text or error below.
// - `id` is required so the label and messages are linked for screen readers.
// - `className` styles the wrapper (label + field + message), not the <input> itself.
// - Focus ring: 2px gold-cream with 0 offset (tight ring, as in the Stitch designs). This is an
//   intentional exception to the global 3px offset in BRAND §9; the ring stays fully visible.
// - Nothing can be placed inside the field yet; the password show/hide toggle (F08) will add it.

type InputProps = Omit<ComponentPropsWithoutRef<"input">, "id"> & {
  id: string;
  label: string;
  helper?: string;
  error?: string;
};

export function Input({ id, label, helper, error, className, "aria-describedby": describedBy, ...props }: InputProps) {
  const message = error || helper;
  const messageId = message ? `${id}-message` : undefined;
  const describedByIds = [describedBy, messageId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <input
        {...props}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByIds}
        className={cn(
          "min-h-12 w-full rounded-2xl border bg-surface-2 px-4 py-3 text-[15px] text-text",
          "placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-gold-cream",
          "disabled:opacity-50",
          error ? "border-danger" : "border-line",
        )}
      />
      {messageId && (
        <p id={messageId} className={cn("text-[13px]", error ? "text-danger" : "text-muted")}>
          {message}
        </p>
      )}
    </div>
  );
}
