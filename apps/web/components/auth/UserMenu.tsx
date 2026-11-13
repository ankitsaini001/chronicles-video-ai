"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/ui";
import { LogoutButton } from "./LogoutButton";

// Signed-in part of the header: a round initial + the user's name (shortened with "…" when long).
// Clicking it opens a small panel with the full name, the email, "My videos" and "Log out".
// Escape or a click outside closes it. The name is plain text (React escapes it).

type UserMenuProps = { name: string; email: string };

/** First letter of the name (a whole character, also for emoji or Devanagari), upper case. */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : "?";
}

const itemClass =
  "flex min-h-11 w-full cursor-pointer items-center rounded-xl px-3 text-left text-sm text-text transition hover:bg-surface-2 disabled:opacity-50";

export function UserMenu({ name, email }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-11 max-w-[11rem] cursor-pointer items-center gap-2 rounded-full border border-line py-1 pr-3 pl-1 text-sm text-text transition hover:border-amber/40 sm:max-w-[16rem]"
      >
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber font-bold text-on-amber">
          {initialOf(name)}
        </span>
        <span className="sr-only">Account menu for </span>
        <span className="min-w-0 truncate font-medium">{name}</span>
        <Icon name="chevron" className={`size-4 shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div id={panelId} className="absolute right-0 z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-2 shadow-card">
          <div className="border-b border-line px-3 pt-2 pb-3">
            <p className="font-mono text-[11px] uppercase tracking-wider text-muted">Signed in as</p>
            <p className="mt-1 break-words font-medium text-text">{name}</p>
            <p className="truncate text-xs text-muted">{email}</p>
          </div>
          <div className="pt-2">
            <Link href="/dashboard" className={itemClass} onClick={() => setOpen(false)}>
              My videos
            </Link>
            <LogoutButton className={itemClass} />
          </div>
        </div>
      )}
    </div>
  );
}
