"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

// Error page for every page outside the app shell, and for errors in the app shell's own layout
// (e.g. the database can't be reached while checking the login). Rendered inside the root layout,
// so the brand fonts and colours apply.

export default function RootError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col">
      <ErrorScreen retry={retry} />
    </main>
  );
}
