import { BRAINSTORM_LIMITS } from "./idea-text";

// Per-user product limits (docs/API.md §10.1, DATABASE.md §4.14 `usageCounters`) and the
// day / month periods they are counted in. ONE place for the numbers: the header pill
// ("Videos today: 0 of 3"), GET /api/v1/me (B1) and, later, the counting (F12) and the
// enforcement (F27) all read them from here. From F27 the admin can change them in `settings`;
// these stay the defaults.

export const USAGE_LIMITS = {
  /** Accepted `generate` jobs per user per day (caption fixes and retries don't count). */
  videosPerDay: 3,
  /** Projects created per user per day. */
  projectsPerDay: 5,
  /** ElevenLabs narration characters per user per calendar month. */
  voiceCharactersPerMonth: 3000,
  /** C7 "Brainstorm with AI" requests per user per day (plus 10 per hour, API_RATE_LIMITS; F14). */
  brainstormsPerDay: BRAINSTORM_LIMITS.perDay,
} as const;

/** Every user starts in this timezone (API.md §2); also the fallback for an unknown zone. */
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

/** True for a timezone name this server knows (e.g. "Asia/Kolkata"). */
export function isValidTimezone(timezone: string): boolean {
  if (typeof timezone !== "string" || timezone === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export interface UsagePeriods {
  /** Today in the user's timezone, e.g. "2026-11-13" (`usageCounters.period` for videos/projects). */
  day: string;
  /** This month in the user's timezone, e.g. "2026-11" (`usageCounters.period` for voiceChars). */
  month: string;
  /** Next midnight in the user's timezone, as a UTC instant (when the daily limits reset). */
  dayResetsAt: Date;
  /** 00:00 on the 1st of next month in the user's timezone (when the monthly limit resets). */
  monthResetsAt: Date;
}

/**
 * The current day and month for this user and when each one ends. An unknown timezone falls back to
 * Asia/Kolkata. Example: 2026-11-13T10:00Z in Asia/Kolkata → day "2026-11-13", resets
 * 2026-11-13T18:30:00.000Z; month "2026-11", resets 2026-11-30T18:30:00.000Z.
 */
export function usagePeriods(timezone: string, now: Date = new Date()): UsagePeriods {
  const zone = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const { year, month, day } = localDate(now, zone);
  return {
    day: `${year}-${pad(month)}-${pad(day)}`,
    month: `${year}-${pad(month)}`,
    // Date.UTC rolls over (day 32 → next month, month 13 → next year).
    dayResetsAt: localMidnightToUtc(year, month, day + 1, zone),
    monthResetsAt: localMidnightToUtc(year, month + 1, 1, zone),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Calendar date of `instant` in `zone`. */
function localDate(instant: Date, zone: string): { year: number; month: number; day: number } {
  const parts = partsIn(instant, zone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function partsIn(instant: Date, zone: string): Record<"year" | "month" | "day" | "hour" | "minute" | "second", number> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatter.formatToParts(instant)) {
    if (part.type in out) out[part.type as keyof typeof out] = Number(part.value);
  }
  return out;
}

/** How far `zone` is ahead of UTC at `instant`, in milliseconds (Kolkata: +5:30). */
function offsetMs(instant: number, zone: string): number {
  const p = partsIn(new Date(instant), zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The UTC instant when year-month-day starts in `zone` (month 1–12; overflow rolls over).
 * Normally that is 00:00 local time: the offset is looked up twice so a daylight-saving change
 * near midnight still gives the right offset. In zones where the clocks jump forward AT midnight
 * (e.g. America/Santiago, America/Havana: 00:00 → 01:00), 00:00 never happens that day; the day
 * then starts at the moment of the jump (01:00 new time), which is 00:00 at the offset from
 * before the change.
 */
function localMidnightToUtc(year: number, month: number, day: number, zone: string): Date {
  const wallClock = Date.UTC(year, month - 1, day);
  let guess = wallClock - offsetMs(wallClock, zone);
  guess = wallClock - offsetMs(guess, zone);
  // The day the guess falls on, as a UTC date number, compared with the wanted day.
  const local = localDate(new Date(guess), zone);
  if (Date.UTC(local.year, local.month - 1, local.day) < wallClock) {
    // Midnight was skipped: use the offset from the day before (before the jump).
    guess = wallClock - offsetMs(wallClock - 86_400_000, zone);
  }
  return new Date(guess);
}
