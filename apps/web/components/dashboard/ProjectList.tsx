"use client";

import type { ProjectSummaryResource } from "@bytereel/db";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { apiSend, CLIENT_MESSAGES } from "@/components/storyboard/client";
import { Button, cn, Input } from "@/components/ui";
import { usePopover } from "@/components/ui/usePopover";
import {
  cardActions,
  cardStatus,
  LANGUAGE_LABELS,
  PLACEHOLDER_BACKGROUNDS,
  projectHref,
  titleInitial,
  updatedLabel,
  VOICE_LABELS,
  type CardTone,
} from "@/lib/dashboard/cards";

// The My videos cards (F21; Stitch "My videos"). The page sends the first page from the server
// (same function as C1); "Load more" asks C1 for the next page with its cursor. Each card's ⋯ menu
// offers Rename (C4 `title`) and Archive (C5, after a confirm step). Both send the card's
// `stateVersion`, so a change made in another tab is never overwritten (409 → refresh).
// After a change the list updates in place; the page's data is also refreshed in the background.

type Props = {
  tab: string;
  initialItems: ProjectSummaryResource[];
  initialCursor: string | null;
  /** When the server made the page: the "Updated …" times are counted from it. */
  now: string;
  timeZone: string;
  emptyText: string;
};

type Dialog = { kind: "rename" | "archive"; id: string } | null;

const TONES: Record<CardTone, string> = {
  progress: "bg-progress-bg text-amber",
  warning: "bg-warning-bg text-warning",
  success: "bg-success-bg text-success",
  danger: "bg-danger-bg text-danger",
  muted: "bg-surface-2 text-muted",
};

export function ProjectList({ tab, initialItems, initialCursor, now, timeZone, emptyText }: Props) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  // New server data (a refresh after a change): start again from it (React "adjust state on prop change").
  const [seenNow, setSeenNow] = useState(now);
  if (seenNow !== now) {
    setSeenNow(now);
    setItems(initialItems);
    setCursor(initialCursor);
  }
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const menuButtons = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLUListElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  // The server data this list started from; a "Load more" answer for older data is ignored.
  const latestNow = useRef(now);
  useEffect(() => {
    latestNow.current = now;
  }, [now]);
  const current = dialog ? (items.find((i) => i.id === dialog.id) ?? null) : null;

  async function loadMore() {
    if (!cursor || loading) return;
    const startedFor = now;
    setLoading(true);
    setLoadError("");
    const answer = await apiSend<{ items: ProjectSummaryResource[]; nextCursor: string | null }>("GET", `/api/v1/projects?tab=${encodeURIComponent(tab)}&cursor=${encodeURIComponent(cursor)}`);
    setLoading(false);
    // The list was reset meanwhile (a refresh after a change): this page belongs to the old list.
    if (latestNow.current !== startedFor) return;
    if (!answer.ok) {
      setLoadError(answer.message);
      return;
    }
    // A card can't appear twice (e.g. one renamed meanwhile moved to the top).
    setItems((prev) => [...prev, ...answer.json.items.filter((n) => !prev.some((p) => p.id === n.id))]);
    setCursor(answer.json.nextCursor);
  }

  function closeDialog(focusId: string | null) {
    setDialog(null);
    const button = focusId ? menuButtons.current.get(focusId) : null;
    // After the dialog closes (next frame), put focus back where the creator was.
    // The card is gone (archived): the list, or the empty-tab line when it was the last card.
    requestAnimationFrame(() => (button?.isConnected ? button.focus() : (listRef.current ?? emptyRef.current)?.focus()));
  }

  function renamed(updated: { id: string; title: string; stateVersion: number; updatedAt: string }) {
    // Renaming counts as an update: the card moves to the top (newest-updated first).
    setItems((prev) => {
      const item = prev.find((p) => p.id === updated.id);
      return item ? [{ ...item, title: updated.title, stateVersion: updated.stateVersion, updatedAt: updated.updatedAt }, ...prev.filter((p) => p.id !== updated.id)] : prev;
    });
    setAnnouncement(`Renamed to "${updated.title}".`);
    closeDialog(updated.id);
  }

  function archived(item: ProjectSummaryResource) {
    const left = items.filter((p) => p.id !== item.id);
    setItems(left);
    setAnnouncement(`"${item.title}" was archived.`);
    closeDialog(null);
    // The last card of the tab: the server decides between the empty tab and the first-visit page.
    if (left.length === 0) router.refresh();
  }

  return (
    <>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {items.length === 0 ? (
        <p ref={emptyRef} tabIndex={-1} className="mx-auto max-w-md py-16 text-center text-base leading-relaxed text-muted outline-none">
          {emptyText}
        </p>
      ) : (
        <ul ref={listRef} tabIndex={-1} aria-label="Your videos" className="grid grid-cols-1 gap-4 outline-none sm:grid-cols-3 sm:gap-6 lg:grid-cols-4">
          {items.map((item) => (
            <ProjectCard
              key={item.id}
              item={item}
              now={now}
              timeZone={timeZone}
              menuButtonRef={(el) => {
                if (el) menuButtons.current.set(item.id, el);
                else menuButtons.current.delete(item.id);
              }}
              onRename={() => setDialog({ kind: "rename", id: item.id })}
              onArchive={() => setDialog({ kind: "archive", id: item.id })}
            />
          ))}
        </ul>
      )}

      {(cursor || loadError) && (
        <div className="mt-8 flex flex-col items-center gap-3">
          {cursor && (
            <Button type="button" variant="secondary" onClick={() => void loadMore()} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          )}
          <p role="alert" className="text-sm text-danger empty:hidden">
            {loadError}
          </p>
        </div>
      )}

      <Modal open={dialog?.kind === "rename" && current !== null} onClose={() => closeDialog(dialog?.id ?? null)} title="Rename video">
        {current && <RenameForm key={current.id} item={current} onDone={renamed} onCancel={() => closeDialog(current.id)} onStale={() => router.refresh()} />}
      </Modal>
      <Modal open={dialog?.kind === "archive" && current !== null} onClose={() => closeDialog(dialog?.id ?? null)} title="Archive this video?">
        {current && <ArchiveForm key={current.id} item={current} onDone={() => archived(current)} onCancel={() => closeDialog(current.id)} onStale={() => router.refresh()} />}
      </Modal>
    </>
  );
}

function ProjectCard({
  item,
  now,
  timeZone,
  menuButtonRef,
  onRename,
  onArchive,
}: {
  item: ProjectSummaryResource;
  now: string;
  timeZone: string;
  menuButtonRef: (el: HTMLButtonElement | null) => void;
  onRename: () => void;
  onArchive: () => void;
}) {
  const status = cardStatus(item);
  const language = LANGUAGE_LABELS[item.language];
  const actions = cardActions(item);
  const titleLang = item.language === "hi" ? "hi" : undefined;

  return (
    <li className="relative flex gap-4 rounded-2xl border border-line bg-surface p-3 shadow-card transition-colors hover:border-amber/40 sm:flex-col sm:p-4">
      <Thumbnail item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <h2 lang={titleLang} className="pr-11 font-display text-base leading-snug font-bold break-words text-text sm:pr-0">
          {/* The link covers the whole card (after:inset-0); the ⋯ button sits above it. */}
          <Link
            href={projectHref(item)}
            className="line-clamp-2 outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-gold-cream"
          >
            {item.title}
          </Link>
        </h2>
        <ul aria-label="Language and voice" className="flex flex-wrap gap-2">
          <li lang={language.lang} className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 font-mono text-xs text-muted">
            {language.text}
          </li>
          <li className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 font-mono text-xs text-muted">{VOICE_LABELS[item.voiceGender]}</li>
        </ul>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pt-1">
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", TONES[status.tone])}>{status.label}</span>
          <time dateTime={item.updatedAt} className="font-mono text-[11px] tracking-wide text-muted">
            {updatedLabel(item.updatedAt, now, timeZone)}
          </time>
        </div>
      </div>
      {(actions.rename || actions.archive) && <CardMenu title={item.title} canArchive={actions.archive} buttonRef={menuButtonRef} onRename={onRename} onArchive={onArchive} />}
    </li>
  );
}

function Thumbnail({ item }: { item: ProjectSummaryResource }) {
  return (
    <div
      aria-hidden="true"
      className="relative flex aspect-[9/16] w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-amber/10 sm:w-full"
      style={{ background: PLACEHOLDER_BACKGROUNDS[item.language] }}
    >
      {item.thumbnailUrl ? (
        // A short-lived signed address (F23+): a plain <img>, nothing for Next.js to optimise.
        <img src={item.thumbnailUrl} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      ) : (
        <span lang={item.language === "hi" ? "hi" : undefined} className="font-display text-3xl font-extrabold text-amber/80 sm:text-6xl">
          {titleInitial(item.title)}
        </span>
      )}
    </div>
  );
}

function CardMenu({
  title,
  canArchive,
  buttonRef,
  onRename,
  onArchive,
}: {
  title: string;
  canArchive: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onRename: () => void;
  onArchive: () => void;
}) {
  const popover = usePopover();
  const choose = (action: () => void) => () => {
    popover.setOpen(false);
    action();
  };
  return (
    <div ref={popover.wrapperRef} className="absolute top-2 right-2 z-10 sm:top-3 sm:right-3">
      <button
        ref={(el) => {
          popover.buttonRef.current = el;
          buttonRef(el);
        }}
        type="button"
        onClick={popover.toggle}
        aria-expanded={popover.open}
        aria-controls={popover.panelId}
        aria-label={`More actions for "${title}"`}
        className="flex size-11 cursor-pointer items-center justify-center rounded-full bg-surface/80 text-muted transition-colors hover:bg-surface-2 hover:text-text sm:size-9"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 fill-current">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      <div id={popover.panelId} hidden={!popover.open} className="absolute right-0 mt-1 w-44 rounded-2xl border border-line bg-surface p-1.5 shadow-card">
        <ul className="flex flex-col gap-0.5">
          <li>
            <button type="button" onClick={choose(onRename)} className="flex min-h-11 w-full cursor-pointer items-center rounded-xl px-3 text-left text-sm text-text transition hover:bg-surface-2">
              Rename
            </button>
          </li>
          {canArchive && (
            <li>
              <button type="button" onClick={choose(onArchive)} className="flex min-h-11 w-full cursor-pointer items-center rounded-xl px-3 text-left text-sm text-danger transition hover:bg-surface-2">
                Archive
              </button>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

/** A small centred dialog (native <dialog>: focus stays inside, Escape closes it). */
function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        if (open) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-line bg-surface p-6 text-text shadow-card backdrop:bg-black/70"
    >
      <h2 id={titleId} className="mb-4 font-display text-xl font-bold text-text">
        {title}
      </h2>
      {children}
    </dialog>
  );
}

type FormProps = { item: ProjectSummaryResource; onCancel: () => void; onStale: () => void };

const TITLE_MAX = 120;

/** Problems a dialog shows. A change from another tab refreshes the list, then the creator tries again. */
function messageFor(answer: { code: string; message: string }, onStale: () => void): string {
  if (answer.code === "STALE_VERSION") {
    onStale();
    return "This video changed in another tab. We've loaded the latest version, please try again.";
  }
  if (answer.code === "NOT_FOUND") return "This video no longer exists. Please refresh the page.";
  return answer.message || CLIENT_MESSAGES.INTERNAL;
}

function RenameForm({ item, onDone, onCancel, onStale }: FormProps & { onDone: (p: { id: string; title: string; stateVersion: number; updatedAt: string }) => void }) {
  const [title, setTitle] = useState(item.title);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const id = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = title.replace(/\s+/g, " ").trim();
    if (!clean) {
      setError("Please enter a title.");
      return;
    }
    if (clean === item.title) {
      onCancel();
      return;
    }
    setSaving(true);
    setError("");
    const answer = await apiSend<{ id: string; title: string; stateVersion: number; updatedAt: string }>("PATCH", `/api/v1/projects/${item.id}`, { title: clean, expectedStateVersion: item.stateVersion });
    setSaving(false);
    if (answer.ok) onDone(answer.json);
    else setError(messageFor(answer, onStale));
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-6">
      <Input
        id={`${id}-title`}
        label="Video title"
        value={title}
        maxLength={TITLE_MAX}
        onChange={(e) => setTitle(e.target.value)}
        {...(error ? { error } : { helper: `Up to ${TITLE_MAX} characters.` })}
        {...(item.language === "hi" ? { lang: "hi" } : {})}
      />
      <div className="flex flex-wrap justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" arrow={false} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function ArchiveForm({ item, onDone, onCancel, onStale }: FormProps & { onDone: () => void }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function confirm() {
    setSaving(true);
    setError("");
    const answer = await apiSend("DELETE", `/api/v1/projects/${item.id}`, undefined, { "If-Match": `"${item.stateVersion}"` });
    setSaving(false);
    if (answer.ok) onDone();
    else setError(messageFor(answer, onStale));
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-[15px] leading-relaxed text-muted">
        <span lang={item.language === "hi" ? "hi" : undefined} className="font-medium text-text">
          “{item.title}”
        </span>{" "}
        will leave My videos. Nothing is deleted, and a saved link to it still opens, read-only.
      </p>
      <p role="alert" className="text-sm text-danger empty:hidden">
        {error}
      </p>
      <div className="flex flex-wrap justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" arrow={false} onClick={() => void confirm()} disabled={saving}>
          {saving ? "Archiving…" : "Archive"}
        </Button>
      </div>
    </div>
  );
}
