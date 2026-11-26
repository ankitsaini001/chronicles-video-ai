// F31 "Schedule a post" (API.md H2 `mode: "scheduled"`, H5; founder decisions 2026-11-26): the
// schedule window, the 5-minute steps and the India-time (IST) words, shared by the server and the
// Step 4 schedule form (browser: "@bytereel/db/post-schedule"). Pure: no database import.
//
// - Window: at least 10 minutes and at most 7 days from now (Inngest's free plan sleeps at most 7
//   days in one go, and 7 days stays well inside the 60-day Instagram token).
// - Steps: the time must be on a 5-minute step (seconds 0). The server REFUSES a time that isn't
//   (it never rounds), so what was approved is exactly what is posted. India is UTC+5:30, so a
//   5-minute step in IST is also a 5-minute step in UTC.
// - Missed: a post that hasn't started publishing 1 hour after its time is never posted late.
// - Times are shown in IST everywhere: "Fri 28 Nov, 7:00 PM IST".

export const SCHEDULE_LIMITS = {
  /** The earliest time: now + 10 minutes. */
  minLeadMs: 10 * 60_000,
  /** The latest time: now + 7 days. */
  maxLeadMs: 7 * 24 * 60 * 60_000,
  /** The picker's step, and the server's alignment rule. */
  stepMinutes: 5,
  /** Up to this late the post still goes out; later → "missed", never posted. */
  missedAfterMs: 60 * 60_000,
} as const;

/** The zone every schedule is picked and shown in (founder decision 2). */
export const SCHEDULE_TIME_ZONE = "Asia/Kolkata";
/** India has no daylight saving: always UTC+5:30. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

export const SCHEDULE_MESSAGES = {
  TOO_SOON: "Pick a time at least 10 minutes from now.",
  TOO_LATE: "Pick a time within the next 7 days.",
  NOT_ON_STEP: "Pick a time on a 5-minute step (for example 7:00 or 7:05).",
  BAD_TIME: "Pick a date and time.",
  MISSED_REFUSED: "This post missed its time. Publish now or pick a new time.",
} as const;

/** ISO-8601 with an offset (`Z` or `+05:30`), seconds optional: what H2 accepts as `scheduledAt`. */
export const SCHEDULED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The instant of an H2 `scheduledAt`, or null when it isn't a valid ISO time with an offset. */
export function parseScheduledAt(text: string): Date | null {
  if (!SCHEDULED_AT_PATTERN.test(text)) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Why this time can't be scheduled now (the plain message), or null when it can. */
export function scheduleProblem(at: Date, now: Date): string | null {
  if (at.getUTCSeconds() !== 0 || at.getUTCMilliseconds() !== 0 || at.getUTCMinutes() % SCHEDULE_LIMITS.stepMinutes !== 0) return SCHEDULE_MESSAGES.NOT_ON_STEP;
  if (at.getTime() < now.getTime() + SCHEDULE_LIMITS.minLeadMs) return SCHEDULE_MESSAGES.TOO_SOON;
  if (at.getTime() > now.getTime() + SCHEDULE_LIMITS.maxLeadMs) return SCHEDULE_MESSAGES.TOO_LATE;
  return null;
}

/** Has a scheduled post that never started publishing missed its time (more than 1 hour late)? */
export function isScheduleMissed(scheduledAt: Date, now: Date): boolean {
  return now.getTime() > scheduledAt.getTime() + SCHEDULE_LIMITS.missedAfterMs;
}

/** The IST wall clock of an instant: date "YYYY-MM-DD" and time "HH:MM" (24 h), for the picker. */
export function istParts(at: Date): { date: string; time: string } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

/** The instant of an IST date ("YYYY-MM-DD") and time ("HH:MM"), or null when either is malformed. */
export function fromIstParts(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const at = new Date(`${date}T${time}:00+05:30`);
  return Number.isNaN(at.getTime()) || istParts(at).date !== date || istParts(at).time !== time ? null : at;
}

/** The ISO text H2 receives for an instant, written in IST: "2026-11-28T19:00:00+05:30". */
export function toIstIso(at: Date): string {
  const { date, time } = istParts(at);
  return `${date}T${time}:00+05:30`;
}

/** The first time the picker offers: now + 10 minutes, rounded UP to the next 5-minute step. */
export function earliestScheduleTime(now: Date): Date {
  const step = SCHEDULE_LIMITS.stepMinutes * 60_000;
  return new Date(Math.ceil((now.getTime() + SCHEDULE_LIMITS.minLeadMs) / step) * step);
}

/** The last time the picker offers: now + 7 days, rounded DOWN to a 5-minute step. */
export function latestScheduleTime(now: Date): Date {
  const step = SCHEDULE_LIMITS.stepMinutes * 60_000;
  return new Date(Math.floor((now.getTime() + SCHEDULE_LIMITS.maxLeadMs) / step) * step);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Parts of an instant on the IST wall clock (a fixed offset, so the server and the browser agree). */
function istClock(at: Date): { day: string; date: number; month: string; hour12: number; minute: string; ampm: "AM" | "PM" } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  const hours = shifted.getUTCHours();
  return {
    day: DAYS[shifted.getUTCDay()]!,
    date: shifted.getUTCDate(),
    month: MONTHS[shifted.getUTCMonth()]!,
    hour12: hours % 12 === 0 ? 12 : hours % 12,
    minute: String(shifted.getUTCMinutes()).padStart(2, "0"),
    ampm: hours < 12 ? "AM" : "PM",
  };
}

/** "7:00 PM IST" */
export function istTimeLabel(at: Date): string {
  const c = istClock(at);
  return `${c.hour12}:${c.minute} ${c.ampm} IST`;
}

/** "Fri 28 Nov, 7:00 PM IST" (founder: the same words everywhere). */
export function istDateTimeLabel(at: Date): string {
  const c = istClock(at);
  return `${c.day} ${c.date} ${c.month}, ${istTimeLabel(at)}`;
}

/** "Fri 28 Nov at 7:00 PM IST" (the approval line). */
export function istApprovalLabel(at: Date): string {
  const c = istClock(at);
  return `${c.day} ${c.date} ${c.month} at ${istTimeLabel(at)}`;
}

/** "Fri, 28 Nov 2026" (the DATE field's own words). */
export function istDateLabel(at: Date): string {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  const c = istClock(at);
  return `${c.day}, ${c.date} ${c.month} ${shifted.getUTCFullYear()}`;
}
