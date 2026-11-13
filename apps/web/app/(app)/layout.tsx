import type { ReactNode } from "react";
import { AppHeader } from "@/components/app/AppHeader";
import { getMe } from "@/lib/account/me";
import { requireUser } from "@/lib/auth/session";

// Every signed-in page lives in this (app) folder (a "route group": the name in brackets is not
// part of the address, so /dashboard stays /dashboard). They all get the app top bar.
//
// Signed out (or a not-active account) → /login. Layouts don't re-run when you move between pages
// inside the app, so EVERY page in this folder must also call requireUser() itself (Next.js docs:
// "Layouts and auth checks"). Both reads share one database lookup per request (React cache).

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  // Same function as GET /api/v1/me (B1), so the pill, the bell and the API always agree.
  const me = await getMe(user);

  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip">
      <AppHeader user={{ name: me.name, email: me.email }} videosToday={me.usage.videosToday} unreadNotifications={me.unreadNotifications} />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pt-8 pb-16 sm:px-8 sm:pt-10 sm:pb-20">{children}</main>
    </div>
  );
}
