import type { ReactNode } from "react";
import { SiteFooter } from "@/components/home/SiteFooter";
import { SiteHeader } from "@/components/home/SiteHeader";

// Shared layout for /privacy and /terms (F37 part 1). No Stitch design: the home page's header,
// footer and text styles, like the Contact page.

export function LegalPage({
  eyebrow,
  title,
  updated,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  updated: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <SiteHeader />
      <main className="bg-atmosphere border-b border-line">
        <article className="mx-auto max-w-3xl px-4 py-16 sm:px-6 md:py-24">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.12em] text-amber">{eyebrow}</p>
          <h1 className="mt-3 text-4xl font-extrabold sm:text-5xl">{title}</h1>
          <p className="mt-4 font-mono text-xs uppercase tracking-[0.08em] text-muted">Last updated: {updated}</p>
          <div className="mt-6 text-base leading-relaxed text-muted sm:text-lg">{intro}</div>
          <div className="mt-12 space-y-12">{children}</div>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="font-display text-2xl font-bold text-text">{title}</h2>
      <div className="mt-4 space-y-4 text-base leading-relaxed text-muted [&_a]:font-medium [&_a]:text-text [&_a:hover]:text-gold-cream [&_a]:underline [&_li]:pl-1 [&_strong]:font-semibold [&_strong]:text-text [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
        {children}
      </div>
    </section>
  );
}
