// The idea text rules shared by the server (C2 validation, projects.ts) and the Idea screen
// (IdeaForm counter and checks), so both count the same characters (F12 review).
// Pure code with no database import: the browser loads it via "@bytereel/db/idea-text".
//
// Cleaning order (API.md §2): remove control characters (except tab, line feed and carriage
// return), Unicode NFC, then trim. NFC matters for Hindi: the nukta letters क़ ख़ ग़ ज़ ड़ ढ़ फ़ य़
// (U+0958–U+095F) become two characters each under NFC, so counting before NFC would be wrong.

/** Notes may be up to 5,000 characters (API.md C2). */
export const IDEA_MAX_CHARS = 5000;
/** Up to 300 characters the idea is sent as a "topic", above that as "notes" (one box, PRD §6.1). */
export const IDEA_TOPIC_MAX_CHARS = 300;
/** A topic needs at least 3 characters. */
export const IDEA_MIN_CHARS = 3;

/** Control characters (Unicode Cc) other than tab, line feed and carriage return. */
const CONTROL_CHARS = /(?![\t\n\r])\p{Cc}/gu;

/** The idea as the server stores and counts it. */
export function cleanIdeaText(raw: string): string {
  return raw.replace(CONTROL_CHARS, "").normalize("NFC").trim();
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
