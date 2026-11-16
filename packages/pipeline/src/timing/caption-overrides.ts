import { CaptionTrackSchema, type Caption, type CaptionTrack, type CaptionTrackWord } from "../contracts";
import { CAPTION_STYLE } from "../theme";
import { breakLines, type CaptionLayout } from "./captions";
import { DEFAULT_CAPTION_LAYOUT } from "./compile";
import { estimateTextWidth } from "./text-width";

/**
 * Caption fixes (F25, PRD §6.3 "Caption correction", PIPELINE_DESIGN §9 "Caption display correction
 * → compile captions + render, no speech"). The creator replaces the text of one caption PHRASE;
 * the narration audio stays exactly the same. Pure and deterministic (no clock, no I/O, no AI).
 *
 * - A phrase is found by its scene and its place in that scene (`phraseIndex`, from 0), in the
 *   order the compiler made them. The compiler is deterministic, so the same storyboard version and
 *   the same recordings give the same phrases again; each fix also keeps the text it replaced
 *   (`originalText`), and a fix whose phrase no longer has that text is refused (never put on the
 *   wrong phrase).
 * - The phrase keeps its start and end frame. The new words share the time the old words were
 *   spoken in, each in proportion to its length (spreadWordTimes): no gaps, no overlaps.
 * - Lines are broken with the compiler's own rule (breakLines, the same width estimate) at the
 *   normal caption size, at most 2 lines. On top of that each line must fit the caption box the way
 *   the renderer really draws it (ExtraBold, a pill's padding around every word, the gaps between
 *   words: renderedLineWidth), so a fixed caption never fails the browser's width check later and
 *   never runs into the Reels buttons. The server checks this BEFORE starting the job.
 * - Amber key-term highlighting is kept only for words that still match a highlighted word of the
 *   phrase (same letters, any case or punctuation).
 */

export interface CaptionOverride {
  sceneId: string;
  phraseIndex: number;
  /** The creator's text: cleaned (single spaces, trimmed), 1–200 characters. */
  text: string;
  /** The compiled phrase text this fix replaces (from the video the creator was looking at). */
  originalText: string;
}

/** Longest caption fix (API.md F4). */
export const CAPTION_FIX_MAX_CHARS = 200;

/**
 * The renderer draws captions in ExtraBold; the width estimate is for SemiBold (+4%). ExtraBold is
 * about 7% wider (theme.ts CAPTION_STYLE); 8% keeps a little room.
 */
export const EXTRA_BOLD_WIDTH_FACTOR = 1.08;

/** A fix that can't be applied: unknown phrase, the phrase's text changed, or the text doesn't fit. */
export class CaptionOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionOverrideError";
  }
}

/** The words of a cleaned caption text (single spaces). */
export function captionWordsOf(text: string): string[] {
  return text.split(" ").filter((word) => word.length > 0);
}

/**
 * How wide one caption line really is in the video (packages/video/src/Captions.tsx): every word in
 * ExtraBold with the pill's padding on both sides, and the gap between words (no space character).
 */
export function renderedLineWidth(words: readonly string[], fontSizePx: number = CAPTION_STYLE.fontSizePx): number {
  if (words.length === 0) return 0;
  const text = words.reduce((sum, word) => sum + estimateTextWidth(word, fontSizePx) * EXTRA_BOLD_WIDTH_FACTOR + 2 * CAPTION_STYLE.wordPaddingX, 0);
  return text + (words.length - 1) * CAPTION_STYLE.wordGap;
}

/**
 * The lines a fixed caption is shown on (the compiler's breakLines at the normal size, 1 or 2
 * lines), or null when it doesn't fit: more than 2 lines, a word too wide for a line, or a line
 * wider than the caption box as the renderer draws it.
 */
export function fixedCaptionLines(text: string, layout: CaptionLayout = DEFAULT_CAPTION_LAYOUT): string[][] | null {
  const words = captionWordsOf(text);
  if (words.length === 0) return null;
  const lines = breakLines(words, layout);
  if (!lines) return null;
  if (lines.some((line) => renderedLineWidth(line, layout.fontSizePx) > CAPTION_STYLE.boxWidth)) return null;
  return lines;
}

/** Each caption with its scene and its place in that scene (from 0), in track order. */
export function indexCaptions(track: Pick<CaptionTrack, "captions">): { caption: Caption; sceneId: string; phraseIndex: number }[] {
  const counts = new Map<string, number>();
  return track.captions.map((caption) => {
    const phraseIndex = counts.get(caption.sceneId) ?? 0;
    counts.set(caption.sceneId, phraseIndex + 1);
    return { caption, sceneId: caption.sceneId, phraseIndex };
  });
}

/** The frames the phrase's words were spoken in: from its first word's start to its last word's end. */
export function spokenSpan(caption: Pick<Caption, "words">): { startFrame: number; endFrame: number } {
  return {
    startFrame: Math.min(...caption.words.map((w) => w.startFrame)),
    endFrame: Math.max(...caption.words.map((w) => w.endFrame)),
  };
}

/**
 * Why this text can't replace this phrase, or null when it can. "too_long": it doesn't fit on
 * screen (fixedCaptionLines), or it has more words than the phrase has frames (every word needs
 * at least one frame to be highlighted). Used by the server (API F4) and again by the render.
 */
export function captionFixProblem(caption: Pick<Caption, "words">, text: string, layout: CaptionLayout = DEFAULT_CAPTION_LAYOUT): "too_long" | null {
  if (!fixedCaptionLines(text, layout)) return "too_long";
  const span = spokenSpan(caption);
  if (captionWordsOf(text).length > span.endFrame - span.startFrame) return "too_long";
  return null;
}

/** Letters and digits only, lower case: "Vapour," and "vapour" match. */
function matchKey(word: string): string {
  return word.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
}

/**
 * Times for the new words inside [startFrame, endFrame): each word gets a share in proportion to
 * its length (letters and digits; at least 1), every word at least one frame, the first starts at
 * `startFrame`, each one ends where the next starts, the last ends at `endFrame`. (With more words
 * than frames the span is stretched to one frame per word; the server refuses such a fix first.)
 */
export function spreadWordTimes(words: readonly string[], startFrame: number, endFrame: number): { startFrame: number; endFrame: number }[] {
  const n = words.length;
  if (n === 0) return [];
  const span = Math.max(endFrame - startFrame, n);
  const weights = words.map((word) => Math.max(1, [...matchKey(word)].length));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const bounds = [startFrame];
  let done = 0;
  for (let i = 0; i < n - 1; i++) {
    done += weights[i]!;
    const ideal = startFrame + Math.round((span * done) / total);
    const earliest = bounds[i]! + 1;
    const latest = startFrame + span - (n - 1 - i);
    bounds.push(Math.min(latest, Math.max(earliest, ideal)));
  }
  bounds.push(startFrame + span);
  return words.map((_word, i) => ({ startFrame: bounds[i]!, endFrame: bounds[i + 1]! }));
}

/** One phrase with the creator's text: same start and end frame, new words, lines and highlights. */
export function fixCaption(caption: Caption, text: string, layout: CaptionLayout = DEFAULT_CAPTION_LAYOUT): Caption {
  const lines = fixedCaptionLines(text, layout);
  if (!lines || captionFixProblem(caption, text, layout)) throw new CaptionOverrideError(`the caption fix for "${caption.id}" is too long to fit on screen`);
  const words = lines.flat();
  const highlighted = new Set(caption.words.filter((w) => w.key).map((w) => matchKey(w.text)));
  const span = spokenSpan(caption);
  const times = spreadWordTimes(words, span.startFrame, span.endFrame);
  const timed: CaptionTrackWord[] = words.map((word, i) => ({ text: word, ...times[i]!, key: matchKey(word) !== "" && highlighted.has(matchKey(word)) }));
  // The normal size again (a fix must fit at the normal size), so no `fontSizePx`.
  return {
    id: caption.id,
    sceneId: caption.sceneId,
    startFrame: caption.startFrame,
    endFrame: caption.endFrame,
    text: words.join(" "),
    lines: lines.map((line) => line.join(" ")),
    words: timed,
    originalText: caption.originalText ?? caption.text,
  };
}

/**
 * The compiled captions with the creator's fixes applied (the render job calls this right after
 * compiling). Every fix must name an existing phrase whose compiled text is still `originalText`;
 * a fix equal to the compiled text changes nothing. Throws CaptionOverrideError otherwise.
 */
export function applyCaptionOverrides(track: CaptionTrack, overrides: readonly CaptionOverride[], layout: CaptionLayout = DEFAULT_CAPTION_LAYOUT): CaptionTrack {
  if (overrides.length === 0) return track;
  const indexed = indexCaptions(track);
  const captions = [...track.captions];
  const seen = new Set<string>();
  for (const override of overrides) {
    const pair = `${override.sceneId}#${override.phraseIndex}`;
    if (seen.has(pair)) throw new CaptionOverrideError(`two fixes for phrase ${override.phraseIndex} of scene "${override.sceneId}"`);
    seen.add(pair);
    const at = indexed.findIndex((c) => c.sceneId === override.sceneId && c.phraseIndex === override.phraseIndex);
    if (at < 0) throw new CaptionOverrideError(`scene "${override.sceneId}" has no phrase ${override.phraseIndex}`);
    const compiled = indexed[at]!.caption;
    if (compiled.text !== override.originalText) {
      throw new CaptionOverrideError(`phrase ${override.phraseIndex} of scene "${override.sceneId}" now reads "${compiled.text}", not "${override.originalText}"`);
    }
    if (override.text === compiled.text) continue;
    captions[at] = fixCaption(compiled, override.text, layout);
  }
  return CaptionTrackSchema.parse({ ...track, captions });
}
