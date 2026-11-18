import { DEFAULT_TIMEZONE, isValidTimezone } from "./usage";

// F27: the words the creator reads when a limit stops them (docs/API.md §10.1, §10.2, C2, D8, E2).
// ONE place for them. The SERVER builds the full sentence (it knows the creator's timezone) and
// sends it as the error `message`; the numbers stay in `details`. Every screen shows `message` as is:
// C2/D8/E2 refusals, the storyboard's pre-check before Approve, and a video job that hits a limit.
// Pure code with no database import (safe for the browser too).
// Numbers and dates are written the Indian-English way, like the rest of the app: 1,050 and
// "1 December"; times as "12:00 am".

const LOCALE = "en-IN";
const MIDNIGHT = "12:00 am";

const zoneOf = (timezone: string) => (isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE);
const number = (value: number) => Math.max(0, Math.round(value)).toLocaleString(LOCALE);

/** The time of day `instant` is in `timezone`: "12:00 am" (with `zoneName`: "12:00 am IST"). */
export function resetClock(instant: Date, timezone: string, options: { zoneName?: boolean } = {}): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: zoneOf(timezone), hour: "numeric", minute: "2-digit", ...(options.zoneName ? { timeZoneName: "short" } : {}) }).format(instant);
}

/** The calendar day `instant` is in `timezone`: "1 December". */
export function resetDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: zoneOf(timezone), day: "numeric", month: "long" }).format(instant);
}

/**
 * When a daily limit resets: "12:00 am (midnight)". The day always ends at midnight in the creator's
 * timezone, except in the few zones whose clocks jump forward at midnight (it then ends at the
 * jump, e.g. "1:00 am").
 */
function dayResetText(resetsAt: Date, timezone: string): string {
  const clock = resetClock(resetsAt, timezone);
  return clock === MIDNIGHT ? `${MIDNIGHT} (midnight)` : clock;
}

/**
 * Videos per day (decision 1): "You've made 3 videos today, the most for one day. You can make more
 * after 12:00 am (midnight) your time."
 */
export function videosPerDayMessage(input: { limit: number; resetsAt: Date; timezone: string }): string {
  return `You've made ${number(input.limit)} videos today, the most for one day. You can make more after ${dayResetText(input.resetsAt, input.timezone)} your time.`;
}

/**
 * Projects per day (C2; founder 2026-11-18, the same wording as videos): "You've created 5 projects
 * today, the most for one day. You can create more after 12:00 am (midnight) your time."
 */
export function projectsPerDayMessage(input: { limit: number; resetsAt: Date; timezone: string }): string {
  return `You've created ${number(input.limit)} projects today, the most for one day. You can create more after ${dayResetText(input.resetsAt, input.timezone)} your time.`;
}

/**
 * The creator's own monthly voice characters (decision 1): "This video needs about 1,050 voice
 * characters, but you have 794 left this month. The limit resets on 1 December." Their month ends
 * at local midnight, so the date alone is exact.
 */
export function voiceQuotaMessage(input: { needed: number; used: number; limit: number; resetsAt: Date; timezone: string }): string {
  const left = Math.max(0, input.limit - input.used);
  return `This video needs about ${number(input.needed)} voice characters, but you have ${number(left)} left this month. The limit resets on ${resetDate(input.resetsAt, input.timezone)}.`;
}

/**
 * The creator's own limit when the exact number isn't known (a single request refused while
 * recording): "You don't have enough voice characters left this month for this video. The limit
 * resets on 1 December."
 */
export function voiceQuotaShortMessage(input: { resetsAt: Date; timezone: string }): string {
  return `You don't have enough voice characters left this month for this video. The limit resets on ${resetDate(input.resetsAt, input.timezone)}.`;
}

/**
 * The app's monthly voice characters, shared by everyone (decision 1): "Video making is paused for
 * everyone until 1 December (the app's monthly voice limit is used up). Your videos and downloads
 * still work." The app's month is a UTC month: unless it ends at midnight in the creator's timezone
 * the time is added, so the day named isn't still paused ("until 1 December, 5:30 am your time" in
 * India, "until 30 November, 7:00 pm your time" in New York).
 */
export function voiceCeilingMessage(input: { resetsAt: Date; timezone: string }): string {
  const clock = resetClock(input.resetsAt, input.timezone);
  const when = clock === MIDNIGHT ? resetDate(input.resetsAt, input.timezone) : `${resetDate(input.resetsAt, input.timezone)}, ${clock} your time`;
  return `Video making is paused for everyone until ${when} (the app's monthly voice limit is used up). Your videos and downloads still work.`;
}

/** The short reason next to a greyed-out Approve button (the full sentence is in the note above it). */
export function limitShortReason(refusal: { code: string; details?: Record<string, unknown> | undefined }): string {
  if (refusal.code === "SPEND_CEILING") return "Video making is paused for everyone.";
  if (refusal.details?.quota === "videos_per_day") return "No videos left today.";
  return "Not enough voice characters left this month.";
}
