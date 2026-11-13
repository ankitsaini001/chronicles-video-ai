"use client";

import { Icon } from "@/components/ui";
import { usePopover } from "@/components/ui/usePopover";

// The bell in the app top bar. Notifications arrive in F32; until then there is never a badge and
// clicking opens a small "No notifications yet" panel (nothing is loaded or changed).

export function NotificationsBell({ unread = 0 }: { unread?: number }) {
  const { open, toggle, wrapperRef, buttonRef, panelId } = usePopover();

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative flex size-11 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:text-text"
      >
        <Icon name="bell" className="size-5" />
        {unread > 0 && <span aria-hidden="true" className="absolute top-2.5 right-2.5 size-2 rounded-full bg-amber shadow-[0_0_8px_#f5a524]" />}
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-4 text-center shadow-card"
      >
        <p className="font-medium text-text">No notifications yet</p>
        <p className="mt-1 text-sm text-muted">We&apos;ll tell you here when a storyboard or video is ready.</p>
      </div>
    </div>
  );
}
