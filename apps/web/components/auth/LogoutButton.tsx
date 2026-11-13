"use client";

import { useState, type ReactNode } from "react";

// Log out (docs/API.md A3): deletes this session on the server, then a full page load of the home
// page, so nothing from the signed-in page stays on screen or in the browser's page cache.
// "No session" (401) also ends on the home page: the person is logged out either way.

type LogoutButtonProps = { className?: string; children?: ReactNode };

export function LogoutButton({ className, children = "Log out" }: LogoutButtonProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function logOut() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      if (response.ok || response.status === 401) {
        window.location.assign("/");
        return;
      }
    } catch {
      // Network problem: fall through to the message.
    }
    setBusy(false);
    setFailed(true);
  }

  return (
    <>
      <button type="button" onClick={logOut} disabled={busy} aria-busy={busy} className={className}>
        {busy ? "Logging out…" : children}
      </button>
      {failed && (
        <p role="alert" className="mt-2 text-center text-xs text-danger">
          Couldn&apos;t log out. Check your connection and try again.
        </p>
      )}
    </>
  );
}
