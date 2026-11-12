/**
 * ByteReel minimal visual system (PIPELINE_DESIGN.md §7): style tokens, safe zones, motion timings.
 * Plain constants with no React import, so the timing compiler can share caption metrics.
 */

export const CANVAS = { width: 1080, height: 1920, fps: 30 } as const;

/** Light background, dark text, two restrained accents (blue = primary, amber = emphasis). */
export const COLORS = {
  background: "#F5F3EE",
  surface: "#FFFFFF",
  ink: "#17213B",
  inkMuted: "#5D6779",
  line: "#D8DCE4",
  track: "#E7E9EE",
  accent: "#2563EB",
  accentSoft: "#DCE6FB",
  warm: "#E8811A",
  warmSoft: "#FCEBD7",
  captionBackground: "#17213B",
  captionText: "#FFFFFF",
  fixtureBadge: "#B42318",
} as const;

export const FONT_FAMILY = "'Inter', 'Noto Sans Devanagari', system-ui, sans-serif";

export const FONT_SIZE = {
  display: 96,
  headline: 76,
  title: 56,
  body: 42,
  label: 38,
  small: 30,
} as const;

export const SPACE = { xs: 8, s: 16, m: 24, l: 40, xl: 64 } as const;
export const RADIUS = { s: 14, m: 24, l: 36, pill: 999 } as const;

/**
 * Instagram Reels safe zones. The top band holds the Reels header; the bottom band holds the
 * username, caption and audio row; the right side of the lower half holds like/comment/share.
 * Key text and visuals stay inside STAGE; captions sit inside CAPTION_ZONE.
 */
export const SAFE_ZONE = { top: 220, bottom: 420, left: 80, right: 80, rightUi: 140 } as const;

/** Where pattern components draw (absolute px). */
export const STAGE = { x: 80, y: 310, width: 920, height: 930 } as const;

/** Caption block: bottom edge, horizontal extent (clear of the right-hand Reels buttons). */
export const CAPTION_ZONE = {
  left: SAFE_ZONE.left,
  right: CANVAS.width - SAFE_ZONE.rightUi,
  bottom: CANVAS.height - SAFE_ZONE.bottom,
} as const;

export const CAPTION_STYLE = {
  fontSizePx: 50,
  fontWeight: 600,
  lineHeight: 1.28,
  paddingX: 34,
  paddingY: 20,
  /**
   * Usable text width per line for the compiler. The box is centred on the canvas and may be
   * 2 × (CAPTION_ZONE.right − 540) = 800 px wide (732 px of text); 672 px leaves a safety margin
   * for the width estimate.
   */
  maxLineWidthPx: 672,
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
