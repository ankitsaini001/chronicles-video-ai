import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignUpForm } from "@/components/auth/SignUpForm";
import { SITE } from "@/lib/site";

// Sign up (F08, Stitch "Sign up"). Only invited emails can create an account (docs/API.md A1).

export const metadata: Metadata = {
  title: "Sign up",
  description: `Create your ${SITE.name} account. ${SITE.name} is in private beta.`,
};

export default function SignUpPage() {
  return (
    <AuthShell
      title="Create your account"
      subtitle={`${SITE.name} is in private beta. Use the email you were invited with.`}
      below={
        <p>
          Already have an account?{" "}
          <Link href="/login" className="ml-1 font-medium text-amber hover:text-gold-cream hover:underline">
            Log in
          </Link>
        </p>
      }
    >
      <SignUpForm />
    </AuthShell>
  );
}
