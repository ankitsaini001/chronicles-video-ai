import { CompileInputError } from "./errors";
import { isNumberToken, isUnitToken } from "./text";
import { estimateTextWidth } from "./text-width";

/**
 * Caption phrase grouping and line breaking (PIPELINE_DESIGN.md §7).
 *
 * - Captions are phrases of at most 2 lines. Video style v4 (F22b) uses short phrases of 3-5 words
 *   (`minWords`/`maxWords`); the renderer highlights the word being spoken inside the phrase.
 * - Phrases end at sentence ends, and at clause punctuation once they are long enough.
 * - Line width is decided with the deterministic width estimate (see text-width.ts).
 * - A number is never separated from its unit (line or phrase), e.g. "97 percent".
 * - A lone last word is avoided when another grouping fits.
 * - A single word wider than a line (rare: plan validation stops new ones, see captionWordFit) is a
 *   phrase of its own, shown a little smaller or broken at a hyphen, slash or dot.
 */

export interface CaptionWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface CaptionLayout {
  fontSizePx: number;
  maxLineWidthPx: number;
  /** Hard limit of words per phrase (no limit when absent). */
  maxWords?: number;
  /** Soft minimum: shorter phrases cost extra unless the sentence itself is shorter. */
  minWords?: number;
}

const SENTENCE_END = /[.?!।]["')\]]?$/u;
const CLAUSE_END = /[,;:—–]["')\]]?$/u;

function width(words: readonly string[], layout: CaptionLayout): number {
  return estimateTextWidth(words.join(" "), layout.fontSizePx);
}

function fitsLine(words: readonly string[], layout: CaptionLayout): boolean {
  return width(words, layout) <= layout.maxLineWidthPx;
}

/**
 * true when a break between these two words would split a number from its unit
 * (only enforced when the pair fits on one line at all).
 */
function keepsTogether(before: string, after: string, layout: CaptionLayout): boolean {
  const pair = (isNumberToken(before) && isUnitToken(after)) || /^[₹$€£]$/u.test(before);
  return pair && fitsLine([before, after], layout);
}

/** Best 1- or 2-line layout for a phrase, or null if it cannot fit in 2 lines. */
export function breakLines(words: readonly string[], layout: CaptionLayout): string[][] | null {
  return bestLineLayout(words, layout)?.lines ?? null;
}

interface LineLayout {
  lines: string[][];
  /** Readability penalty of the chosen break, in phrase-cost units (0 for a single line). */
  penalty: number;
}

function bestLineLayout(words: readonly string[], layout: CaptionLayout): LineLayout | null {
  if (words.length === 0) return null;
  if (fitsLine(words, layout)) return { lines: [[...words]], penalty: 0 };
  let best: { lines: string[][]; score: number; penalty: number } | null = null;
  for (let k = 1; k < words.length; k++) {
    const first = words.slice(0, k);
    const second = words.slice(k);
    if (!fitsLine(first, layout) || !fitsLine(second, layout)) continue;
    if (keepsTogether(words[k - 1]!, words[k]!, layout)) continue;
    let penalty = 0;
    if (second.length === 1 || first.length === 1) penalty += 500; // lone word on a line
    if (isWeakEnding(words[k - 1]!)) penalty += 150; // "the" / "of" at a line end
    let score = Math.abs(width(first, layout) - width(second, layout)) + penalty * 20;
    if (CLAUSE_END.test(words[k - 1]!)) score -= layout.maxLineWidthPx * 0.25; // prefer natural breaks
    if (!best || score < best.score) best = { lines: [first, second], score, penalty };
  }
  return best ? { lines: best.lines, penalty: best.penalty } : null;
}

function fits(words: readonly CaptionWord[], layout: CaptionLayout): boolean {
  if (layout.maxWords !== undefined && words.length > layout.maxWords) return false;
  return bestLineLayout(words.map((w) => w.text), layout) !== null;
}

/** Short function words that read badly at the end of a caption or line. */
const WEAK_ENDINGS = new Set([
  "a", "an", "the", "of", "to", "in", "into", "on", "at", "for", "from", "with", "by", "and", "or", "but", "as", "is",
  "are", "was", "be", "been", "have", "has", "it", "its", "this", "that", "your", "our", "their", "my", "very", "so",
  "का", "की", "के", "में", "से", "को", "और", "पर", "है",
]);

function isWeakEnding(word: string): boolean {
  return WEAK_ENDINGS.has(word.toLowerCase().replace(/[^\p{L}\p{M}]/gu, ""));
}

/** Cost of ending a line or phrase after `word` (lower is more natural). */
function breakCost(word: string): number {
  if (SENTENCE_END.test(word) || CLAUSE_END.test(word)) return 0;
  return isWeakEnding(word) ? 600 : 250;
}

const PHRASE_COST = 1000;

/** A word wider than a line may be shown down to this share of the caption size (66 px -> 50 px). */
export const MIN_CAPTION_FONT_SCALE = 0.75;

/**
 * How one caption word fits a line (F22b review: long words such as "telecommunications" or
 * "www.instagram.com" no longer fail a paid-for video):
 * - "fits": at the normal size;
 * - "shrink": alone in its phrase at `fontSizePx`, at least MIN_CAPTION_FONT_SCALE of the normal size;
 * - "split": broken after a hyphen, slash or dot into two lines at `fontSizePx`;
 * - null: it can't be shown. Plan validation reports such a word before any voice is recorded,
 *   and the compiler stops with a CompileInputError (the run goes to needs-input).
 */
export type CaptionWordFit =
  | { kind: "fits"; fontSizePx: number }
  | { kind: "shrink"; fontSizePx: number }
  | { kind: "split"; fontSizePx: number; pieces: [string, string] };

export function captionWordFit(word: string, layout: CaptionLayout): CaptionWordFit | null {
  const minSize = Math.ceil(layout.fontSizePx * MIN_CAPTION_FONT_SCALE);
  const sizeFor = (text: string) => Math.min(layout.fontSizePx, Math.floor((layout.fontSizePx * layout.maxLineWidthPx) / estimateTextWidth(text, layout.fontSizePx)));
  if (fitsLine([word], layout)) return { kind: "fits", fontSizePx: layout.fontSizePx };
  const shrunk = sizeFor(word);
  if (shrunk >= minSize) return { kind: "shrink", fontSizePx: shrunk };
  let best: { fontSizePx: number; pieces: [string, string] } | null = null;
  for (let i = 1; i < word.length - 1; i++) {
    if (!/[-/.]/u.test(word[i - 1]!)) continue;
    const pieces: [string, string] = [word.slice(0, i), word.slice(i)];
    const size = Math.min(sizeFor(pieces[0]), sizeFor(pieces[1]));
    if (size >= minSize && (!best || size > best.fontSizePx)) best = { fontSizePx: size, pieces };
  }
  return best ? { kind: "split", ...best } : null;
}

/**
 * Group one scene's words into caption phrases. Each sentence is split on its own with a small
 * dynamic program that minimises: number of phrases, breaks that are not at punctuation, phrases
 * ending on a weak word ("the", "of"), one-word phrases, and uneven phrase lengths.
 * A number and its unit are never split across phrases. A word wider than a line becomes a phrase
 * of its own (see captionWordFit); one that can't be shown at all is a CompileInputError.
 */
export function groupPhrases(words: readonly CaptionWord[], layout: CaptionLayout): CaptionWord[][] {
  const phrases: CaptionWord[][] = [];
  let sentence: CaptionWord[] = [];
  const flush = () => {
    if (sentence.length > 0) phrases.push(...splitSentence(sentence, layout));
    sentence = [];
  };
  for (const word of words) {
    if (!fitsLine([word.text], layout)) {
      if (!captionWordFit(word.text, layout)) {
        throw new CompileInputError(`the caption word "${word.text}" is too long to fit on a caption line; use a shorter word or a "display" form`);
      }
      flush();
      phrases.push([word]);
      continue;
    }
    sentence.push(word);
    if (SENTENCE_END.test(word.text)) flush();
  }
  flush();
  return mergeLoneWords(phrases, layout);
}

function splitSentence(words: readonly CaptionWord[], layout: CaptionLayout): CaptionWord[][] {
  const n = words.length;
  const twoLines = 2 * layout.maxLineWidthPx;
  const best: { cost: number; from: number }[] = [{ cost: 0, from: -1 }];
  for (let end = 1; end <= n; end++) {
    best[end] = { cost: Infinity, from: -1 };
    for (let start = end - 1; start >= 0; start--) {
      const phrase = words.slice(start, end);
      if (layout.maxWords !== undefined && phrase.length > layout.maxWords) break;
      const lines = bestLineLayout(phrase.map((w) => w.text), layout);
      if (!lines) break; // longer phrases will not fit either
      if (end < n && keepsTogether(words[end - 1]!.text, words[end]!.text, layout)) continue;
      const fill = width(phrase.map((w) => w.text), layout) / twoLines;
      let cost = best[start]!.cost + PHRASE_COST + (1 - fill) * (1 - fill) * 400 + lines.penalty;
      if (end < n) cost += breakCost(words[end - 1]!.text);
      if (phrase.length === 1 && n > 1) cost += 2000;
      else if (layout.minWords !== undefined && phrase.length < layout.minWords && n >= layout.minWords) cost += 900;
      if (cost < best[end]!.cost) best[end] = { cost, from: start };
    }
  }
  if (!Number.isFinite(best[n]!.cost)) throw new Error("internal: sentence could not be split into caption phrases");
  const result: CaptionWord[][] = [];
  for (let end = n; end > 0; end = best[end]!.from) result.unshift(words.slice(best[end]!.from, end));
  return result;
}
/** A one-word phrase joins its neighbour (previous first, then next) when the result still fits. */
function mergeLoneWords(phrases: CaptionWord[][], layout: CaptionLayout): CaptionWord[][] {
  const result = phrases.map((p) => [...p]);
  for (let i = 0; i < result.length; i++) {
    if (result[i]!.length !== 1) continue;
    const previous = result[i - 1];
    const next = result[i + 1];
    if (previous && fits([...previous, ...result[i]!], layout)) {
      result[i - 1] = [...previous, ...result[i]!];
      result.splice(i, 1);
      i--;
    } else if (next && fits([...result[i]!, ...next], layout)) {
      result[i + 1] = [...result[i]!, ...next];
      result.splice(i, 1);
      i--;
    }
  }
  return result;
}
