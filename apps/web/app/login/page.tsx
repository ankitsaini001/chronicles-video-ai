import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/LoginForm";
import { redirectIfSignedIn } from "@/lib/auth/session";
import { SITE } from "@/lib/site";

// Log in (F09, Stitch "Log in", docs/design/stitch/login.html; docs/API.md A2).
// Already signed in → My videos. No password-reset email in V1: the team sends a reset link (F35).

export const metadata: Metadata = {
  title: "Log in",
  description: `Log in to ${SITE.name}.`,
};

export default async function LoginPage() {
  await redirectIfSignedIn();
  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to keep creating."
      below={
        <p>
          New here?{" "}
          <Link href="/signup" className="ml-1 font-medium text-amber hover:text-gold-cream hover:underline">
            Create an account
          </Link>
        </p>
      }
    >
      <LoginForm />
      <p className="mt-5 text-center text-[13px] text-muted">
        Forgot your password?{" "}
        <Link href="/contact" className="transition-colors hover:text-gold-cream hover:underline">
          Contact the {SITE.name} team.
        </Link>
      </p>
    </AuthShell>
  );
}
