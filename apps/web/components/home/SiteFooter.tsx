import Link from "next/link";
import { Logo } from "@/components/Logo";

// Footer (Stitch "ByteReel — Home v2"): logo · by Tech Byte Chronicles · © 2026 ByteReel, and
// Privacy / Terms / Contact. The Privacy and Terms pages arrive in F37.

const LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
] as const;

export function SiteFooter() {
  return (
    <footer>
      <div className="mx-auto flex max-w-[1240px] flex-col gap-6 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Logo href="/" size="sm" />
          <span aria-hidden="true">•</span>
          <span>by Tech Byte Chronicles</span>
          <span aria-hidden="true">•</span>
          <span>© 2026 ByteReel</span>
        </div>
        <nav aria-label="Footer" className="flex gap-6">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="inline-flex min-h-11 items-center rounded transition hover:text-text">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
