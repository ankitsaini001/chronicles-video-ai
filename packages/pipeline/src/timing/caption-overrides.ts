import { CaptionTrackSchema, type Caption, type CaptionTrack, type CaptionTrackWord } from "../contracts";
import { CAPTION_FIX_LAYOUT, captionFixProblem, fixedCaptionLines, spokenSpan } from "./caption-fit";
import type { CaptionLayout } from "./captions";

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
 * - The phrase keeps its start and end frame. With the same number of words, each word keeps its
 *   own spoken times (a spelling fix stays in sync with the voice); with another number of words,
 *   the new words share the time the old words were spoken in, each in proportion to its length
 *   (spreadWordTimes): no gaps, no overlaps.
 * - Whether a fix fits on screen (no emoji, the compiler's line breaking at the normal size, the
 *   drawn width) is caption-fit.ts; the server checks it BEFORE starting the job.
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

/** A fix that can't be applied: unknown phrase, the phrase's text changed, or the text doesn't fit. */
export class CaptionOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionOverrideError";
  }
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

/**
 * The new words' times: each word's own spoken times when the number of words is the same (and the
 * phrase wasn't one long word split in two), otherwise spread over the phrase's spoken span.
 */
function wordTimes(caption: Caption, words: readonly string[]): { startFrame: number; endFrame: number }[] {
  if (words.length === caption.words.length && caption.fontSizePx === undefined) {
    return caption.words.map((w) => ({ startFrame: w.startFrame, endFrame: w.endFrame }));
  }
  const span = spokenSpan(caption);
  return spreadWordTimes(words, span.startFrame, span.endFrame);
}

/** One phrase with the creator's text: same start and end frame, new words, lines and highlights. */
export function fixCaption(caption: Caption, text: string, layout: CaptionLayout = CAPTION_FIX_LAYOUT): Caption {
  const lines = fixedCaptionLines(text, layout);
  if (!lines || captionFixProblem(caption, text, layout)) throw new CaptionOverrideError(`the caption fix for "${caption.id}" doesn't fit on screen`);
  const words = lines.flat();
  const highlighted = new Set(caption.words.filter((w) => w.key).map((w) => matchKey(w.text)));
  const times = wordTimes(caption, words);
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
export function applyCaptionOverrides(track: CaptionTrack, overrides: readonly CaptionOverride[], layout: CaptionLayout = CAPTION_FIX_LAYOUT): CaptionTrack {
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
