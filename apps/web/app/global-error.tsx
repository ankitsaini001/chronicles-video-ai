"use client";

import { ErrorScreen } from "@/components/ErrorScreen";
import { SITE } from "@/lib/site";
import { fontVariables } from "./fonts";
import "./globals.css";

// Last-resort error page, only when the root layout itself fails. It replaces the root layout, so
// it brings its own <html>, <body>, styles and fonts (Next.js docs: global-error).

export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>
        <title>{`Something went wrong · ${SITE.name}`}</title>
        <main className="flex min-h-dvh flex-col">
          <ErrorScreen retry={retry} />
        </main>
      </body>
    </html>
  );
}
