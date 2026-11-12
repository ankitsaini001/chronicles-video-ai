/**
 * Deterministic text width ESTIMATE for caption line breaking.
 *
 * Real measurement needs a browser with the packaged fonts loaded; the compiler runs in Node,
 * so it uses per-character width classes approximating Inter SemiBold and Noto Sans Devanagari
 * SemiBold (in em), plus a 4% safety margin. The caption renderer re-measures in the browser
 * and fails the render if a line still overflows, so a wrong estimate can never ship silently.
 */

export const WIDTH_METHOD = "estimate:char-class-v1";

const LOWER: Record<string, number> = {
  a: 0.56, b: 0.6, c: 0.55, d: 0.6, e: 0.57, f: 0.37, g: 0.6, h: 0.6, i: 0.26, j: 0.27, k: 0.56, l: 0.26, m: 0.9,
  n: 0.6, o: 0.59, p: 0.6, q: 0.6, r: 0.39, s: 0.52, t: 0.37, u: 0.6, v: 0.56, w: 0.82, x: 0.55, y: 0.56, z: 0.52,
};
const SPECIAL: Record<string, number> = {
  " ": 0.27, ".": 0.28, ",": 0.28, ":": 0.28, ";": 0.28, "'": 0.22, "’": 0.22, '"': 0.4, "!": 0.3, "?": 0.52,
  "-": 0.42, "–": 0.6, "—": 0.9, "(": 0.36, ")": 0.36, "%": 0.86, "₹": 0.62, "&": 0.72, "/": 0.4, I: 0.29, M: 0.88,
  W: 0.98, J: 0.5, "।": 0.3,
};

function charWidthEm(ch: string): number {
  const known = LOWER[ch] ?? SPECIAL[ch];
  if (known !== undefined) return known;
  if (/\p{Mn}/u.test(ch)) return 0; // non-spacing marks (most matras above/below, virama, nukta)
  if (/\p{Mc}/u.test(ch)) return 0.3; // spacing matras such as ा ि ी ो
  if (/\p{Script=Devanagari}/u.test(ch)) return 0.66;
  if (/\d/u.test(ch)) return 0.62;
  if (/\p{Lu}/u.test(ch)) return 0.7;
  return 0.6;
}

export function estimateTextWidth(text: string, fontSizePx: number): number {
  let em = 0;
  for (const ch of text.normalize("NFC")) em += charWidthEm(ch);
  return em * fontSizePx * 1.04;
}
