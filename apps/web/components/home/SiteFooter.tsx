import Link from "next/link";
import { Logo } from "@/components/Logo";

// Footer (Stitch "ByteReel — Home Landing Page"): logo + copyright line, and links. The design's
// "AI Ethics & Voices" and "Creator Community" have no pages, so they're left out. Privacy and
// Terms pages arrive in F37.

const LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#examples", label: "Examples" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/contact", label: "Contact" },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface-2">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 px-4 py-12 sm:px-6 md:flex-row">
        <div className="flex flex-col items-center md:items-start">
          <Logo href="/" size="sm" />
          <p className="mt-2 text-center text-sm text-muted md:text-left">© 2026 ByteReel · by Tech Byte Chronicles</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-x-6">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="inline-flex min-h-11 items-center rounded text-sm text-muted transition hover:text-gold-cream">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
