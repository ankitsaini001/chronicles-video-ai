"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

// Error page for signed-in pages: shown inside the app shell (the top bar stays), in place of the
// page that failed. `retry` (Next.js 16.3+) loads that page again from the server.
// Errors in app/(app)/layout.tsx itself are caught one level up, by app/error.tsx.

export default function AppError({ retry }: { error: unknown; retry: () => void }) {
  return <ErrorScreen retry={retry} />;
}
