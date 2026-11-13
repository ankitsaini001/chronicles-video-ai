import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { requireUser } from "@/lib/auth/session";

// TEMPORARY placeholder (F08). Sign-up and log in land here. It reads the session on the server
// and shows who is signed in; signed out → /login. F11 replaces it with the app shell and "My videos".

export const metadata: Metadata = { title: "My videos" };

export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <AuthShell title="You're in" subtitle={<>Signed in as <span className="font-medium text-text">{user.name}</span></>}>
      <p className="text-center text-sm text-muted">Your videos will appear here.</p>
      <p className="mt-4 text-center font-mono text-[11px] uppercase tracking-wider text-muted">Temporary page · My videos comes in F11</p>
    </AuthShell>
  );
}
