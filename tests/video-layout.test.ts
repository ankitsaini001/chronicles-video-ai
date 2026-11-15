import { describe, expect, it } from "vitest";
import {
  bulletTextBox,
  cardRight,
  CAMERA_MAX_DRIFT_X,
  CAMERA_MAX_ZOOM,
  COLUMNS,
  comparisonLayout,
  fitBox,
  HOOK_SUBTITLE_WIDTH,
  LONE_PART,
  MILESTONE_MAX_RADIUS,
  onScreenRight,
  partRowHeight,
  partTextBox,
  pointTextBox,
  RAIL,
  RAIL_NODE_MAX_SCALE,
  railConnector,
  railLayout,
  SERIES,
  SERIES_LABEL,
  takeawayRows,
  TIMELINE,
  VALUE_CARD,
  WIDE_CARD,
} from "../packages/video/src/layout";
import { LAYOUT } from "../packages/video/src/theme";
import { hashPlan, validatePlan } from "../packages/pipeline/src/planning";
import { compileTimeline, synthesizeSceneAlignment } from "../packages/pipeline/src/timing";
import { loadFixture } from "./helpers";

/** Maximum-length labels (the plan limits: 60 for points and bullets, 32 for diagram parts); also in fixtures/long-labels.plan.json. */
const LONG_POINTS = [
  ["Uses far less energy than making new plastic from crude oil.", "Keeps old bottles and bags out of our rivers, seas and parks", "Comes back as new clothes, benches, pipes and drink bottles."],
  ["Needs oil or gas pumped out of the ground before it is made.", "Every new bottle adds plastic that may end up as waste later", "Often costs less today, as collecting used plastic is costly"],
];
const LONG_BULLETS = ["Rinse every bottle and tub before it goes in a recycling bin", "Keep plastic bags apart, because they jam the sorting belts.", "Buy things made from recycled plastic to keep the loop going"];
const LONG_PARTS = ["Trucks unload on a tipping floor", "Optical scanners sort by colours", "Magnets pull out the tins & cans", "Shredders cut bottles into chips", "Hot water tanks wash every flake", "Extruders melt flakes to pellets"];

describe("video layout: the Reels safe zone on the right (F22b review)", () => {
  it("the camera's widest zoom and drift move x 920 to about 940", () => {
    expect(CAMERA_MAX_ZOOM).toBeGreaterThanOrEqual(1.035);
    expect(CAMERA_MAX_DRIFT_X).toBe(3);
    expect(LAYOUT.safeEdge).toBe(940);
    // the reviewer's check: 540 + (edge - 540) x 1.035 + 3 <= 940 (with the drift's extra zoom as well)
    expect(onScreenRight(LAYOUT.safeRight)).toBeLessThanOrEqual(LAYOUT.safeEdge);
    expect(540 + (LAYOUT.safeRight - 540) * 1.035 + 3).toBeLessThanOrEqual(940);
  });

  it("every right edge in the lower half stays left of the Reels buttons on screen", () => {
    const edges: Record<string, number> = {
      "step card, takeaway rows": cardRight(WIDE_CARD.left, WIDE_CARD.width),
      "chart count-up card": cardRight(VALUE_CARD.left, VALUE_CARD.width),
      "right column cards (comparison points, diagram parts)": cardRight(COLUMNS[1].x, COLUMNS[1].width),
      "lone diagram part": cardRight(LONE_PART.x, LONE_PART.width),
      "timeline: last milestone at its largest": TIMELINE.right + MILESTONE_MAX_RADIUS,
      "timeline: the line and its travelling light": TIMELINE.right + 30,
      "timeline label": LAYOUT.safeRight,
      "chart: baseline": SERIES.right + 10,
      "chart: label under the bars": SERIES_LABEL.left + SERIES_LABEL.width,
      "hook subtitle pill": 540 + HOOK_SUBTITLE_WIDTH / 2,
    };
    for (let n = 1; n <= 7; n++) {
      const rail = railLayout(n);
      edges[`rail of ${n}: last node at its largest`] = rail.xs[n - 1]! + (rail.size / 2) * RAIL_NODE_MAX_SCALE;
    }
    for (const [name, edge] of Object.entries(edges)) {
      expect(edge, name).toBeLessThanOrEqual(LAYOUT.safeRight);
      expect(onScreenRight(edge), name).toBeLessThanOrEqual(LAYOUT.safeEdge);
    }
    // the rail and the timeline are centred under the captions (x 515)
    expect((RAIL.left + RAIL.right) / 2).toBe(515);
    expect((TIMELINE.left + TIMELINE.right) / 2).toBe(515);
  });

  it("a rail of up to 7 steps: connectors keep a positive length and a grown node never touches its neighbour", () => {
    for (let n = 2; n <= 7; n++) {
      const rail = railLayout(n);
      for (let i = 0; i < n - 1; i++) {
        const { x1, x2 } = railConnector(rail, i);
        expect(x2 - x1, `${n} steps`).toBeGreaterThan(10);
        // the arrow tip (24 px × scale ahead of x2) stops at the next node's edge
        expect(x2 + 24 * rail.arrowScale, `${n} steps`).toBeLessThanOrEqual(rail.xs[i + 1]! - rail.size / 2 + 2);
      }
      expect((rail.size / 2) * RAIL_NODE_MAX_SCALE + (rail.size / 2) * 1.05, `${n} steps`).toBeLessThan(rail.spacing);
    }
    expect(railLayout(4).size).toBe(108); // the usual 3-4 step look is unchanged
  });
});

describe("video layout: long labels stay inside their cards (F22b review)", () => {
  it("the longest labels a plan allows fit without being cut off", () => {
    for (const label of [...LONG_POINTS.flat(), ...LONG_BULLETS]) expect(label.length).toBe(60);
    for (const label of LONG_PARTS) expect(label.length).toBe(32);

    const comparison = comparisonLayout(LONG_POINTS);
    for (const label of LONG_POINTS.flat()) expect(fitBox(label, pointTextBox(comparison.rowH)).clipped, label).toBe(false);

    const rows = takeawayRows(LONG_BULLETS.length);
    for (const label of LONG_BULLETS) expect(fitBox(label, bulletTextBox(rows.rowH, rows.font)).clipped, label).toBe(false);

    const partRowH = partRowHeight(Math.ceil(LONG_PARTS.length / 2));
    for (const label of LONG_PARTS) expect(fitBox(label, partTextBox(COLUMNS[0].width, partRowH)).clipped, label).toBe(false);
  });

  it("the long-labels fixture uses exactly these labels and is a valid plan that compiles", () => {
    const raw = loadFixture("long-labels.plan.json");
    const labels = (kind: string) => raw.scenes.flatMap((s: { objects: { kind: string; label: string }[] }) => s.objects.filter((o) => o.kind === kind).map((o) => o.label));
    expect(labels("point")).toEqual(LONG_POINTS.flat());
    expect(labels("bullet")).toEqual(LONG_BULLETS);
    expect(labels("part")).toEqual(LONG_PARTS);
    expect(labels("node")).toHaveLength(7);
    expect(labels("bar")).toHaveLength(7);
    const checked = validatePlan(raw);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const plan = checked.plan;
    const alignments = Object.fromEntries(plan.scenes.map((s) => [s.id, synthesizeSceneAlignment(s, plan.language)]));
    expect(compileTimeline({ plan, planHash: hashPlan(plan), alignments }).timeline.scenes).toHaveLength(6);
  });

  it("text that still does not fit is cut off at the box's last line (never spills out)", () => {
    const fit = fitBox("word ".repeat(60).trim(), { width: 300, height: 100, max: 46, min: 32, lineHeight: 1.1 });
    expect(fit.clipped).toBe(true);
    expect(fit.maxLines * fit.size * 1.1).toBeLessThanOrEqual(100);
  });

  it("every comparison point is drawn: more than 3 in a column makes the heroes smaller, and all rows end above the captions", () => {
    const short = (n: number) => Array.from({ length: n }, (_, i) => `Point ${i + 1}`);
    expect(comparisonLayout([short(3), short(3)]).compact).toBe(false);
    for (const n of [4, 5, 6]) {
      const layout = comparisonLayout([short(n), short(0)]);
      expect(layout.compact).toBe(true);
      expect(layout.pointsTop + n * layout.rowH + (n - 1) * layout.gap).toBeLessThanOrEqual(1270.001);
      expect(layout.rowH).toBeGreaterThan(70);
    }
  });
});
