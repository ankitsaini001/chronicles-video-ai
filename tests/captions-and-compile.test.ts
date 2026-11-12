import { describe, expect, it } from "vitest";
import { CaptionTrackSchema, TimelineSchema } from "../src/contracts";
import { hashPlan } from "../src/planning";
import { sha256 } from "../src/shared/hash";
import {
  breakLines,
  compileTimeline,
  DEFAULT_CAPTION_LAYOUT,
  estimateTextWidth,
  groupPhrases,
  startFrameOf,
  synthesizeSceneAlignment,
  timeSceneBlocks,
  type CaptionWord,
} from "../src/timing";
import { validPlan } from "./helpers";

const words = (text: string): CaptionWord[] => text.split(" ").map((w, i) => ({ text: w, startSec: i * 0.4, endSec: i * 0.4 + 0.35 }));
const layout = DEFAULT_CAPTION_LAYOUT;
const isNumber = (w: string | undefined) => !!w && /^\d/.test(w);
const isUnit = (w: string | undefined) => !!w && /^(percent|rupees|crore|km)\b/.test(w);

function compileFixture() {
  const plan = validPlan();
  const alignments = Object.fromEntries(plan.scenes.map((s) => [s.id, synthesizeSceneAlignment(s, plan.language)]));
  return { plan, alignments, ...compileTimeline({ plan, planHash: hashPlan(plan), alignments }) };
}

describe("caption line breaking", () => {
  it("keeps a short phrase on one line", () => {
    expect(breakLines(["It", "starts", "with", "the", "Sun."], layout)).toEqual([["It", "starts", "with", "the", "Sun."]]);
  });

  it("never splits a number from its unit across lines", () => {
    const narrow = { ...layout, maxLineWidthPx: estimateTextWidth("About 2 percent is frozen", layout.fontSizePx) + 1 };
    for (let n = 3; n < 12; n++) {
      const phrase = "Only about 97 percent of the water on Earth is salty and cold".split(" ").slice(0, n);
      const lines = breakLines(phrase, narrow);
      if (!lines || lines.length < 2) continue;
      expect(isNumber(lines[0]!.at(-1)) && isUnit(lines[1]![0])).toBe(false);
    }
  });

  it("avoids a lone last word when another break fits", () => {
    const lines = breakLines("The water you drink may once have been a cloud.".split(" "), layout)!;
    expect(lines).toHaveLength(2);
    expect(lines[1]!.length).toBeGreaterThan(1);
    expect(lines[0]!.length).toBeGreaterThan(1);
  });

  it("returns null when a phrase cannot fit in two lines", () => {
    expect(breakLines("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen".split(" "), layout)).toBeNull();
  });
});

describe("caption phrase grouping", () => {
  it("never ends a phrase between a number and its unit", () => {
    const narrow = { ...layout, maxLineWidthPx: 300 }; // "97 percent" still fits on one line
    const phrases = groupPhrases(words("Around 1 percent is fresh water and about 2 percent is frozen and about 97 percent is salty"), narrow);
    phrases.forEach((phrase, i) => {
      const next = phrases[i + 1];
      if (next) expect(isNumber(phrase.at(-1)!.text) && isUnit(next[0]!.text)).toBe(false);
    });
  });

  it("splits at sentence ends and keeps every phrase within two lines", () => {
    const phrases = groupPhrases(words("This is condensation. When the droplets join and become too heavy to float, they fall as rain, snow or hail. That is precipitation."), layout);
    for (const phrase of phrases) expect(breakLines(phrase.map((w) => w.text), layout)).not.toBeNull();
    expect(phrases[0]!.map((w) => w.text).join(" ")).toBe("This is condensation.");
    expect(phrases.at(-1)!.map((w) => w.text).join(" ")).toBe("That is precipitation.");
  });

  it("merges a one-word phrase into a neighbour when it fits", () => {
    const phrases = groupPhrases(words("Look. The water keeps moving."), layout);
    expect(phrases.every((p) => p.length > 1)).toBe(true);
  });

  it("estimates Devanagari width with zero-width marks", () => {
    expect(estimateTextWidth("क्", 50)).toBe(estimateTextWidth("क", 50)); // virama takes no width
    expect(estimateTextWidth("कें", 50)).toBe(estimateTextWidth("क", 50)); // matra above + anusvara take no width
    expect(estimateTextWidth("का", 50)).toBeGreaterThan(estimateTextWidth("क", 50)); // spacing matra does
    expect(estimateTextWidth("पानी", 50)).toBeGreaterThan(0);
  });
});

describe("timeline compiler", () => {
  it("produces schema-valid timeline and captions for the fixture, with every caption at most 2 lines", () => {
    const { timeline, captions } = compileFixture();
    expect(TimelineSchema.parse(timeline)).toEqual(timeline);
    expect(CaptionTrackSchema.parse(captions)).toEqual(captions);
    expect(timeline.timingSource).toBe("synthetic-silent-fixture");
    expect(captions.timingSource).toBe("synthetic-silent-fixture");
    for (const caption of captions.captions) {
      expect(caption.lines.length).toBeLessThanOrEqual(2);
      expect(caption.endFrame).toBeGreaterThan(caption.startFrame);
      for (const line of caption.lines) expect(estimateTextWidth(line, layout.fontSizePx)).toBeLessThanOrEqual(layout.maxLineWidthPx);
    }
    // Captions use the display form: "97%" not "97 percent".
    expect(captions.captions.some((c) => c.text.includes("97%"))).toBe(true);
    expect(captions.captions.some((c) => c.text.includes("97 percent"))).toBe(false);
    // Captions are ordered and never overlap.
    captions.captions.forEach((c, i) => {
      const next = captions.captions[i + 1];
      if (next) expect(next.startFrame).toBeGreaterThanOrEqual(c.endFrame);
    });
  });

  it("resolves each event to floor(phrase start) / ceil(phrase end) of its anchor", () => {
    const { plan, alignments, timeline } = compileFixture();
    const chart = plan.scenes.find((s) => s.id === "scene-earth-water")!;
    const blocks = timeSceneBlocks(chart, alignments[chart.id]!, "en");
    const tokens = blocks[0]!.textTokens;
    const ninetySeven = tokens.find((t) => t.text === "97")!;
    const compiledScene = timeline.scenes.find((s) => s.sceneId === chart.id)!;
    const event = compiledScene.events.find((e) => e.id === "ev-oceans")!;
    expect(event.startFrame).toBe(compiledScene.startFrame + startFrameOf(ninetySeven.startSec));
    expect(event.action).toBe("grow");
    // The bar appears with its grow event (an entrance action).
    expect(compiledScene.objects.find((o) => o.id === "bar-oceans")!.revealFrame).toBe(event.startFrame);
  });

  it("reveals objects without entrance events in order and before their first event", () => {
    const { timeline } = compileFixture();
    const hook = timeline.scenes[0]!;
    const question = hook.objects.find((o) => o.id === "hook-question")!;
    const raindrop = hook.objects.find((o) => o.id === "hook-raindrop")!;
    const pulse = hook.events.find((e) => e.target === "hook-raindrop")!;
    expect(raindrop.revealFrame).toBeGreaterThan(question.revealFrame);
    expect(raindrop.revealFrame).toBeLessThan(pulse.startFrame);
    const diagram = timeline.scenes.find((s) => s.type === "labeled-diagram")!;
    expect(diagram.objects.find((o) => o.kind === "diagram")!.revealFrame).toBe(diagram.startFrame);
  });

  it("is deterministic: the same input gives a byte-identical timeline.json and captions.json", () => {
    const a = compileFixture();
    const b = compileFixture();
    const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    expect(sha256(serialize(a.timeline))).toBe(sha256(serialize(b.timeline)));
    expect(sha256(serialize(a.captions))).toBe(sha256(serialize(b.captions)));
    expect(sha256(serialize(a.alignments))).toBe(sha256(serialize(b.alignments)));
  });

  it("rejects a scene without alignment and mixed timing sources", () => {
    const { plan, alignments } = compileFixture();
    const missing = { ...alignments };
    delete missing["scene-hook"];
    expect(() => compileTimeline({ plan, planHash: hashPlan(plan), alignments: missing })).toThrow(/has no alignment/);
    const mixed = { ...alignments, "scene-hook": { ...alignments["scene-hook"]!, source: "elevenlabs" as const } };
    expect(() => compileTimeline({ plan, planHash: hashPlan(plan), alignments: mixed })).toThrow(/mix timing sources/);
  });
});
