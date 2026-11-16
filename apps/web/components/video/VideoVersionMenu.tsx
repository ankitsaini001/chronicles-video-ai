"use client";

import type { RenderSummaryResource } from "@bytereel/db";
import { useEffect, useState } from "react";
import { apiSend } from "@/components/storyboard/client";
import { Icon, cn } from "@/components/ui";
import { usePopover } from "@/components/ui/usePopover";

// "Video version N ▾" (F24; Stitch "Step 3 Review video"): every finished video of the project,
// newest first (F1), loaded each time the menu opens (so the thumbnail links are fresh). The project's
// video is marked "current"; the one on screen is marked "playing"; any other plays when chosen.
// Earlier videos are never deleted (PRD §6.0). Keyboard: Tab through the list, Escape closes and
// returns to the button (usePopover).

const itemClass = "flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition";

export function VideoVersionMenu({ projectId, shown, onChoose }: { projectId: string; shown: Pick<RenderSummaryResource, "id" | "renderNumber">; onChoose: (render: RenderSummaryResource) => void }) {
  const { open, setOpen, toggle, wrapperRef, buttonRef, panelId } = usePopover();
  const [items, setItems] = useState<RenderSummaryResource[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(cursor: string | null) {
    setLoading(true);
    setError(null);
    const answer = await apiSend<{ items: RenderSummaryResource[]; nextCursor: string | null }>("GET", `/api/v1/projects/${projectId}/renders?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    setLoading(false);
    if (!answer.ok) return setError(answer.message);
    setItems((old) => [...(cursor ? (old ?? []) : []), ...answer.json.items]);
    setNextCursor(answer.json.nextCursor);
  }

  useEffect(() => {
    if (open) void load(null);
    // Reloaded on every open: fresh 15-minute thumbnail links for the poster of the chosen video.
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-text transition hover:border-amber/40"
      >
        Video version {shown.renderNumber}
        <span className="sr-only">: show all video versions</span>
        <Icon name="chevron" className={cn("size-3.5 text-muted transition", open && "rotate-180")} />
      </button>
      <div id={panelId} hidden={!open} className="absolute left-0 z-50 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-2 shadow-card">
        <p className="px-3 pt-1 pb-2 font-mono text-[11px] tracking-wider text-muted uppercase">Video versions</p>
        {items === null && loading && <p className="px-3 py-2 text-sm text-muted">Loading…</p>}
        {error && (
          <p role="alert" className="px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {items && (
          <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
            {items.map((r) => {
              const playing = r.id === shown.id;
              const label = (
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-text">
                    Video version {r.renderNumber}
                    {r.isCurrent && <span className="ml-2 text-xs text-amber">current</span>}
                  </span>
                  <span className="text-xs text-muted">
                    {new Date(r.readyAt ?? r.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                    {r.durationMs !== null && ` · ${Math.round(r.durationMs / 1000)} s`}
                  </span>
                </span>
              );
              return (
                <li key={r.id}>
                  {playing || r.status !== "ready" ? (
                    <div className={cn(itemClass, playing && "bg-surface-2")} aria-current={playing ? "true" : undefined}>
                      {label}
                      {playing && <span className="shrink-0 text-xs text-muted">playing</span>}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={cn(itemClass, "cursor-pointer hover:bg-surface-2")}
                      onClick={() => {
                        setOpen(false);
                        buttonRef.current?.focus();
                        onChoose(r);
                      }}
                    >
                      {label}
                      <span className="shrink-0 text-xs font-medium text-amber">Play</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {nextCursor && (
          <button type="button" onClick={() => void load(nextCursor)} disabled={loading} className={cn(itemClass, "cursor-pointer justify-center text-amber hover:bg-surface-2")}>
            {loading ? "Loading…" : "Show older videos"}
          </button>
        )}
      </div>
    </div>
  );
}
