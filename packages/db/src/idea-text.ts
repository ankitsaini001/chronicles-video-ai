// The idea text rules shared by the server (C2 validation, projects.ts) and the Idea screen
// (IdeaForm counter and checks), so both count the same characters (F12 review).
// Pure code with no database import: the browser loads it via "@bytereel/db/idea-text".
//
// Cleaning order (API.md §2): remove control characters (except tab, line feed and carriage
// return) and invisible format characters (except ZWNJ/ZWJ, F14 review), Unicode NFC, then trim. NFC matters for Hindi: the nukta letters क़ ख़ ग़ ज़ ड़ ढ़ फ़ य़
// (U+0958–U+095F) become two characters each under NFC, so counting before NFC would be wrong.

/** Notes may be up to 5,000 characters (API.md C2). */
export const IDEA_MAX_CHARS = 5000;
/** Up to 300 characters the idea is sent as a "topic", above that as "notes" (one box, PRD §6.1). */
export const IDEA_TOPIC_MAX_CHARS = 300;
/** A topic needs at least 3 characters. */
export const IDEA_MIN_CHARS = 3;
/** C7 brainstorm limits per creator (founder, 2026-11-13). One place for the server and the screen. */
export const BRAINSTORM_LIMITS = { perHour: 10, perDay: 30 } as const;
/** C7 brainstorm subject: 2–100 characters, cleaned the same way (API.md C7, F14). */
export const BRAINSTORM_SUBJECT_LIMITS = { min: 2, max: 100 } as const;

/** Control characters (Unicode Cc) other than tab, line feed and carriage return. */
const CONTROL_CHARS = /(?![\t\n\r])\p{Cc}/gu;
/**
 * Invisible format characters (Unicode Cf: bidi overrides, zero-width space, BOM, soft hyphen …),
 * except ZWNJ/ZWJ (U+200C/U+200D), which Devanagari needs to choose the right letter shapes
 * (F14 review).
 */
const FORMAT_CHARS = /(?![\u200C\u200D])\p{Cf}/gu;

/** The idea as the server stores and counts it. */
export function cleanIdeaText(raw: string): string {
  return raw.replace(CONTROL_CHARS, "").replace(FORMAT_CHARS, "").normalize("NFC").trim();
}

/** "topic" up to 300 characters of cleaned text, "notes" above. */
export function ideaInputType(clean: string): "topic" | "notes" {
  return clean.length <= IDEA_TOPIC_MAX_CHARS ? "topic" : "notes";
}

/** What is wrong with the cleaned idea before sending, or null when it can be sent. */
export function ideaProblem(clean: string): "empty" | "too_short" | "too_long" | null {
  if (clean.length === 0) return "empty";
  if (clean.length < IDEA_MIN_CHARS) return "too_short";
  if (clean.length > IDEA_MAX_CHARS) return "too_long";
  return null;
}

/** Brainstorm idea text limits (C2 `inputType: "brainstorm"`): the chosen idea's title + hook. */
export const BRAINSTORM_TEXT_MAX_CHARS = 300;

/**
 * The idea-box text for a picked brainstorm idea (F14): "Title. Hook" (no extra full stop after
 * ., ?, ! or the Hindi danda ।), or only the title when both together would be over 300 characters.
 */
export function brainstormIdeaText(title: string, hook: string): string {
  const t = cleanIdeaText(title);
  const h = cleanIdeaText(hook);
  const joined = /[.?!।]$/u.test(t) ? `${t} ${h}` : `${t}. ${h}`;
  return joined.length <= BRAINSTORM_TEXT_MAX_CHARS ? joined : t;
}

/** True when this cleaned text can still be sent as the picked brainstorm idea (3–300 characters). */
export function fitsBrainstormText(clean: string): boolean {
  return clean.length >= IDEA_MIN_CHARS && clean.length <= BRAINSTORM_TEXT_MAX_CHARS;
}
