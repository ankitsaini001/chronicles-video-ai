"use client";

import { useEffect, useId, useRef, useState } from "react";

// Open/close logic for a small panel under a button (account menu, notifications).
// Closes on: a click outside, Escape (focus goes back to the button), and keyboard focus moving
// to something outside (e.g. pressing Tab past "Log out").

/**
 * Should a `focusout` close the panel? Only when focus moves to a real element outside it.
 * `null` (focus went nowhere, e.g. a click on plain text inside the panel, or the window lost
 * focus) keeps it open: clicks outside are handled by the pointer listener.
 */
export function focusLeftPopover(wrapper: Pick<Node, "contains"> | null, next: EventTarget | null): boolean {
  if (!wrapper || !next || !isNode(next)) return false;
  return !wrapper.contains(next);
}

function isNode(value: EventTarget): value is Node {
  return typeof (value as Partial<Node>).nodeType === "number";
}

export function usePopover() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const wrapper = wrapperRef.current;
    function onPointer(event: PointerEvent) {
      if (!wrapper?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onFocusOut(event: FocusEvent) {
      if (focusLeftPopover(wrapper, event.relatedTarget)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    wrapper?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      wrapper?.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  return { open, setOpen, toggle: () => setOpen((v) => !v), wrapperRef, buttonRef, panelId };
}
