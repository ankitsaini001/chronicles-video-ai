import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { LogoutButton } from "@/components/auth/LogoutButton";
import { requireUser } from "@/lib/auth/session";

// TEMPORARY placeholder (F08/F09). Sign-up and log in land here. It reads the session on the server
// and shows who is signed in, with a Log out button; signed out → /login. F11 replaces it with the
// app shell and "My videos".

export const metadata: Metadata = { title: "My videos" };

export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <AuthShell
      title="You're in"
      subtitle={
        <>
          Signed in as <span className="break-words font-medium text-text">{user.name}</span>
        </>
      }
    >
      <p className="text-center text-sm text-muted">Your videos will appear here.</p>
      <div className="mt-6">
        <LogoutButton className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-full border border-line px-6 py-3 text-[15px] font-bold text-text transition hover:border-amber/40 hover:bg-surface-2 disabled:opacity-50" />
      </div>
      <p className="mt-4 text-center font-mono text-[11px] uppercase tracking-wider text-muted">Temporary page · My videos comes in F11</p>
    </AuthShell>
  );
}
