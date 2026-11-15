import { estimateTextWidth } from "@bytereel/pipeline/timing/text-width";
import { LAYOUT } from "./theme";

/**
 * Layout numbers of the scene patterns that sit in the lower half of the screen, next to the Reels
 * buttons, and the text fitting used by cards (F22b review). Pure: no React, so
 * tests/video-layout.test.ts checks every right edge against the Reels safe zone.
 *
 * All right sides derive from LAYOUT.safeRight: an element's right edge, including its own pop or
 * "active" scale, stays at or left of it, and the scene camera (zoom and drift) then keeps it left of
 * the buttons (LAYOUT.safeEdge, x 940).
 */

/** The scene camera (scenes/shared.tsx heroCamera): punch-in on a new hero, slow push-in, handheld drift. */
export const CAMERA = {
  punchZoom: 1.035,
  pushZoom: 1.02,
  /** withDrift amount: ±6 px × amount sideways, zoom × (1 ± 0.006 × amount). */
  drift: 0.5,
} as const;
export const CAMERA_MAX_ZOOM = CAMERA.punchZoom * (1 + 0.006 * CAMERA.drift);
export const CAMERA_MAX_DRIFT_X = 6 * CAMERA.drift;

/** Where x (before the camera) can end up on screen at the camera's widest zoom and drift. */
export const onScreenRight = (x: number) => LAYOUT.width / 2 + (x - LAYOUT.width / 2) * CAMERA_MAX_ZOOM + CAMERA_MAX_DRIFT_X;

/** ui.tsx Card: its pop overshoot (× 1.0024) times its "active" growth (× 1.025), around its centre. */
export const CARD_MAX_SCALE = (0.94 + 0.06 * 1.04) * 1.025;
/** The right edge of a card at its largest. */
export const cardRight = (left: number, width: number) => left + width / 2 + (width / 2) * CARD_MAX_SCALE;
/** The widest card that starts at `left` and stays inside LAYOUT.safeRight at its largest. */
export const cardWidthFrom = (left: number) => Math.floor((LAYOUT.safeRight - left) / (0.5 + 0.5 * CARD_MAX_SCALE));

/** Full-width cards: the step card (step sequence) and the takeaway checklist rows. */
export const WIDE_CARD = { left: 95, width: cardWidthFrom(95) } as const;
/** The chart's big count-up card. */
export const VALUE_CARD = { left: 100, width: cardWidthFrom(100) } as const;

/** Two card columns (comparison points, labeled-diagram parts); a lone last part card is centred under them. */
const COLUMN_GAP = 37;
/** Two equal columns from x 75 whose right card, at its largest, ends at LAYOUT.safeRight. */
const COLUMN_WIDTH = Math.floor((LAYOUT.safeRight - 75 - COLUMN_GAP) / (1.5 + 0.5 * CARD_MAX_SCALE));
export const COLUMNS = [
  { x: 75, width: COLUMN_WIDTH },
  { x: 75 + COLUMN_WIDTH + COLUMN_GAP, width: COLUMN_WIDTH },
] as const;
/** The x between the two columns (the comparison's VS badge). */
export const COLUMNS_MIDDLE = 75 + COLUMN_WIDTH + COLUMN_GAP / 2;
export const LONE_PART = { x: 300, width: 460 } as const;

/** Comparison point cards: padding, the check mark and the gap beside the text (Comparison.tsx). */
export const POINT_CARD = { padding: 14, mark: 50, gap: 12 } as const;
export const pointTextBox = (rowH: number): TextBox => ({
  width: COLUMN_WIDTH - 2 * POINT_CARD.padding - POINT_CARD.mark - POINT_CARD.gap,
  height: rowH - 12,
  max: 46,
  min: 32,
  lineHeight: 1.1,
});

/**
 * Comparison (vertical): each column's hero and name at the top, then ALL its points as cards down to
 * y 1270. More than 3 points in a column, or a point that would not fit its card, makes the heroes
 * smaller so the points get more room.
 */
export function comparisonLayout(points: readonly (readonly string[])[]) {
  const most = Math.max(1, ...points.map((list) => list.length));
  const make = (compact: boolean) => {
    const heroSize = compact ? 220 : 340;
    const heroY = LAYOUT.top + (compact ? 130 : 190);
    const titleTop = heroY + heroSize / 2 + 2;
    const pointsTop = titleTop + 146;
    const gap = compact ? 10 : 14;
    const rowH = Math.min(compact ? 190 : 160, (1270 - pointsTop - (most - 1) * gap) / most);
    const clipped = points.some((list) => list.some((label) => fitBox(label, pointTextBox(rowH)).clipped));
    return { compact, heroSize, heroY, titleTop, titleMax: compact ? 46 : 54, pointsTop, gap, rowH, clipped };
  };
  const normal = make(false);
  return most > 3 || normal.clipped ? make(true) : normal;
}

/** Takeaway checklist rows: shorter rows for 3-4 rows. The text: the card minus its padding (2 × 32), the check (84) and the gap (28). */
export const takeawayRows = (count: number) => ({ rowH: count >= 3 ? 112 : 136, font: count >= 3 ? 46 : 52 });
export const bulletTextBox = (rowH: number, font: number): TextBox => ({ width: WIDE_CARD.width - 64 - 84 - 28, height: rowH - 12, max: font, min: 32, lineHeight: 1.1 });

/** Labeled-diagram part cards: shorter rows for 3 rows. The text: the card minus its padding (2 × 22), the dot (18) and the gap (16). */
export const partRowHeight = (rows: number) => (rows >= 3 ? 116 : 132);
export const partTextBox = (cardWidth: number, rowH: number): TextBox => ({ width: cardWidth - 78, height: rowH - 12, max: 50, min: 32, lineHeight: 1.08 });

/** Process flow: the numbered step rail, centred under the captions (CAPTION_STYLE.centerX 515). */
export const RAIL = { left: 180, right: LAYOUT.safeRight - 70, y: 1130 } as const;
/** A rail node grows to this at most (pop overshoot × "active" growth). */
export const RAIL_NODE_MAX_SCALE = 1.05 * 1.12;

/**
 * Node centres and size for `n` steps. The size shrinks with the spacing (6-7 steps), so connectors
 * keep a positive length and an active (grown) node never touches its neighbour; the arrow scales
 * down with the space between two nodes.
 */
export function railLayout(n: number): { xs: number[]; size: number; arrowScale: number; spacing: number } {
  const spacing = n > 1 ? (RAIL.right - RAIL.left) / (n - 1) : 0;
  const base = n <= 4 ? 108 : 92;
  const size = n > 1 ? Math.min(base, Math.floor(spacing * 0.6)) : base;
  const xs = Array.from({ length: n }, (_, i) => (n === 1 ? (RAIL.left + RAIL.right) / 2 : RAIL.left + i * spacing));
  const arrowScale = n > 1 ? Math.min(1, Math.max(0.45, (spacing - size) / 75)) : 1;
  return { xs, size, arrowScale, spacing };
}

/** The start and end of the connector from node i to node i + 1 (the arrow tip reaches the next node's edge). */
export function railConnector(layout: ReturnType<typeof railLayout>, i: number): { x1: number; x2: number } {
  const { xs, size, arrowScale } = layout;
  return { x1: xs[i]! + size / 2 + 12 * arrowScale, x2: xs[i + 1]! - size / 2 - 22 * arrowScale };
}

/** Timeline: the line from the first to the last milestone, centred under the captions. */
export const TIMELINE = { left: 160, right: LAYOUT.safeRight - 50, lineY: 1080, labelWidth: 760 } as const;
/** A milestone's glow ring (r 34) at its largest (pop overshoot × "active" growth). */
export const MILESTONE_MAX_RADIUS = 34 * 1.08 * 1.3;

/** Chart bars or line points, and the label of the value being named under them. */
export const SERIES = { left: 130, right: LAYOUT.safeRight - 20 } as const;
export const SERIES_LABEL = { left: 160, width: LAYOUT.safeRight - 160 } as const;

/** Hook: the subtitle pill, centred on the frame. */
export const HOOK_SUBTITLE_WIDTH = 2 * (LAYOUT.safeRight - LAYOUT.width / 2);

// ---------- text that must fit a box ----------

/** Inter ExtraBold (800) is about 7% wider than the SemiBold widths of the caption estimate. */
const EXTRA_BOLD = 1.07;

/** Lines `text` takes at `size` px in `width` px (greedy word wrap, like the browser). */
export function wrapLines(text: string, size: number, width: number): number {
  let lines = 1;
  let line = "";
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && estimateTextWidth(next, size) * EXTRA_BOLD > width) {
      lines++;
      line = word;
    } else {
      line = next;
    }
  }
  return lines;
}

export interface TextBox {
  width: number;
  height: number;
  max: number;
  min: number;
  lineHeight: number;
}

/**
 * The biggest font size (from `max` down to `min`, 2 px steps) at which `text` fits `height` px of
 * `width` px lines. `maxLines` is how many lines the box holds at that size: the text is cut off
 * after them (ui.tsx BoxText), so it never spills out of its card. `clipped` when it does not fit
 * even at `min`.
 */
export function fitBox(text: string, box: TextBox): { size: number; lines: number; maxLines: number; clipped: boolean } {
  const maxLines = (size: number) => Math.max(1, Math.floor(box.height / (size * box.lineHeight)));
  for (let size = box.max; size >= box.min; size -= 2) {
    const lines = wrapLines(text, size, box.width);
    if (lines <= maxLines(size)) return { size, lines, maxLines: maxLines(size), clipped: false };
  }
  return { size: box.min, lines: wrapLines(text, box.min, box.width), maxLines: maxLines(box.min), clipped: true };
}
