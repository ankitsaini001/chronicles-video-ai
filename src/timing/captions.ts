import { isNumberToken, isUnitToken } from "./text";
import { estimateTextWidth } from "./text-width";

/**
 * Caption phrase grouping and line breaking (PIPELINE_DESIGN.md §7).
 *
 * - Captions are phrases (no word-by-word effects), at most 2 lines.
 * - Phrases end at sentence ends, and at clause punctuation once they are long enough.
 * - Line width is decided with the deterministic width estimate (see text-width.ts).
 * - A number is never separated from its unit (line or phrase), e.g. "97 percent".
 * - A lone last word is avoided when another grouping fits.
 */

export interface CaptionWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface CaptionLayout {
  fontSizePx: number;
  maxLineWidthPx: number;
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

/**
 * Group one scene's words into caption phrases. Each sentence is split on its own with a small
 * dynamic program that minimises: number of phrases, breaks that are not at punctuation, phrases
 * ending on a weak word ("the", "of"), one-word phrases, and uneven phrase lengths.
 * A number and its unit are never split across phrases.
 */
export function groupPhrases(words: readonly CaptionWord[], layout: CaptionLayout): CaptionWord[][] {
  for (const word of words) {
    if (!fitsLine([word.text], layout)) {
      throw new Error(`caption word "${word.text}" is wider than a caption line; shorten it or add a display form`);
    }
  }
  const phrases: CaptionWord[][] = [];
  let sentence: CaptionWord[] = [];
  for (const word of words) {
    sentence.push(word);
    if (SENTENCE_END.test(word.text)) {
      phrases.push(...splitSentence(sentence, layout));
      sentence = [];
    }
  }
  if (sentence.length > 0) phrases.push(...splitSentence(sentence, layout));
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
      const lines = bestLineLayout(phrase.map((w) => w.text), layout);
      if (!lines) break; // longer phrases will not fit either
      if (end < n && keepsTogether(words[end - 1]!.text, words[end]!.text, layout)) continue;
      const fill = width(phrase.map((w) => w.text), layout) / twoLines;
      let cost = best[start]!.cost + PHRASE_COST + (1 - fill) * (1 - fill) * 400 + lines.penalty;
      if (end < n) cost += breakCost(words[end - 1]!.text);
      if (phrase.length === 1 && n > 1) cost += 2000;
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
