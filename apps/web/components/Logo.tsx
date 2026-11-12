import Link from "next/link";
import { cn } from "@/components/ui";

// ByteReel logo (docs/BRAND.md §6): amber play triangle in a dark circle with a faint amber glow,
// wordmark "Byte" + gold-gradient "Reel" in Exo 2 700, optional "by Tech Byte Chronicles".

type LogoProps = {
  /** Show "by Tech Byte Chronicles" under the wordmark. */
  endorsement?: boolean;
  size?: "md" | "sm";
  /** Wrap in a link to the home page. */
  href?: string;
  className?: string;
};

export function LogoMark({ size = "md" }: { size?: "md" | "sm" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-logo-circle shadow-[0_0_14px_#f5a52455] ring-1 ring-amber/30",
        size === "md" ? "size-9" : "size-7",
      )}
    >
      <svg viewBox="0 0 24 24" className={cn("fill-amber", size === "md" ? "ml-0.5 size-4" : "ml-0.5 size-3")}>
        <polygon points="5,3 19,12 5,21" />
      </svg>
    </span>
  );
}

export function Logo({ endorsement = false, size = "md", href, className }: LogoProps) {
  const content = (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark size={size} />
      <span className="flex flex-col leading-none">
        <span className={cn("font-display font-bold", size === "md" ? "text-xl" : "text-base")}>
          Byte<span className="text-gradient-gold">Reel</span>
        </span>
        {endorsement && (
          <span className="mt-1 font-mono text-[9px] uppercase tracking-wider text-muted">by Tech Byte Chronicles</span>
        )}
      </span>
    </span>
  );
  if (!href) return content;
  return (
    <Link href={href} aria-label="ByteReel home" className="rounded-lg">
      {content}
    </Link>
  );
}
