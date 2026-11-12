import { describe, expect, it } from "vitest";
import { ApprovalSchema, PlanSchema } from "../packages/pipeline/src/contracts";
import { validatePlan } from "../packages/pipeline/src/planning";
import { loadFixture } from "./helpers";

describe("Plan schema", () => {
  it("accepts the valid water-cycle fixture and fills in null defaults", () => {
    const plan = PlanSchema.parse(loadFixture("water-cycle.plan.json"));
    expect(plan.scenes).toHaveLength(6);
    const firstBlock = plan.scenes[0]!.narration[0]!;
    expect(firstBlock.speech).toBeNull();
    expect(firstBlock.display).toBeNull();
    expect(plan.scenes[0]!.objects[0]!.value).toBeNull();
  });

  it("rejects unknown keys so typos never pass silently", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.scenes[0].naration = [];
    const result = validatePlan(raw);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ sceneId: "scene-hook", path: "scenes[0]" });
    expect(result.issues[0]!.message).toMatch(/naration/);
  });

  it("rejects IDs that could be used as paths", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.versionId = "../../etc";
    const result = validatePlan(raw);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.path).toBe("versionId");
  });

  it("rejects an unsupported language and voice preset", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.language = "fr";
    raw.voicePreset = "british-male";
    const result = validatePlan(raw);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.path).sort()).toEqual(["language", "voicePreset"]);
  });

  it("rejects an unknown motion pattern with a clear message", () => {
    const result = validatePlan(loadFixture("invalid-unknown-pattern.plan.json"));
    expect(result).toMatchObject({ ok: false, stage: "schema" });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ sceneId: "scene-earth-water", path: "scenes[4].type" });
    expect(result.issues[0]!.message).toContain('unknown motion pattern "infographic"');
  });
});

describe("Approval schema", () => {
  it("requires a sha256 plan hash, an actor and a timestamp", () => {
    expect(
      ApprovalSchema.safeParse({ planHash: `sha256:${"a".repeat(64)}`, actor: "founder", approvedAt: "2026-11-12T10:00:00.000Z" }).success,
    ).toBe(true);
    expect(ApprovalSchema.safeParse({ planHash: "abc", actor: "", approvedAt: "yesterday" }).success).toBe(false);
  });
});
