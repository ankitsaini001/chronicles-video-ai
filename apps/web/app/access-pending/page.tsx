import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui";
import { redirectIfSignedIn } from "@/lib/auth/session";
import { requestAccessHref } from "@/lib/request-access";
import { SITE } from "@/lib/site";

// Access pending (F10, Stitch "Access pending", docs/design/stitch/access-pending.html).
// Sign-up sends people whose email isn't on the invite list here (SignUpForm, 403 NOT_ALLOWLISTED).
// Signed-in users have nothing to wait for → My videos.

export const metadata: Metadata = {
  title: "Access pending",
  description: `${SITE.name} is in private beta. Request access and the team will get back to you.`,
};

function EnvelopeClockIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-12 text-amber"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 48 48"
    >
      <rect height="26" rx="4" width="36" x="6" y="10" />
      <path d="M6 14l18 13 18-13" />
      <circle cx="35" cy="33" r="8" className="fill-surface" />
      <path d="M35 29v4l2.5 2" />
    </svg>
  );
}

export default async function AccessPendingPage() {
  await redirectIfSignedIn();
  return (
    <AuthShell
      icon={<EnvelopeClockIcon />}
      title={`${SITE.name} is in private beta`}
      subtitle={`Your email isn't on the invite list yet. Request access and the ${SITE.name} team will get back to you.`}
    >
      <div className="flex flex-col gap-3">
        <Button href={requestAccessHref()} fullWidth>
          Request access
        </Button>
        <Button href="/" variant="secondary" fullWidth arrow={false}>
          Back to home
        </Button>
      </div>
      <p className="mt-6 text-center text-xs leading-relaxed text-muted">
        This opens your email app. You can also write to{" "}
        <a href={`mailto:${SITE.contactEmail}`} className="font-medium text-text hover:text-gold-cream hover:underline">
          {SITE.contactEmail}
        </a>
        .
      </p>
    </AuthShell>
  );
}
