import { loadFont } from "@remotion/fonts";
import interLatin400 from "@fontsource/inter/files/inter-latin-400-normal.woff2";
import interLatin500 from "@fontsource/inter/files/inter-latin-500-normal.woff2";
import interLatin600 from "@fontsource/inter/files/inter-latin-600-normal.woff2";
import interLatin700 from "@fontsource/inter/files/inter-latin-700-normal.woff2";
import interLatin800 from "@fontsource/inter/files/inter-latin-800-normal.woff2";
import interLatinExt400 from "@fontsource/inter/files/inter-latin-ext-400-normal.woff2";
import interLatinExt600 from "@fontsource/inter/files/inter-latin-ext-600-normal.woff2";
import interLatinExt700 from "@fontsource/inter/files/inter-latin-ext-700-normal.woff2";
import interLatinExt800 from "@fontsource/inter/files/inter-latin-ext-800-normal.woff2";
import deva400 from "@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-400-normal.woff2";
import deva500 from "@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-500-normal.woff2";
import deva600 from "@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-600-normal.woff2";
import deva700 from "@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-700-normal.woff2";
import deva800 from "@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-800-normal.woff2";

/**
 * Locally packaged fonts (PIPELINE_DESIGN.md §7): Inter for Latin UI text and Noto Sans Devanagari
 * for Hindi, both from @fontsource npm packages (SIL Open Font License), bundled into the Remotion
 * bundle. Nothing is downloaded at render time. loadFont() delays rendering until each face loads.
 *
 * unicode-range values are the ones published by Fontsource, so the browser picks Inter for Latin
 * and Noto Sans Devanagari for Devanagari (₹ is covered by both; Inter comes first in FONT_FAMILY).
 */

const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
const DEVANAGARI = "U+0900-097F,U+1CD0-1CF9,U+200C-200D,U+20A8,U+20B9,U+20F0,U+25CC,U+A830-A839,U+A8E0-A8FF,U+11B00-11B09";

const FACES: { family: string; url: string; weight: string; unicodeRange: string }[] = [
  { family: "Inter", url: interLatin400, weight: "400", unicodeRange: LATIN },
  { family: "Inter", url: interLatin500, weight: "500", unicodeRange: LATIN },
  { family: "Inter", url: interLatin600, weight: "600", unicodeRange: LATIN },
  { family: "Inter", url: interLatin700, weight: "700", unicodeRange: LATIN },
  { family: "Inter", url: interLatin800, weight: "800", unicodeRange: LATIN },
  { family: "Inter", url: interLatinExt400, weight: "400", unicodeRange: LATIN_EXT },
  { family: "Inter", url: interLatinExt600, weight: "600", unicodeRange: LATIN_EXT },
  { family: "Inter", url: interLatinExt700, weight: "700", unicodeRange: LATIN_EXT },
  { family: "Inter", url: interLatinExt800, weight: "800", unicodeRange: LATIN_EXT },
  { family: "Noto Sans Devanagari", url: deva400, weight: "400", unicodeRange: DEVANAGARI },
  { family: "Noto Sans Devanagari", url: deva500, weight: "500", unicodeRange: DEVANAGARI },
  { family: "Noto Sans Devanagari", url: deva600, weight: "600", unicodeRange: DEVANAGARI },
  { family: "Noto Sans Devanagari", url: deva700, weight: "700", unicodeRange: DEVANAGARI },
  { family: "Noto Sans Devanagari", url: deva800, weight: "800", unicodeRange: DEVANAGARI },
];

let loaded = false;

/** Register all font faces once. Safe to call from every composition. */
export function loadPackagedFonts(): void {
  if (loaded) return;
  loaded = true;
  for (const face of FACES) {
    void loadFont({ family: face.family, url: face.url, weight: face.weight, unicodeRange: face.unicodeRange, display: "block" });
  }
}
