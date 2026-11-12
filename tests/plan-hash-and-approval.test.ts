import { describe, expect, it } from "vitest";
import { PlanSchema, type Plan } from "../packages/pipeline/src/contracts";
import { canonicalJson, checkApproval, createApproval, hashPlan } from "../packages/pipeline/src/planning";
import { loadFixture, validPlan } from "./helpers";

/** Rebuild an object with its keys in reverse order (recursively). */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]));
  }
  return value;
}

const NOW = new Date("2026-11-12T10:00:00.000Z");

describe("canonical plan hash", () => {
  it("is stable: same plan, same hash", () => {
    expect(hashPlan(validPlan())).toBe(hashPlan(validPlan()));
    expect(hashPlan(validPlan())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("ignores key order", () => {
    // (PlanSchema.parse would put keys back in schema order, so hash the reordered object directly.)
    const reordered = reverseKeys(validPlan()) as Plan;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(validPlan()));
    expect(hashPlan(reordered)).toBe(hashPlan(validPlan()));
  });

  it("ignores whitespace-only differences", () => {
    const plan = validPlan();
    plan.scenes[0]!.narration[0]!.text = "  Where does rain   come from,\n and where does it go after it falls?  ";
    expect(hashPlan(plan)).toBe(hashPlan(validPlan()));
  });

  it("treats a missing optional field and an explicit null the same (defaults are applied first)", () => {
    const raw = loadFixture("water-cycle.plan.json");
    raw.scenes[0].narration[0].speech = null;
    expect(hashPlan(PlanSchema.parse(raw))).toBe(hashPlan(validPlan()));
  });

  it("changes on meaningful edits", () => {
    const base = hashPlan(validPlan());
    const edits: Array<(p: Plan) => void> = [
      (p) => (p.scenes[1]!.narration[0]!.text = p.scenes[1]!.narration[0]!.text.replace("faster", "quicker")),
      (p) => (p.voicePreset = "indian-english-male"),
      (p) => p.scenes.reverse(),
      (p) => (p.scenes[4]!.objects[1]!.value = 96.5),
      (p) => (p.scenes[0]!.objects[2]!.label = "The water cycle"),
    ];
    for (const edit of edits) {
      const plan = validPlan();
      edit(plan);
      expect(hashPlan(plan)).not.toBe(base);
    }
  });

  it("produces sorted, whitespace-normalized canonical JSON", () => {
    expect(canonicalJson({ b: " x  y ", a: [2, 1], c: undefined })).toBe('{"a":[2,1],"b":"x y"}');
  });
});

describe("approval", () => {
  it("is valid when the hash matches the current plan", () => {
    const plan = validPlan();
    const approval = createApproval(plan, "founder", NOW);
    expect(approval).toEqual({ planHash: hashPlan(plan), actor: "founder", approvedAt: NOW.toISOString() });
    expect(checkApproval(plan, approval)).toEqual({ valid: true, planHash: hashPlan(plan) });
  });

  it("rejects a stale approval after the plan is edited", () => {
    const plan = validPlan();
    const approval = createApproval(plan, "founder", NOW);
    plan.scenes[5]!.narration[1]!.text = "Water keeps moving forever.";
    const check = checkApproval(plan, approval);
    expect(check.valid).toBe(false);
    if (!check.valid) expect(check.reason).toMatch(/^stale approval/);
  });

  it("stays valid after a whitespace-only edit", () => {
    const plan = validPlan();
    const approval = createApproval(plan, "founder", NOW);
    plan.topic = `  ${plan.topic}  `;
    expect(checkApproval(plan, approval).valid).toBe(true);
  });

  it("rejects a missing or malformed approval", () => {
    expect(checkApproval(validPlan(), null)).toEqual({ valid: false, reason: "plan has not been approved yet" });
    expect(checkApproval(validPlan(), { planHash: "nope", actor: "x", approvedAt: "x" })).toEqual({
      valid: false,
      reason: "approval record is malformed",
    });
  });
});
