import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/AuthShell";
import { getAuth } from "@/lib/auth/server";

// TEMPORARY placeholder (F08). Sign-up lands here. It reads the session on the server and shows
// who is signed in. F11 replaces it with the app shell and "My videos".

export const metadata: Metadata = { title: "My videos" };

export default async function DashboardPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  // Not signed in. TODO(F09): send to /login once the login page exists.
  if (!session) redirect("/signup");

  return (
    <AuthShell title="You're in" subtitle={<>Signed in as <span className="font-medium text-text">{session.user.name}</span></>}>
      <p className="text-center text-sm text-muted">Your videos will appear here.</p>
      <p className="mt-4 text-center font-mono text-[11px] uppercase tracking-wider text-muted">Temporary page · My videos comes in F11</p>
    </AuthShell>
  );
}
