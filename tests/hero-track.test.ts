import { describe, expect, it } from "vitest";
import { CaptionTrackSchema, PlanSchema, TimelineSchema } from "../packages/pipeline/src/contracts";
import { hashPlan, sceneIcon, storyboardHeroes } from "../packages/pipeline/src/planning";
import { compileTimeline, DEFAULT_CAPTION_LAYOUT, heroTrack, keyTermTest, synthesizeSceneAlignment } from "../packages/pipeline/src/timing";
import { loadFixture } from "./helpers";

function compile(raw: unknown) {
  const plan = PlanSchema.parse(raw);
  const alignments = Object.fromEntries(plan.scenes.map((s) => [s.id, synthesizeSceneAlignment(s, plan.language)]));
  return { plan, ...compileTimeline({ plan, planHash: hashPlan(plan), alignments }) };
}

const words = (text: string, from: number, step = 10) => text.split(" ").map((w, i) => ({ text: w, frame: from + i * step }));

describe("hero track (pure)", () => {
  it("a planner-picked hero holds for its whole block, even when the words name other heroes", () => {
    const steps = heroTrack({
      sceneType: "process-flow",
      sceneStart: 100,
      blocks: [
        { narrationId: "a", hero: "chai-cup", startFrame: 104, words: words("The sun heats the ocean and clouds form", 104) },
        { narrationId: "b", hero: "dinosaur", startFrame: 300, words: words("Dinosaurs drank it", 300) },
      ],
      objects: [],
      events: [],
    });
    expect(steps).toEqual([
      { startFrame: 100, hero: "chai-cup", icon: "bulb", source: "plan" },
      { startFrame: 300, hero: "dinosaur", icon: "bulb", source: "plan" },
    ]);
  });

  it("without a pick: strong cues (events on content objects) and weak cues (spoken words), first shown from the scene start", () => {
    const steps = heroTrack({
      sceneType: "chart",
      sceneStart: 200,
      blocks: [{ narrationId: "a", startFrame: 205, words: words("Most of Earth's water sits in oceans while glaciers hold some", 205, 20) }],
      objects: [
        { id: "ocean", kind: "pie-slice", label: "Oceans (Salt)", icon: "waves" },
        { id: "ice", kind: "pie-slice", label: "Glaciers (Ice)", icon: "snowflake" },
      ],
      events: [
        { target: "ocean", startFrame: 330 },
        { target: "ice", startFrame: 420 },
      ],
    });
    // "oceans" (weak, frame 325) comes 5 frames before its own strong event, so the change happens on the word
    expect(steps.map((s) => [s.startFrame, s.hero, s.source])).toEqual([
      [200, "globe", "keyword"],
      [325, "ocean", "keyword"],
      [365, "glacier", "keyword"],
    ]);
  });

  it("a weak cue must wait MIN_HOLD frames and gives way to a strong cue that follows soon", () => {
    const steps = heroTrack({
      sceneType: "process-flow",
      sceneStart: 0,
      blocks: [{ narrationId: "a", startFrame: 0, words: [{ text: "sun", frame: 0 }, { text: "clouds", frame: 20 }, { text: "rain", frame: 100 }] }],
      objects: [{ id: "n", kind: "node", label: "Groundwater" }],
      events: [{ target: "n", startFrame: 120 }],
    });
    // "clouds" is too soon after "sun"; "rain" is skipped because the strong "Groundwater" event follows within LOOKAHEAD
    expect(steps.map((s) => s.hero)).toEqual(["sun", "groundwater"]);
  });

  it("nothing named: a label that names a hero, else the scene icon in a medallion", () => {
    const labelOnly = heroTrack({
      sceneType: "comparison",
      sceneStart: 0,
      blocks: [{ narrationId: "a", startFrame: 0, words: words("Here is the difference", 0) }],
      objects: [{ id: "c1", kind: "column", label: "Savings account" }],
      events: [],
    });
    expect(labelOnly).toEqual([{ startFrame: 0, hero: "piggy-bank", icon: "bank", source: "keyword" }]);
    const none = heroTrack({
      sceneType: "step-sequence",
      sceneStart: 50,
      blocks: [{ narrationId: "a", startFrame: 52, words: words("First do this then that", 52) }],
      objects: [{ id: "s1", kind: "step", label: "Do this", icon: "check" }],
      events: [],
    });
    expect(none).toEqual([{ startFrame: 50, hero: null, icon: "check", source: "icon" }]);
  });

  it("a labeled diagram keeps its own object as the hero when the planner picked none", () => {
    const base = {
      sceneType: "labeled-diagram" as const,
      sceneStart: 0,
      objects: [{ id: "d", kind: "diagram", label: "Cloud" }, { id: "p", kind: "part", label: "Tiny droplets" }],
      events: [{ target: "p", startFrame: 60 }],
    };
    const words = [{ text: "vapour", frame: 10 }, { text: "droplets", frame: 60 }];
    expect(heroTrack({ ...base, blocks: [{ narrationId: "a", startFrame: 0, words }] }).map((s) => s.hero)).toEqual(["cloud"]);
    // a planner pick still wins for its block; the other block keeps the diagram's object
    const mixed = heroTrack({ ...base, blocks: [{ narrationId: "a", hero: "sun", startFrame: 0, words: [] }, { narrationId: "b", startFrame: 100, words }] });
    expect(mixed.map((s) => [s.hero, s.source])).toEqual([["sun", "plan"], ["cloud", "keyword"]]);
  });

  it("a takeaway keeps one hero", () => {
    const steps = heroTrack({
      sceneType: "takeaway",
      sceneStart: 0,
      blocks: [{ narrationId: "a", startFrame: 0, words: words("Earth recycles water from oceans to clouds to rain", 0, 40) }],
      objects: [],
      events: [],
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.hero).toBe("globe");
  });

  it("the scene icon prefers icon objects, then the subject (diagram, headline, ...)", () => {
    expect(sceneIcon([{ kind: "node", label: "Sun" }, { kind: "icon", label: "x", icon: "coin" }])).toBe("coin");
    expect(sceneIcon([{ kind: "part", label: "x" }, { kind: "diagram", label: "Bank" }])).toBe("bank");
    expect(sceneIcon([])).toBe("bulb");
  });

  it("the storyboard names a scene's heroes: picks, else heroes the narration names, else the icon", () => {
    expect(storyboardHeroes({ narration: [{ text: "Clouds form", hero: "chai-cup" }, { text: "The sun heats the sea" }], objects: [] })).toEqual(["chai cup", "sun", "ocean"]);
    expect(storyboardHeroes({ narration: [{ text: "Sun, sea, clouds and rain" }], objects: [] }, 2)).toEqual(["sun", "ocean…"]);
    expect(storyboardHeroes({ narration: [{ text: "Here is the difference" }], objects: [{ kind: "column", label: "Savings account" }] })).toEqual(["piggy bank"]);
    expect(storyboardHeroes({ narration: [{ text: "Do this then that" }], objects: [{ kind: "step", label: "First", icon: "check" }] })).toEqual(["check icon"]);
  });
});

describe("compiled timeline v2 (heroes) and captions (3-5 word phrases with word timings)", () => {
  it("every scene has a hero track starting at its first frame; the timeline and captions parse as v2", () => {
    const { timeline, captions } = compile(loadFixture("water-cycle.plan.json"));
    expect(timeline.schemaVersion).toBe(2);
    expect(captions.schemaVersion).toBe(2);
    expect(TimelineSchema.parse(timeline)).toEqual(timeline);
    expect(CaptionTrackSchema.parse(captions)).toEqual(captions);
    for (const scene of timeline.scenes) {
      expect(scene.heroes[0]!.startFrame).toBe(scene.startFrame);
      for (const [i, step] of scene.heroes.entries()) {
        expect(step.startFrame).toBeLessThan(scene.startFrame + scene.durationFrames);
        if (i > 0) {
          expect(step.startFrame).toBeGreaterThan(scene.heroes[i - 1]!.startFrame);
          expect(step.hero).not.toBe(scene.heroes[i - 1]!.hero);
        }
      }
    }
  });

  it("backward compatible: an old plan without heroes compiles with keyword heroes; a picked hero is used", () => {
    const raw = loadFixture("water-cycle.plan.json");
    const before = compile(raw).timeline.scenes[0]!.heroes;
    expect(before.every((s) => s.source !== "plan")).toBe(true);
    raw.scenes[0].narration[0].hero = "question-mark";
    const after = compile(raw).timeline.scenes[0]!.heroes;
    expect(after[0]).toMatchObject({ hero: "question-mark", source: "plan" });
  });

  it("captions are 3-5 word phrases (a shorter sentence stays whole) whose words match the text and lines in order", () => {
    const { captions } = compile(loadFixture("water-cycle.plan.json"));
    for (const caption of captions.captions) {
      expect(caption.words.length).toBeLessThanOrEqual(DEFAULT_CAPTION_LAYOUT.maxWords!);
      expect(caption.words.map((w) => w.text).join(" ")).toBe(caption.text);
      expect(caption.lines.join(" ")).toBe(caption.text);
      for (const w of caption.words) {
        expect(w.endFrame).toBeGreaterThan(w.startFrame);
        expect(w.startFrame).toBeGreaterThanOrEqual(caption.startFrame);
      }
    }
    const short = captions.captions.filter((c) => c.words.length < 3);
    // only where the sentence (or what is left of it) is shorter than 3 words
    expect(short.length).toBeLessThan(captions.captions.length / 5);
  });

  it("key terms: numbers and words from the scene's labels, never topic words or stopwords", () => {
    const plan = PlanSchema.parse(loadFixture("water-cycle.plan.json"));
    const isKey = keyTermTest(plan);
    const scene = { objects: [{ label: "Water vapour" }, { label: "Sunlight" }] } as never;
    expect(isKey(scene, "97%")).toBe(true);
    expect(isKey(scene, "vapour.")).toBe(true);
    expect(isKey(scene, "Sun")).toBe(true);
    expect(isKey(scene, "water")).toBe(false); // a topic word
    expect(isKey(scene, "the")).toBe(false);
    expect(isKey(scene, "ocean")).toBe(false);
  });

  it("is deterministic", () => {
    const a = compile(loadFixture("water-cycle.plan.json"));
    const b = compile(loadFixture("water-cycle.plan.json"));
    expect(JSON.stringify(a.timeline)).toBe(JSON.stringify(b.timeline));
    expect(JSON.stringify(a.captions)).toBe(JSON.stringify(b.captions));
  });
});
