import { describe, expect, it } from "vitest";
import { checkDisplayScript, countPhrase, formatIssue, validatePlan } from "../packages/pipeline/src/planning";
import { loadFixture } from "./helpers";

function issuesFor(raw: unknown) {
  const result = validatePlan(raw);
  if (result.ok) throw new Error("expected the plan to be invalid");
  return result.issues;
}

describe("valid fixture", () => {
  it("passes schema and semantic validation with a plausible 60-90 s estimate", () => {
    const result = validatePlan(loadFixture("water-cycle.plan.json"));
    expect(result.ok).toBe(true);
    expect(result.stats).toEqual({ sceneCount: 6, wordCount: 204, estimatedSeconds: 81.6 });
  });
});

describe("invalid fixtures produce one clear error each", () => {
  it("missing anchor phrase", () => {
    const issues = issuesFor(loadFixture("invalid-missing-anchor.plan.json"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ sceneId: "scene-evaporation", path: "scenes[1].events[2].anchor.phrase" });
    expect(formatIssue(issues[0]!)).toContain('phrase "boils instantly" was not found in narration block "line-evap-heat"');
  });

  it("bad event target", () => {
    const issues = issuesFor(loadFixture("invalid-bad-target.plan.json"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ sceneId: "scene-precipitation", path: "scenes[3].events[1].target" });
    expect(issues[0]!.message).toContain('target "lightning" is not an object in this scene');
  });

  it("wrong first and last scene", () => {
    const issues = issuesFor(loadFixture("invalid-wrong-first-last.plan.json"));
    expect(issues.map((i) => i.message)).toEqual([
      'the first scene must be "title-hook", but it is "process-flow"',
      'the last scene must be "takeaway", but it is "chart"',
    ]);
  });

  it("Hinglish display text in Devanagari", () => {
    const issues = issuesFor(loadFixture("invalid-hinglish-devanagari.plan.json"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ sceneId: "scene-hook", path: "scenes[0].narration[0].display" });
    expect(issues[0]!.message).toContain("Hinglish on-screen text must be in Roman script");
  });

  it("the Hinglish fixture becomes valid once display is Roman (Devanagari in speech is allowed)", () => {
    const raw = loadFixture("invalid-hinglish-devanagari.plan.json");
    raw.scenes[0].narration[0].display = null;
    expect(validatePlan(raw).ok).toBe(true);
  });
});

describe("other semantic rules", () => {
  it("rejects a kind or action that is not in the catalog for the pattern", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.scenes[0].objects[1].kind = "bar";
    raw.scenes[0].events[0].action = "explode";
    const messages = issuesFor(raw).map((i) => i.message);
    expect(messages).toContainEqual(expect.stringContaining('kind "bar" is not allowed in a title-hook scene'));
    expect(messages).toContainEqual(expect.stringContaining('action "explode" is not allowed in a title-hook scene'));
  });

  it("enforces label length, object counts and chart values", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.scenes[1].objects[0].label = "A very long label that will not fit on screen";
    raw.scenes[4].objects[1].value = null;
    raw.scenes[2].objects = raw.scenes[2].objects.filter((o: { kind: string }) => o.kind !== "diagram");
    raw.scenes[2].events = raw.scenes[2].events.filter((e: { target: string }) => e.target !== "cloud");
    const messages = issuesFor(raw).map((i) => i.message);
    expect(messages).toContainEqual(expect.stringContaining("the limit for a icon is 32"));
    expect(messages).toContainEqual(expect.stringContaining("a bar needs a numeric value"));
    expect(messages).toContainEqual(expect.stringContaining('needs exactly 1 "diagram" object(s), but has 0'));
  });

  it("flags a script that is far too short for 60-90 s", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.scenes = [raw.scenes[0], raw.scenes[1], raw.scenes[5]];
    const messages = issuesFor(raw).map((i) => i.message);
    expect(messages).toContainEqual(expect.stringMatching(/estimated narration length is .* Expand the explanation/));
  });

  it("flags a voice preset that does not match the language", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.voicePreset = "hindi-female";
    expect(issuesFor(raw)[0]).toMatchObject({ path: "voicePreset" });
  });

  it("flags an ambiguous anchor phrase that appears twice", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.scenes[2].events[2].anchor.phrase = "droplets";
    expect(issuesFor(raw)[0]!.message).toContain("appears 2 times");
  });
});

describe("helpers", () => {
  it("matches whole phrases only, ignoring case and extra whitespace", () => {
    expect(countPhrase("It starts with the Sun. When sunlight heats oceans", "the sun")).toBe(1);
    expect(countPhrase("When sunlight heats oceans", "sun")).toBe(0);
    expect(countPhrase("move   faster", "Move faster")).toBe(1);
  });

  it("checks scripts per language", () => {
    expect(checkDisplayScript("जल चक्र", "hi")).toBeNull();
    expect(checkDisplayScript("DNA की संरचना और कार्य", "hi")).toBeNull();
    expect(checkDisplayScript("The water cycle", "hi")).toMatch(/Devanagari/);
    expect(checkDisplayScript("Paani ka safar", "hinglish")).toBeNull();
    expect(checkDisplayScript("पानी ka safar", "hinglish")).toMatch(/Roman script/);
    expect(checkDisplayScript("The water cycle", "en")).toBeNull();
  });
});
