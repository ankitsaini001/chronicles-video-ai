import { PlanSchema, type CaptionTrack, type SceneType, type Timeline, type TimelineScene } from "../../packages/pipeline/src/contracts";
import { CAPTION_STYLE } from "../../packages/pipeline/src/theme";
import { breakLines, compileTimeline, synthesizeSceneAlignment, WIDTH_METHOD } from "../../packages/pipeline/src/timing";
import waterCyclePlan from "../../fixtures/water-cycle.plan.json";

/**
 * Studio preview data. Not pipeline output and never written to a run folder.
 *
 * - waterCycleFixture(): the water-cycle fixture plan compiled with SYNTHETIC SILENT timing, in the
 *   browser, so `npm run studio` shows the same video the render-fixture command produces.
 * - patternGallery(): hand-made sample scenes for all 8 patterns, 5 s each, to review components
 *   the water-cycle fixture does not use (comparison, timeline, step-sequence, other chart types).
 * - devanagariSample(): a Hindi caption and labels for checking conjuncts and matras.
 */

const PREVIEW_HASH = `sha256:${"0".repeat(64)}`;

export function waterCycleFixture(): { timeline: Timeline; captions: CaptionTrack } {
  const plan = PlanSchema.parse(waterCyclePlan);
  const alignments = Object.fromEntries(plan.scenes.map((s) => [s.id, synthesizeSceneAlignment(s, plan.language)]));
  return compileTimeline({ plan, planHash: PREVIEW_HASH, alignments });
}

type SampleObject = [id: string, kind: string, label: string, value?: number];
type SampleEvent = [target: string, action: string, atFrame: number, frames?: number];

const SCENE_FRAMES = 150;

function sampleScene(index: number, type: SceneType, objects: SampleObject[], events: SampleEvent[]): TimelineScene {
  const start = index * SCENE_FRAMES;
  const timed = events.map(([target, action, at, frames = 15], i) => ({
    id: `ev-${index}-${i}`,
    action,
    target,
    narrationId: "sample",
    phrase: "sample",
    startFrame: start + at,
    endFrame: start + at + frames,
  }));
  return {
    sceneId: `sample-${type}`,
    type,
    startFrame: start,
    durationFrames: SCENE_FRAMES,
    audioDurationSeconds: SCENE_FRAMES / 30,
    holdMs: 0,
    audioKey: null,
    objects: objects.map(([id, kind, label, value], i) => {
      const entrance = timed.find((e) => e.target === id && ["appear", "grow", "count-up", "rise", "fall", "flow", "gather", "point-to", "advance"].includes(e.action));
      return { id, kind, label, icon: null, value: value ?? null, revealFrame: entrance ? entrance.startFrame : start + 4 + i * 10 };
    }),
    events: timed,
  };
}

const GALLERY: [SceneType, SampleObject[], SampleEvent[]][] = [
  ["title-hook", [["q", "subtitle", "Why does a savings account pay so little?"], ["i", "icon", "Money"], ["h", "headline", "Savings vs Fixed Deposit"]], [["q", "appear", 5], ["i", "pulse", 50], ["h", "appear", 70]]],
  ["comparison", [
    ["a", "column", "Savings account"], ["a1", "point", "Withdraw any time"], ["a2", "point", "About 3% interest"],
    ["b", "column", "Fixed deposit"], ["b1", "point", "Money locked for a term"], ["b2", "point", "About 7% interest"],
  ], [["a1", "check", 40], ["a2", "cross", 60], ["b1", "cross", 80], ["b2", "check", 100]]],
  ["timeline", [["ax", "axis", "History of the internet"], ["m1", "milestone", "1969 · ARPANET"], ["m2", "milestone", "1991 · World Wide Web"], ["m3", "milestone", "2007 · Smartphones"], ["m4", "milestone", "2016 · Cheap mobile data in India"]],
    [["ax", "appear", 2], ["m1", "advance", 20], ["m2", "advance", 45], ["m3", "advance", 70], ["m4", "advance", 95], ["m4", "highlight", 110]]],
  ["step-sequence", [["ic", "icon", "Solve a quadratic"], ["s1", "step", "Write it as ax² + bx + c = 0"], ["s2", "step", "Find the discriminant b² − 4ac"], ["s3", "step", "Use the formula for both roots"]],
    [["s1", "appear", 15], ["s1", "complete", 50], ["s2", "appear", 55], ["s2", "highlight", 70], ["s3", "appear", 95]]],
  ["chart", [["ax", "axis", "India's population (crore)"], ["p1", "line-point", "1951", 36], ["p2", "line-point", "1981", 68], ["p3", "line-point", "2011", 121], ["p4", "line-point", "2024", 144]],
    [["p1", "grow", 10], ["p2", "grow", 35], ["p3", "grow", 60], ["p4", "grow", 85], ["p4", "highlight", 110]]],
  ["chart", [["ax", "axis", "Monthly budget (%)"], ["s1", "pie-slice", "Rent", 40], ["s2", "pie-slice", "Food", 25], ["s3", "pie-slice", "Savings", 20], ["s4", "pie-slice", "Other", 15], ["c1", "counter", "Saved every month", 20]],
    [["s1", "grow", 10], ["s2", "grow", 30], ["s3", "grow", 50], ["s4", "grow", 70], ["c1", "count-up", 90, 30], ["s3", "highlight", 110]]],
  ["labeled-diagram", [["d", "diagram", "Plant leaf"], ["p1", "part", "Sunlight"], ["p2", "part", "Carbon dioxide"], ["p3", "part", "Water from roots"], ["p4", "part", "Oxygen out"], ["ar", "arrow", "Photosynthesis"]],
    [["p1", "appear", 15], ["p2", "appear", 35], ["p3", "appear", 55], ["p4", "appear", 75], ["ar", "point-to", 95], ["d", "highlight", 115]]],
  ["takeaway", [["h", "headline", "Pick by your goal"], ["b1", "bullet", "Need cash any time: savings account"], ["b2", "bullet", "Can wait a year or more: fixed deposit"], ["i", "icon", "Remember this"]],
    [["h", "appear", 5], ["b1", "appear", 30], ["b2", "appear", 60], ["i", "pulse", 100]]],
];

export function patternGallery(): { timeline: Timeline; captions: CaptionTrack } {
  const scenes = GALLERY.map(([type, objects, events], i) => sampleScene(i, type, objects, events));
  const totalFrames = scenes.length * SCENE_FRAMES;
  return {
    timeline: { schemaVersion: 1, fps: 30, width: 1080, height: 1920, totalFrames, language: "en", planHash: PREVIEW_HASH, timingSource: "synthetic-silent-fixture", scenes },
    captions: captionTrack("en", scenes.map((s) => ({ sceneId: s.sceneId, start: s.startFrame, end: s.startFrame + SCENE_FRAMES, text: `Sample ${s.type} scene` }))),
  };
}

/** Hindi text with conjuncts (क्ष, त्र, ज्ञ, श्र, द्ध, स्त्र) and matras for the Devanagari check. */
export const DEVANAGARI_SAMPLES = [
  "जल चक्र कैसे काम करता है?",
  "वाष्पीकरण · संघनन · वर्षण",
  "क्षेत्र, त्रिकोण, ज्ञान, श्रम",
  "शुद्ध, स्त्री, द्वार, प्रत्येक",
  "पृथ्वी का 97% पानी खारा है",
];

export function devanagariSample(): { timeline: Timeline; captions: CaptionTrack } {
  const scene = sampleScene(0, "takeaway", [
    ["h", "headline", "जल चक्र याद रखें"],
    ["b1", "bullet", "वाष्पीकरण और संघनन"],
    ["b2", "bullet", "वर्षण और संग्रहण"],
    ["i", "icon", "पानी का गिलास"],
  ], [["h", "appear", 0, 1], ["b1", "appear", 0, 1], ["b2", "appear", 0, 1], ["i", "appear", 0, 1]]);
  return {
    timeline: { schemaVersion: 1, fps: 30, width: 1080, height: 1920, totalFrames: SCENE_FRAMES, language: "hi", planHash: PREVIEW_HASH, timingSource: "synthetic-silent-fixture", scenes: [scene] },
    captions: captionTrack("hi", [{ sceneId: scene.sceneId, start: 0, end: SCENE_FRAMES, text: "पृथ्वी का लगभग 97% पानी खारा है, सिर्फ़ 1% मीठा है।" }]),
  };
}

function captionTrack(language: "en" | "hi", items: { sceneId: string; start: number; end: number; text: string }[]): CaptionTrack {
  const layout = { fontSizePx: CAPTION_STYLE.fontSizePx, maxLineWidthPx: CAPTION_STYLE.maxLineWidthPx };
  return {
    schemaVersion: 1,
    timingSource: "synthetic-silent-fixture",
    language,
    widthMethod: WIDTH_METHOD,
    fontSizePx: layout.fontSizePx,
    maxLineWidthPx: layout.maxLineWidthPx,
    captions: items.map((item, i) => ({
      id: `sample-c${i + 1}`,
      sceneId: item.sceneId,
      startFrame: item.start,
      endFrame: item.end,
      text: item.text,
      lines: (breakLines(item.text.split(" "), layout) ?? [[item.text]]).map((l) => l.join(" ")),
    })),
  };
}
