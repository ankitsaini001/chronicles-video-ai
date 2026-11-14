"use client";

import { useEffect, useState } from "react";
import { Icon, cn } from "@/components/ui";
import { usePopover } from "@/components/ui/usePopover";
import { apiSend } from "./client";

// "Version 3 ▾" (F17; Stitch "Step 2 Storyboard"): the storyboard's versions, newest first (D1),
// loaded when the menu opens. The current one is marked; any other can be restored (D7), which makes
// it current again (no new version, nothing is deleted). Keyboard: Tab through the list, Escape
// closes and returns to the button (usePopover).

type VersionItem = { id: string; versionNumber: number; source: string; isCurrent: boolean; isApproved: boolean; valid: boolean; createdAt: string };

const SOURCE_LABELS: Record<string, string> = {
  ai_plan: "First storyboard",
  ai_revision: "AI change",
  user_edit: "Your edit",
};

const itemClass = "flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition";

export function VersionMenu({
  projectId,
  versionNumber,
  disabled,
  onRestore,
}: {
  projectId: string;
  versionNumber: number;
  disabled: boolean;
  onRestore: (version: { id: string; versionNumber: number }) => void;
}) {
  const { open, setOpen, toggle, wrapperRef, buttonRef, panelId } = usePopover();
  const [items, setItems] = useState<VersionItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(cursor: string | null) {
    setLoading(true);
    setError(null);
    const answer = await apiSend<{ items: VersionItem[]; nextCursor: string | null }>("GET", `/api/v1/projects/${projectId}/plan-versions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    setLoading(false);
    if (!answer.ok) return setError(answer.message);
    setItems((old) => [...(cursor ? (old ?? []) : []), ...answer.json.items]);
    setNextCursor(answer.json.nextCursor);
  }

  useEffect(() => {
    if (open && items === null && !loading) void load(null);
    // Loads once per fresh menu: the screen starts over (new menu) after any change.
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-text transition hover:border-amber/40 disabled:pointer-events-none disabled:opacity-50"
      >
        Version {versionNumber}
        <span className="sr-only">: show all versions</span>
        <Icon name="chevron" className={cn("size-3.5 text-muted transition", open && "rotate-180")} />
      </button>
      <div id={panelId} hidden={!open} className="absolute right-0 z-50 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-2 shadow-card">
        <p className="px-3 pt-1 pb-2 font-mono text-[11px] tracking-wider text-muted uppercase">Versions</p>
        {items === null && loading && <p className="px-3 py-2 text-sm text-muted">Loading…</p>}
        {error && (
          <p role="alert" className="px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {items && (
          <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
            {items.map((v) => {
              const label = (
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-text">
                    Version {v.versionNumber}
                    {v.isCurrent && <span className="ml-2 text-xs text-amber">current</span>}
                  </span>
                  <span className="text-xs text-muted">
                    {SOURCE_LABELS[v.source] ?? v.source} · {new Date(v.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                    {v.isApproved && " · approved"}
                    {!v.valid && " · needs fixing"}
                  </span>
                </span>
              );
              return (
                <li key={v.id}>
                  {v.isCurrent ? (
                    <div className={cn(itemClass, "bg-surface-2")} aria-current="true">
                      {label}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={cn(itemClass, "cursor-pointer hover:bg-surface-2")}
                      onClick={() => {
                        setOpen(false);
                        onRestore({ id: v.id, versionNumber: v.versionNumber });
                      }}
                    >
                      {label}
                      <span className="shrink-0 text-xs font-medium text-amber">Restore</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {nextCursor && (
          <button type="button" onClick={() => void load(nextCursor)} disabled={loading} className={cn(itemClass, "cursor-pointer justify-center text-amber hover:bg-surface-2")}>
            {loading ? "Loading…" : "Show older versions"}
          </button>
        )}
      </div>
    </div>
  );
}
