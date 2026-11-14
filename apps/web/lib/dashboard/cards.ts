import type { ProjectSummaryResource } from "@bytereel/db";

// What a "My videos" card shows (F21; Stitch "My videos"). Plain functions (no React, no
// database), shared by the page (server) and the card list (browser), so both render the same text.

export type CardTone = "progress" | "warning" | "success" | "danger" | "muted";
export type CardStatus = { label: string; tone: CardTone };

type StatusInput = Pick<ProjectSummaryResource, "state" | "activeJobType" | "storyboardApproved">;

/** A plain-language status for the card's pill. "…" = work is running right now. */
export function cardStatus(p: StatusInput): CardStatus {
  switch (p.state) {
    case "draft":
      return { label: "Idea saved", tone: "muted" };
    case "planning":
      return { label: "Writing storyboard…", tone: "progress" };
    case "plan_failed":
      return { label: "Storyboard failed", tone: "danger" };
    case "storyboard_ready":
      if (p.activeJobType === "revise") return { label: "Updating storyboard…", tone: "progress" };
      return p.storyboardApproved ? { label: "Approved", tone: "success" } : { label: "Storyboard ready", tone: "warning" };
    case "generating":
      return { label: "Making video…", tone: "progress" };
    case "generate_failed":
      return { label: "Video failed", tone: "danger" };
    case "video_ready":
      return { label: "Video ready", tone: "success" };
    case "scheduled":
      return { label: "Scheduled", tone: "warning" };
    case "publishing":
      return { label: "Publishing…", tone: "progress" };
    case "published":
      return { label: "Published", tone: "success" };
    case "publish_failed":
      return { label: "Post failed", tone: "danger" };
    case "archived":
      return { label: "Archived", tone: "muted" };
  }
}

/** Where a card opens: the storyboard screen once a storyboard is ready, else the project page. */
export function projectHref(p: Pick<ProjectSummaryResource, "id" | "state">): string {
  return p.state === "storyboard_ready" ? `/projects/${p.id}/storyboard` : `/projects/${p.id}`;
}

/** Can the card offer Rename / Archive? Same rule as the server's allowedActions (no job running). */
export function cardActions(p: Pick<ProjectSummaryResource, "state" | "activeJobType">): { rename: boolean; archive: boolean } {
  const idle = p.activeJobType === null && p.state !== "archived";
  return { rename: idle, archive: idle && p.state !== "publishing" };
}

export const LANGUAGE_LABELS = {
  en: { text: "English", lang: undefined },
  hi: { text: "हिंदी", lang: "hi" },
  hinglish: { text: "Hinglish", lang: undefined },
} as const;

export const VOICE_LABELS = { female: "Female voice", male: "Male voice" } as const;

/**
 * "Updated …" relative to `now` (the time the page was made, so the server and the browser print
 * the same words). Older than a week: the date in the user's timezone ("12 Nov", with the year if
 * it isn't this year).
 */
export function updatedLabel(updatedAt: string, now: string, timeZone: string): string {
  const then = new Date(updatedAt);
  const seconds = Math.floor((new Date(now).getTime() - then.getTime()) / 1000);
  if (seconds < 60) return "Updated just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 2) return "Updated yesterday";
  if (days < 7) return `Updated ${days} days ago`;
  const year = (d: Date) => new Intl.DateTimeFormat("en-IN", { timeZone, year: "numeric" }).format(d);
  const sameYear = year(then) === year(new Date(now));
  return `Updated ${new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(then)}`;
}

/**
 * The big letter on the placeholder thumbnail: the title's first character with its marks (so a
 * Devanagari letter keeps its vowel sign). A plain rule rather than Intl.Segmenter, whose answer
 * for conjuncts differs between Node and browsers (the server and the browser must print the same).
 */
export function titleInitial(title: string): string {
  const first = /^\P{M}\p{M}*/u.exec(title.trim())?.[0];
  return first ? first.toLocaleUpperCase("en") : "?";
}

/** Placeholder thumbnail background per language (warm Ember Gold tints), until real thumbnails exist (F23). */
export const PLACEHOLDER_BACKGROUNDS = {
  en: "linear-gradient(160deg, #4a2c10 0%, #1e1208 55%, #120c07 100%)",
  hi: "linear-gradient(160deg, #4a1c26 0%, #1e0c10 55%, #120c07 100%)",
  hinglish: "linear-gradient(160deg, #3d3a12 0%, #1a1708 55%, #120c07 100%)",
} as const;
