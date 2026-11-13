"use client";

import { Button } from "@/components/ui";

// What a page shows when something breaks on our side (API.md §4.3 INTERNAL wording).
// One button: "Try again" re-loads the part of the page that failed. No error details are shown
// (in production Next.js hides them anyway; the server log has them).

export const ERROR_MESSAGE = "Something went wrong on our side. Please try again.";

export function ErrorScreen({ retry }: { retry: () => void }) {
  return (
    <section role="alert" className="mx-auto flex max-w-lg flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <h1 className="mb-3 font-display text-3xl font-extrabold tracking-tight text-text">Sorry, that didn&apos;t work</h1>
      <p className="mb-8 text-base leading-relaxed text-muted">{ERROR_MESSAGE}</p>
      <Button onClick={() => retry()}>Try again</Button>
    </section>
  );
}
