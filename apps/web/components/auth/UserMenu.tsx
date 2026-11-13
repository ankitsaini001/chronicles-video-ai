"use client";

import Link from "next/link";
import { Icon } from "@/components/ui";
import { usePopover } from "@/components/ui/usePopover";
import { LogoutButton } from "./LogoutButton";

// The signed-in user's menu. Two looks for the button:
// - "name" (public header, F09): a round initial + the name (shortened with "…" when long) + chevron
// - "avatar" (app shell top bar, F11): only the round initial, like the Stitch "My videos" design
// Clicking it opens a small panel with the full name, the email, "My videos" and "Log out".
// Escape or a click outside closes it. The name is plain text (React escapes it).

type UserMenuProps = { name: string; email: string; variant?: "name" | "avatar" };

/** First letter of the name (a whole character, also for emoji or Devanagari), upper case. */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : "?";
}

const itemClass =
  "flex min-h-11 w-full cursor-pointer items-center rounded-xl px-3 text-left text-sm text-text transition hover:bg-surface-2 disabled:opacity-50";

export function UserMenu({ name, email, variant = "name" }: UserMenuProps) {
  const { open, setOpen, toggle, wrapperRef, buttonRef, panelId } = usePopover();

  return (
    <div ref={wrapperRef} className="relative">
      {variant === "avatar" ? (
        <button
          ref={buttonRef}
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex size-11 cursor-pointer items-center justify-center rounded-full"
        >
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-full border border-amber/25 bg-[#261a10] font-display text-sm font-bold text-amber-light shadow-[0_0_10px_#f5a52426] transition hover:border-amber/50"
          >
            {initialOf(name)}
          </span>
          <span className="sr-only">Account menu for {name}</span>
        </button>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          onClick={toggle}
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
      )}
      {/* Always in the page (hidden while closed), so aria-controls points at a real element. */}
      <div id={panelId} hidden={!open} className="absolute right-0 z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-2 shadow-card">
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
    </div>
  );
}
