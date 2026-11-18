import { DEFAULT_TIMEZONE, isValidTimezone } from "./usage";

// F27: the words the creator reads when a limit stops a video (docs/API.md §10.1, §10.2, D8, E2).
// ONE place for them. The SERVER builds the full sentence (it knows the creator's timezone) and
// sends it as the error `message`; the numbers stay in `details`. Every screen shows `message` as is:
// D8/E2 refusals, the storyboard's pre-check before Approve, and a video job that hits a limit.
// Pure code with no database import: the browser loads it via "@bytereel/db/limit-messages" (the
// Idea page's reset time uses `resetClock`).
// Numbers and dates are written the Indian-English way, like the rest of the app: 1,050 and
// "1 December"; times as "12:00 am".

const LOCALE = "en-IN";

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
 * Videos per day (decision 1): "You've made 3 videos today, the most for one day. You can make more
 * after 12:00 am (midnight) your time." The day always ends at midnight in the creator's timezone
 * (in the few zones whose clocks jump forward at midnight it ends at the jump, e.g. "1:00 am").
 */
export function videosPerDayMessage(input: { limit: number; resetsAt: Date; timezone: string }): string {
  const clock = resetClock(input.resetsAt, input.timezone);
  const when = clock === "12:00 am" ? "12:00 am (midnight)" : clock;
  return `You've made ${number(input.limit)} videos today, the most for one day. You can make more after ${when} your time.`;
}

/**
 * The creator's own monthly voice characters (decision 1): "This video needs about 1,050 voice
 * characters, but you have 794 left this month. The limit resets on 1 December."
 */
export function voiceQuotaMessage(input: { needed: number; used: number; limit: number; resetsAt: Date; timezone: string }): string {
  const left = Math.max(0, input.limit - input.used);
  return `This video needs about ${number(input.needed)} voice characters, but you have ${number(left)} left this month. The limit resets on ${resetDate(input.resetsAt, input.timezone)}.`;
}

/**
 * The app's monthly voice characters, shared by everyone (decision 1): "Video making is paused for
 * everyone until 1 December (the app's monthly voice limit is used up). Your videos and downloads
 * still work." The app's month is a UTC month; the date is the day it ends in the creator's timezone.
 */
export function voiceCeilingMessage(input: { resetsAt: Date; timezone: string }): string {
  return `Video making is paused for everyone until ${resetDate(input.resetsAt, input.timezone)} (the app's monthly voice limit is used up). Your videos and downloads still work.`;
}

/** The short reason next to a greyed-out Approve button (the full sentence is in the note above it). */
export function limitShortReason(refusal: { code: string; details?: Record<string, unknown> | undefined }): string {
  if (refusal.code === "SPEND_CEILING") return "Video making is paused for everyone.";
  if (refusal.details?.quota === "videos_per_day") return "No videos left today.";
  return "Not enough voice characters left this month.";
}
