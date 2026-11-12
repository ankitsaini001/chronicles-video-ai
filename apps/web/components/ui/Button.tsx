import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./cn";

// Buttons from docs/BRAND.md §5:
// - primary: amber gradient pill, dark text, amber glow, ↗ arrow circle on the right
// - primary + size "sm": compact pill (e.g. "Sign in" in the nav), no arrow
// - secondary: transparent pill with a thin amber-15% border
// One primary button per screen (BRAND §2 "one glowing element per screen").

type Variant = "primary" | "secondary";
type Size = "md" | "sm";

type CommonProps = {
  variant?: Variant;
  size?: Size;
  /** Show the ↗ circle. Defaults to true for primary "md", false otherwise. */
  arrow?: boolean;
  fullWidth?: boolean;
  className?: string;
  children: ReactNode;
};

type ButtonProps = CommonProps & Omit<ComponentPropsWithoutRef<"button">, keyof CommonProps> & { href?: undefined };
type LinkProps = CommonProps & Omit<ComponentPropsWithoutRef<typeof Link>, keyof CommonProps> & { href: string };

export type ButtonOrLinkProps = ButtonProps | LinkProps;

const base =
  "inline-flex min-h-11 items-center justify-center gap-3 rounded-full font-bold transition " +
  "motion-safe:hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-50 " +
  "aria-disabled:pointer-events-none aria-disabled:opacity-50";

function classesFor(variant: Variant, size: Size, hasArrow: boolean, fullWidth: boolean): string {
  const v =
    variant === "primary"
      ? "bg-button text-on-amber shadow-glow"
      : "border border-line bg-transparent text-text hover:border-amber/40 hover:bg-surface-2";
  const s =
    size === "sm"
      ? "px-5 py-2.5 text-sm"
      : hasArrow
        ? "py-[9px] pr-[9px] pl-[26px] text-[15px]"
        : "px-6 py-3 text-[15px]";
  return cn(base, v, s, fullWidth && "w-full");
}

function Inner({ hasArrow, fullWidth, children }: { hasArrow: boolean; fullWidth: boolean; children: ReactNode }) {
  // Full-width buttons (e.g. auth forms) centre their label, like the Stitch designs.
  return (
    <>
      <span className={cn(hasArrow && "flex-1", hasArrow && (fullWidth ? "pl-10 text-center" : "text-left"))}>{children}</span>
      {hasArrow && (
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-black/15 text-lg">
          ↗
        </span>
      )}
    </>
  );
}

export function Button(props: ButtonOrLinkProps) {
  const { variant = "primary", size = "md", arrow, fullWidth = false, className, children, ...rest } = props;
  const hasArrow = arrow ?? (variant === "primary" && size === "md");
  const classes = cn(classesFor(variant, size, hasArrow, fullWidth), className);

  if (rest.href !== undefined) {
    const linkProps = rest as Omit<LinkProps, keyof CommonProps>;
    return (
      <Link {...linkProps} className={classes}>
        <Inner hasArrow={hasArrow} fullWidth={fullWidth}>{children}</Inner>
      </Link>
    );
  }

  const { type = "button", ...buttonProps } = rest as Omit<ButtonProps, keyof CommonProps>;
  return (
    <button type={type} {...buttonProps} className={classes}>
      <Inner hasArrow={hasArrow} fullWidth={fullWidth}>{children}</Inner>
    </button>
  );
}
