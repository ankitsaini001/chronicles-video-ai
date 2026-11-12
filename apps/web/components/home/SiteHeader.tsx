import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui";

// Public site nav (Stitch "ByteReel — Home Landing Page"; BRAND §8). Changes from the design:
// "Sign In" reads "Log in" to match the login screen; "Features" and "Pricing" are replaced by
// "FAQ" (there is no pricing in the beta, and no separate features page).

const linkClass = "inline-flex min-h-11 items-center rounded font-mono text-xs text-muted transition hover:text-text";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/80 shadow-card backdrop-blur-md">
      <div className="mx-auto flex h-[72px] max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Logo href="/" endorsement />
        <nav aria-label="Main" className="hidden items-center gap-8 md:flex">
          <Link href="/#how-it-works" className={linkClass}>
            How it works
          </Link>
          <Link href="/#examples" className={linkClass}>
            Examples
          </Link>
          <Link href="/#languages" className={`${linkClass} gap-1.5`}>
            Hindi voices
            <span className="rounded-full bg-amber px-1.5 py-0.5 text-[10px] leading-none font-bold text-on-amber shadow-[0_0_10px_#f5a5244d]">
              NEW
            </span>
          </Link>
          <Link href="/#faq" className={linkClass}>
            FAQ
          </Link>
        </nav>
        <Button href="/login" size="sm">
          Log in
        </Button>
      </div>
    </header>
  );
}
