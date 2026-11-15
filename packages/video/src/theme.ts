import { CANVAS, CAPTION_STYLE, FONT_FAMILY, SAFE_ZONE } from "@bytereel/pipeline/theme";

/**
 * Video style v4 (F22b, docs/BRAND.md §7): the dark "Ember Gold" stage, plus a small nature palette
 * for hero objects. Layout numbers keep everything inside the Instagram Reels safe zone: the top
 * band holds the Reels header, the bottom band the username/caption row, and the right side of the
 * lower half the like/comment/share buttons.
 */

export const C = {
  bg: "#0B0806",
  bgDeep: "#050302",
  surface: "#15100B",
  surface2: "#1A120A",
  amber: "#F5A524",
  amberDeep: "#E8901A",
  amberLight: "#F5B65A",
  gold: "#FFE2A8",
  text: "#F7EFE6",
  cardText: "#E9DCCB",
  muted: "#B5A795",
  water: "#2F8FD8",
  waterLight: "#8FD6FF",
  ice: "#DDF3FF",
} as const;

export const FONT = FONT_FAMILY;

/** Screen bands (px, 1080 x 1920). */
export const LAYOUT = {
  width: CANVAS.width,
  height: CANVAS.height,
  /** Titles and the current-step card start here (below the Reels header). */
  top: 290,
  /** The hero's usual centre and size (the middle band, about 440-1000). */
  heroX: 540,
  heroY: 720,
  heroSize: 560,
  /** Lower band for diagrams, rails and cards: everything stays above this line (captions below). */
  stageBottom: 1275,
  /** Keep text clear of the frame edges and the right-hand Reels buttons. */
  sideMargin: SAFE_ZONE.left,
  /** The Reels like/comment/share buttons start at this x in the lower half of the screen. */
  safeEdge: CANVAS.width - SAFE_ZONE.rightUi,
  /**
   * Right edge for everything drawn in the lower half, measured before the camera and including an
   * element's own pop/active scale: the scene camera zooms up to about 1.038 around x 540 and drifts
   * ±3 px, which moves 920 to about 940 (`safeEdge`). Every layout derives its right side from this
   * (packages/video/src/layout.ts; checked by tests/video-layout.test.ts).
   */
  safeRight: 920,
  captionCenterX: CAPTION_STYLE.centerX,
  captionBottom: CAPTION_STYLE.bottom,
  captionWidth: CAPTION_STYLE.boxWidth,
} as const;

export const GRADIENTS = {
  headline: "linear-gradient(180deg, #FFE2A8 0%, #F5B04A 100%)",
  button: "linear-gradient(180deg, #F7B44A, #E8901A)",
  card: "linear-gradient(160deg, #1E150C 0%, #140D07 100%)",
  tile: "radial-gradient(circle at 35% 30%, #2A1D10, #120C07 75%)",
} as const;
