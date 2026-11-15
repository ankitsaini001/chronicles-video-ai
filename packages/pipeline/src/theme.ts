/**
 * Video constants shared by the timing compiler and the Remotion engine (PIPELINE_DESIGN.md §7):
 * canvas, font stack, Reels safe zones, caption metrics and motion timings. Plain constants with no
 * React import. The v4 colours and layout bands live in packages/video/src/theme.ts.
 */

export const CANVAS = { width: 1080, height: 1920, fps: 30 } as const;

export const FONT_FAMILY = "'Inter', 'Noto Sans Devanagari', system-ui, sans-serif";

/**
 * Instagram Reels safe zones. The top band holds the Reels header; the bottom band holds the
 * username, caption and audio row; the right side of the lower half holds like/comment/share.
 */
export const SAFE_ZONE = { top: 220, bottom: 420, left: 80, right: 80, rightUi: 140 } as const;

/**
 * Captions, video style v4 (F22b): short phrases of 3-5 words in big ExtraBold type; the word being
 * spoken lights up in an amber pill and key terms are amber.
 */
export const CAPTION_STYLE = {
  fontSizePx: 66,
  fontWeight: 800,
  lineHeight: 1.18,
  /** Horizontal padding of each word (room for the amber pill of the current word). */
  wordPaddingX: 10,
  /** Gap between words, instead of a space character. */
  wordGap: 12,
  /** The caption box: centred on this x (left of the Reels button column), bottom edge at `bottom`. */
  centerX: 515,
  boxWidth: 850,
  bottom: 1495,
  /**
   * Usable text width per line for the compiler's estimate (Inter SemiBold widths + 4%). ExtraBold
   * is about 7% wider and each word adds 2 × 10 px of padding: 650 px of estimate leaves room for
   * five words inside the 850 px box.
   */
  maxLineWidthPx: 650,
  minWords: 3,
  maxWords: 5,
} as const;

/** Motion timings in frames (30 fps). */
export const MOTION = {
  reveal: 12,
  highlightIn: 8,
  highlightHold: 36,
  pulse: 24,
  draw: 20,
  grow: 30,
  stagger: 5,
} as const;
