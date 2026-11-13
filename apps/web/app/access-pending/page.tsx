import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui";
import { SITE } from "@/lib/site";

// TEMPORARY placeholder (F08). Sign-up sends people whose email isn't invited here.
// F10 replaces this page with the Stitch "Access pending" design.

export const metadata: Metadata = { title: "Access pending" };

export default function AccessPendingPage() {
  return (
    <AuthShell
      title="Access pending"
      subtitle={`${SITE.name} is in private beta, and this email isn't on the invite list yet.`}
    >
      <p className="text-center text-sm text-muted">
        To ask for access, email us at <span className="font-medium text-text">{SITE.contactEmail}</span>.
      </p>
      <p className="mt-4 text-center font-mono text-[11px] uppercase tracking-wider text-muted">Temporary page · the full page comes in F10</p>
      <div className="mt-6">
        <Button href="/" variant="secondary" fullWidth arrow={false}>
          Back to home
        </Button>
      </div>
    </AuthShell>
  );
}
