import type { CaptionTrackWord } from "@bytereel/pipeline/contracts";

/**
 * The hook's big opening words (F22b, video style v4): up to 3 words that slam in over the hero
 * from the first frame. Pure (no React), tested in tests/hook-words.test.ts.
 *
 * They must read as a natural short unit, never a cut-off fragment ("Should your monthly…"):
 * - a short question or sentence, or words up to a comma ("Ever wondered why?", "Imagine,");
 * - or a natural opener ("Did you know…", "Have you ever…", "What if…").
 * Otherwise there are no slam words: the hook shows its title (the short question) from the first
 * frame instead, and the captions show every word.
 */

/** Openers that read as complete on their own, followed by "…". Lowercase, without punctuation. */
const NATURAL_OPENERS = [
  "did you know",
  "have you ever",
  "ever wondered",
  "what if",
  "imagine",
  "imagine this",
  "picture this",
  "guess what",
  "fun fact",
  "true or false",
  "quick question",
  "you know what",
  "think about it",
  "here's a secret",
];

const BREAK = /[.,?!;:…।]["')\]]?$/u;
const plain = (text: string) => text.toLowerCase().normalize("NFC").replace(/[’‘]/gu, "'").replace(/[^\p{L}\p{M}\p{N}' ]/gu, "");

export interface HookSlam {
  /** The slam words (empty: show the title from the first frame instead). */
  slam: CaptionTrackWord[];
  /** Frame at which the captions take over (the next word), 0 when there are no slam words. */
  end: number;
}

export function hookSlam(words: readonly CaptionTrackWord[], max = 3): HookSlam {
  let count = 0;
  const upTo = Math.min(max, words.length);
  for (let i = 0; i < upTo; i++) {
    if (BREAK.test(words[i]!.text)) {
      count = i + 1;
      break;
    }
  }
  if (!count) {
    for (let n = upTo; n >= 1 && !count; n--) {
      if (NATURAL_OPENERS.includes(plain(words.slice(0, n).map((w) => w.text).join(" ")))) count = n;
    }
  }
  if (!count) return { slam: [], end: 0 };
  const slam = words.slice(0, count);
  const next = words[count];
  return { slam, end: next ? next.startFrame : slam[slam.length - 1]!.endFrame + 6 };
}

/** Frames before this are shown by the hook's slam words, so the captions skip them (0: skip nothing). */
export function hookCaptionStart(words: readonly CaptionTrackWord[]): number {
  return hookSlam(words).end;
}
