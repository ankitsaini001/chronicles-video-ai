import type { Metadata } from "next";
import { Button } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";

// TEMPORARY placeholder (F11) so "Create your first reel" on My videos never leads to a 404.
// F12 replaces this page with Step 1 Idea (topic, language, voice → "Create storyboard").

export const metadata: Metadata = { title: "New video" };

export default async function NewProjectPage() {
  await requireUser();

  return (
    <section className="mx-auto flex max-w-lg flex-1 flex-col items-center justify-center text-center">
      <h1 className="mb-3 font-display text-3xl font-extrabold tracking-tight text-text">New video</h1>
      <p className="mb-8 text-base leading-relaxed text-muted">This is where you&apos;ll type your topic and pick a language and voice. It&apos;s coming next.</p>
      <Button href="/dashboard" variant="secondary">
        Back to My videos
      </Button>
      <p className="mt-6 font-mono text-[11px] uppercase tracking-wider text-muted">Temporary page · Step 1 Idea arrives in F12</p>
    </section>
  );
}
