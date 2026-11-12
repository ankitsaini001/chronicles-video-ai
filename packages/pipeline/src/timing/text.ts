/**
 * Text tokens and comparison atoms (PIPELINE_DESIGN.md §6, alignment steps 4-5).
 *
 * A *token* is a whitespace-separated piece of text with its UTF-16 span, e.g. `97%`, `Earth's`,
 * `rivers,`. Captions are built from tokens, so punctuation stays attached and a number never
 * loses its `%`.
 *
 * *Atoms* are the normalized spoken words inside a token, used to match the approved text,
 * the caption display text and the speech text against each other:
 *   `97%` -> ["ninety", "seven", "percent"], `Earth’s` -> ["earths"], `DNA` -> ["d", "n", "a"].
 * Words are found with Intl.Segmenter, so Devanagari words (with matras and conjuncts) stay whole.
 *
 * P1 normalization is deliberately basic: English integers/decimals, %, ₹, &, and short
 * all-caps acronyms. Anything else must match literally; a mismatch is a clear error,
 * never a guess. TODO(P2): Hindi number words, ordinals, years ("1990" -> "nineteen ninety"),
 * currency amounts like "₹2 lakh", and provider normalized-alignment reconciliation.
 */

export interface Token {
  text: string;
  /** UTF-16 offsets in the source string, end exclusive. */
  start: number;
  end: number;
  atoms: string[];
}

const SEGMENTERS = new Map<string, Intl.Segmenter>();
function wordSegmenter(locale: string): Intl.Segmenter {
  let segmenter = SEGMENTERS.get(locale);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    SEGMENTERS.set(locale, segmenter);
  }
  return segmenter;
}

/** Map every apostrophe-like character to nothing so "Earth’s", "Earth's" and "Earthʼs" compare equal. */
const APOSTROPHES = /['’‘ʼ`´]/g;
const NUMBER = /^\d+(?:[.,]\d+)*$/;
const ACRONYM = /^[A-Z]{2,5}$/;

export function tokenize(text: string, locale = "en"): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const start = match.index;
    tokens.push({ text: match[0], start, end: start + match[0].length, atoms: atomsOf(match[0], locale) });
  }
  return tokens;
}

export function atomsOf(token: string, locale = "en"): string[] {
  const normalized = token.normalize("NFC").replace(APOSTROPHES, "");
  const atoms: string[] = [];
  let currencyWord: string | null = null;
  for (const part of wordSegmenter(locale).segment(normalized)) {
    const segment = part.segment;
    if (part.isWordLike) {
      if (NUMBER.test(segment)) atoms.push(...numberToWords(segment));
      else if (ACRONYM.test(segment)) atoms.push(...segment.toLowerCase().split(""));
      else atoms.push(segment.toLowerCase());
      continue;
    }
    if (segment === "%") atoms.push("percent");
    else if (segment === "&") atoms.push("and");
    else if (segment === "₹") currencyWord = "rupees";
  }
  // "₹500" is spoken "500 rupees": the currency word comes after the amount.
  if (currencyWord) atoms.push(currencyWord);
  return atoms;
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/**
 * Basic English number words for matching ("97" -> ninety seven, "2.5" -> two point five,
 * "1,000" -> one thousand). Numbers above 999,999 are kept as digits (they must then match literally).
 */
export function numberToWords(raw: string): string[] {
  const decimalMatch = /^(\d+(?:,\d{2,3})*)(?:\.(\d+))?$/.exec(raw);
  if (!decimalMatch) return [raw];
  const integer = Number(decimalMatch[1]!.replace(/,/g, ""));
  if (!Number.isSafeInteger(integer) || integer > 999_999) return [raw];
  const words = integerWords(integer);
  if (decimalMatch[2]) words.push("point", ...decimalMatch[2].split("").map((d) => ONES[Number(d)]!));
  return words;
}

function integerWords(n: number): string[] {
  if (n < 20) return [ONES[n]!];
  if (n < 100) return n % 10 === 0 ? [TENS[Math.floor(n / 10)]!] : [TENS[Math.floor(n / 10)]!, ONES[n % 10]!];
  if (n < 1000) {
    const rest = n % 100;
    return [ONES[Math.floor(n / 100)]!, "hundred", ...(rest ? integerWords(rest) : [])];
  }
  const rest = n % 1000;
  return [...integerWords(Math.floor(n / 1000)), "thousand", ...(rest ? integerWords(rest) : [])];
}

/** true when the token is (or starts with) a number, e.g. "97", "2.5", "₹500", "97%". */
export function isNumberToken(token: string): boolean {
  return /^[₹$€£]?\d/.test(token);
}

/** Units that must stay on the same caption line as the number before them. */
const UNITS = new Set([
  "%", "percent", "per", "cent", "rupees", "rupee", "rs", "lakh", "lakhs", "crore", "crores", "thousand", "million",
  "billion", "km", "m", "cm", "mm", "kg", "g", "mg", "l", "ml", "°c", "°f", "degrees", "years", "year", "days", "hours",
  "minutes", "seconds", "kmph", "km/h", "mph", "°", "प्रतिशत", "रुपये", "रुपए", "लाख", "करोड़", "साल", "किलो",
]);

export function isUnitToken(token: string): boolean {
  const bare = token.normalize("NFC").toLowerCase().replace(/[.,;:!?)"'’]+$/u, "");
  return UNITS.has(bare);
}
