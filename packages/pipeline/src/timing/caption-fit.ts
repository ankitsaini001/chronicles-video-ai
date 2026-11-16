import type { Caption } from "../contracts";
import { CAPTION_STYLE } from "../theme";
import { breakLines, type CaptionLayout } from "./captions";
import { estimateTextWidth } from "./text-width";

/**
 * Does a caption fix fit on screen? (F25; the same rule on the server, API F4, in the render, and in
 * the Captions tab before sending.) Pure, no Node or database code, so the browser can load it
 * (`@bytereel/pipeline/timing/caption-fit`).
 *
 * - No emoji (F25 review): the video's font has no emoji, so the browser draws them from a colour
 *   emoji font about twice as wide as the estimate can know. "Emoji can't be used in captions."
 * - The compiler's own line breaking (breakLines, the same width estimate) in at most 2 lines at the
 *   normal caption size (no shrinking, no splitting a long word), with every character the width
 *   table doesn't know counted as 1.0 em (the compiler uses 0.6), so this check is never more
 *   lenient than the browser.
 * - Each line must fit the caption box the way the renderer draws it (renderedLineWidth).
 * - (Server and render only, they know the timing:) no more words than the phrase has frames.
 */

/** The fixed caption's layout: the normal caption size, unknown characters at 1.0 em. */
export const CAPTION_FIX_LAYOUT: CaptionLayout = {
  fontSizePx: CAPTION_STYLE.fontSizePx,
  maxLineWidthPx: CAPTION_STYLE.maxLineWidthPx,
  unknownCharEm: 1,
};

/**
 * The renderer draws captions in ExtraBold; the width estimate is for SemiBold (+4%). ExtraBold is
 * about 7% wider (theme.ts CAPTION_STYLE); 8% keeps a little room.
 */
export const EXTRA_BOLD_WIDTH_FACTOR = 1.08;

/** Emoji: pictographs (with their ZWJ and variation-selector sequences), flags, keycaps. */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3\uFE0F]/u;

export type CaptionTextProblem = "emoji" | "too_long";

export function hasEmoji(text: string): boolean {
  return EMOJI.test(text);
}

/** The words of a cleaned caption text (single spaces). */
export function captionWordsOf(text: string): string[] {
  return text.split(" ").filter((word) => word.length > 0);
}

/** The fix layout, never more lenient than 1.0 em for an unknown character. */
function fixLayout(layout: CaptionLayout): CaptionLayout {
  return { ...layout, unknownCharEm: Math.max(layout.unknownCharEm ?? 1, 1) };
}

/**
 * How wide one caption line really is in the video (packages/video/src/Captions.tsx): every word in
 * ExtraBold with the pill's padding on both sides, and the gap between words (no space character).
 */
export function renderedLineWidth(words: readonly string[], fontSizePx: number = CAPTION_STYLE.fontSizePx): number {
  if (words.length === 0) return 0;
  const text = words.reduce((sum, word) => sum + estimateTextWidth(word, fontSizePx, { unknownCharEm: 1 }) * EXTRA_BOLD_WIDTH_FACTOR + 2 * CAPTION_STYLE.wordPaddingX, 0);
  return text + (words.length - 1) * CAPTION_STYLE.wordGap;
}

/**
 * The lines a fixed caption is shown on (1 or 2), or null when it doesn't fit: emoji, more than 2
 * lines, a word too wide for a line, or a line wider than the caption box as the renderer draws it.
 */
export function fixedCaptionLines(text: string, layout: CaptionLayout = CAPTION_FIX_LAYOUT): string[][] | null {
  if (hasEmoji(text)) return null;
  const words = captionWordsOf(text);
  if (words.length === 0) return null;
  const lines = breakLines(words, fixLayout(layout));
  if (!lines) return null;
  if (lines.some((line) => renderedLineWidth(line, layout.fontSizePx) > CAPTION_STYLE.boxWidth)) return null;
  return lines;
}

/** What is wrong with this caption text on its own (the Captions tab checks this before sending). */
export function captionTextProblem(text: string, layout: CaptionLayout = CAPTION_FIX_LAYOUT): CaptionTextProblem | null {
  if (hasEmoji(text)) return "emoji";
  return fixedCaptionLines(text, layout) ? null : "too_long";
}

/** The frames the phrase's words were spoken in: from its first word's start to its last word's end. */
export function spokenSpan(caption: Pick<Caption, "words">): { startFrame: number; endFrame: number } {
  return {
    startFrame: Math.min(...caption.words.map((w) => w.startFrame)),
    endFrame: Math.max(...caption.words.map((w) => w.endFrame)),
  };
}

/**
 * Why this text can't replace this phrase, or null when it can: the text problems above, or more
 * words than the phrase has frames (every word needs at least one frame to be highlighted).
 */
export function captionFixProblem(caption: Pick<Caption, "words">, text: string, layout: CaptionLayout = CAPTION_FIX_LAYOUT): CaptionTextProblem | null {
  const problem = captionTextProblem(text, layout);
  if (problem) return problem;
  const span = spokenSpan(caption);
  if (captionWordsOf(text).length > span.endFrame - span.startFrame) return "too_long";
  return null;
}
