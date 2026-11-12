import { describe, expect, it } from "vitest";
import { PlanSchema } from "../src/contracts";
import {
  assemblePlan,
  buildSystemInstruction,
  hashPlan,
  iconFor,
  looksLikeKeywordList,
  plannerOutputJsonSchema,
  renderPlanReview,
  validatePlan,
} from "../src/planning";
import { compileTimeline, synthesizeSceneAlignment } from "../src/timing";
import { loadFixture, validPlan } from "./helpers";
import { modelOutputFromFixture } from "./planner-helpers";

describe("object icon field", () => {
  it("is optional: a plan without icons parses without the key and keeps its hash", () => {
    const raw = loadFixture("water-cycle.plan.json");
    const plan = PlanSchema.parse(raw);
    expect(plan.scenes.flatMap((s) => s.objects).some((o) => "icon" in o)).toBe(false);
    const withUndefined = PlanSchema.parse(structuredClone(raw));
    expect(hashPlan(withUndefined)).toBe(hashPlan(plan));
    // Adding an icon is a real change (new hash).
    const withIcon = structuredClone(raw);
    withIcon.scenes[0].objects[0].icon = "sun";
    expect(hashPlan(PlanSchema.parse(withIcon))).not.toBe(hashPlan(plan));
  });

  it("must come from the local icon set", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.scenes[0].objects[0].icon = "rocket";
    const result = validatePlan(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.message).toMatch(/unknown icon "rocket"; allowed icons: sun/);
  });

  it("the renderer prefers the explicit icon and falls back to label keywords", () => {
    expect(iconFor({ label: "Ocean", icon: "sun" })).toBe("sun");
    expect(iconFor({ label: "Ocean" })).toBe("waves");
    expect(iconFor({ label: "Something", icon: null }, null)).toBeNull();
    const plan = validPlan();
    plan.scenes[0]!.objects[0]!.icon = "star";
    const alignments = Object.fromEntries(plan.scenes.map((s) => [s.id, synthesizeSceneAlignment(s, plan.language)]));
    const { timeline } = compileTimeline({ plan, planHash: hashPlan(plan), alignments });
    expect(timeline.scenes[0]!.objects[0]!.icon).toBe("star");
    expect(timeline.scenes[1]!.objects[0]!.icon).toBeNull();
  });

  it('the planner writes an icon or "none" for every object, and "none" never reaches the plan', () => {
    const schema = plannerOutputJsonSchema() as any;
    const object = schema.properties.scenes.items.properties.objects.items;
    expect(object.required).toContain("icon");
    expect(object.properties.icon.enum).toEqual(expect.arrayContaining(["sun", "none"]));
    const output = modelOutputFromFixture();
    output.scenes[0].objects[0].icon = "sun";
    const { plan } = assemblePlan(output, { ownerId: "o", projectId: "p", versionId: "v1", parentVersionId: null, language: "en", voicePreset: "indian-english-female", sources: [] });
    const parsed = PlanSchema.parse(plan);
    expect(parsed.scenes[0]!.objects[0]!.icon).toBe("sun");
    expect(parsed.scenes[0]!.objects[1]).not.toHaveProperty("icon");
    const prompt = buildSystemInstruction("en");
    expect(prompt).toMatch(/NEVER put icon names or search keywords into a label/);
  });
});

describe("keyword-list label warning", () => {
  it.each(["sun heat solar", "why question rain", "idea key remember bulb", "water vapour vapour", "colder thermometer cool", "soil layers ground"])(
    "flags %j",
    (label) => expect(looksLikeKeywordList(label)).toBe(true),
  );
  it.each(["Sun", "Water vapour", "Earth Water Share", "How The Water Cycle Works", "97% ocean", "Earth recycles the exact same water forever", "Clouds form"])(
    "accepts %j",
    (label) => expect(looksLikeKeywordList(label)).toBe(false),
  );

  it("is a non-blocking review warning shown on the review page", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.scenes[0].objects[0].label = "sun heat solar";
    const result = validatePlan(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([expect.objectContaining({ sceneId: raw.scenes[0].id, message: expect.stringMatching(/looks like a list of icon keywords/) })]);
    const html = renderPlanReview({ plan: result.plan, planHash: hashPlan(result.plan), stats: result.stats, runId: "a/b/v1", plannerModel: "m", generatedAt: "t", plannerNote: null, approveCommand: "x" });
    expect(html).toContain("looks like a list of icon keywords");
  });
});
