import type { Metadata } from "next";
import { SiteFooter } from "@/components/home/SiteFooter";
import { SiteHeader } from "@/components/home/SiteHeader";
import { Button, Card } from "@/components/ui";
import { CONTACT_EMAIL } from "@/lib/site";

// Contact page (F03). No Stitch design; built from the home page's parts and brand tokens.
// The email address is a dummy for now (see lib/site.ts).

export const metadata: Metadata = {
  title: "Contact",
  description: "Questions, feedback or beta access? Email the ByteReel team.",
};

export default function ContactPage() {
  return (
    <>
      <SiteHeader />
      <main className="bg-atmosphere border-b border-line">
        <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6 md:py-24">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-amber">Contact</p>
          <h1 className="mt-3 text-4xl font-extrabold sm:text-5xl">
            Get in <span className="text-gradient-gold">touch</span>
          </h1>
          <p className="mt-6 text-base leading-relaxed text-muted sm:text-lg">
            Questions, feedback or want to join the private beta? Send us an email and we&apos;ll get back to you.
          </p>
          <Card className="mt-10">
            <p className="font-mono text-xs uppercase tracking-[0.08em] text-muted">Email</p>
            <p className="mt-2 font-display text-xl font-bold break-all">{CONTACT_EMAIL}</p>
            <div className="mt-6">
              <Button href={`mailto:${CONTACT_EMAIL}`}>Email us</Button>
            </div>
          </Card>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
