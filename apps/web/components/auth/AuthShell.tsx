import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { Card } from "@/components/ui";

// Frame for the account screens (Stitch "Sign up", "Log in", "Access pending"): warm light behind a
// centred 440px card with the logo, a heading and a short line, then whatever goes below the card,
// and a small Privacy · Terms footer.

type AuthShellProps = {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Shown under the card (e.g. "Already have an account? Log in"). */
  below?: ReactNode;
};

export function AuthShell({ title, subtitle, children, below }: AuthShellProps) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center overflow-x-hidden">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_40%,#f5a5241f,transparent_60%)]" />
      <main className="relative z-10 flex w-full flex-1 flex-col items-center justify-center px-4 py-10">
        <Card className="w-full max-w-[440px] p-8 md:p-10">
          <div className="mb-8 flex flex-col items-center text-center">
            <Logo href="/" className="mb-6" />
            <h1 className="text-[28px] font-bold leading-tight tracking-tight">{title}</h1>
            {subtitle && <p className="mt-2 max-w-[340px] text-sm leading-relaxed text-muted">{subtitle}</p>}
          </div>
          {children}
        </Card>
        {below && <div className="mt-6 text-center text-sm text-muted">{below}</div>}
      </main>
      <footer className="relative z-10 w-full py-6 text-center text-[13px] text-muted">
        <Link href="/privacy" className="hover:text-gold-cream">
          Privacy
        </Link>
        <span aria-hidden="true" className="mx-2">
          ·
        </span>
        <Link href="/terms" className="hover:text-gold-cream">
          Terms
        </Link>
      </footer>
    </div>
  );
}
