import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui";

// Home page nav (Stitch "ByteReel — Home v2"; BRAND §8). The design's "Sign in" button reads
// "Log in" to match the login screen (design audit note in docs/features/F03-home-page.md).

const NAV = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#examples", label: "Examples" },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-4 px-4 sm:h-20 sm:px-6">
        <Logo href="/" endorsement />
        <nav aria-label="Main" className="hidden items-center gap-8 text-sm font-medium text-muted md:flex">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="rounded transition hover:text-text">
              {item.label}
            </Link>
          ))}
          <Link href="#languages" className="inline-flex items-center gap-2 rounded transition hover:text-text">
            Hindi voices
            <span className="rounded-full bg-amber px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none text-on-amber">
              NEW
            </span>
          </Link>
        </nav>
        <Button href="/login" size="sm">
          Log in
        </Button>
      </div>
    </header>
  );
}
