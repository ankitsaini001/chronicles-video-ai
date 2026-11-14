import { ProjectActionError, voiceGenderOfPreset, type BuiltPlan, type PlanVersionDocument, type StoredPlan } from "@bytereel/db";
import { voicePresetFor, type VoiceLanguage } from "@bytereel/db/voices";
import type { Plan } from "@bytereel/pipeline/contracts";
import { hashPlan, validatePlan } from "@bytereel/pipeline/planning";
import type { ObjectId } from "mongodb";

// Building a new storyboard version from the current one (server only; F17 narration edit, F19
// voice switch). No AI: the change is applied to a copy of the base plan, then the SAME plan
// validator the AI's plans go through (schema + semantic rules, packages/pipeline/src/planning)
// checks it, and the canonical plan hash is computed. A version that fails the checks is still
// saved (API.md D3: no typing is lost) with `validation.valid = false` and its problems; it just
// can't be approved until fixed.

/** Copy the base plan with the new version's ids, apply `change`, validate and hash. */
export function buildPlanVersion(base: PlanVersionDocument, ids: { versionId: ObjectId; parentVersionId: ObjectId }, change: (plan: StoredPlan) => void): BuiltPlan {
  const plan = structuredClone(base.plan);
  plan.versionId = ids.versionId.toHexString();
  plan.parentVersionId = ids.parentVersionId.toHexString();
  change(plan);
  const checked = validatePlan(plan);
  if (checked.ok) {
    return {
      plan: checked.plan as unknown as StoredPlan,
      planHash: hashPlan(checked.plan),
      validation: { valid: true, issues: [], warnings: checked.warnings },
      stats: checked.stats,
    };
  }
  return {
    plan,
    // The canonical hash works on any plan-shaped object (packages/pipeline/src/planning/plan-hash.ts).
    planHash: hashPlan(plan as unknown as Plan),
    validation: { valid: false, issues: checked.issues, warnings: [] },
    stats: checked.stats ?? base.stats,
  };
}

/** D3: the change for one narration block. Unknown scene or block → 400 INVALID_INPUT (nothing saved). */
export function narrationChange(edit: { sceneId: string; narrationId: string; text: string; speech?: string | null | undefined; display?: string | null | undefined }): (plan: StoredPlan) => void {
  return (plan) => {
    const scene = plan.scenes.find((s) => s.id === edit.sceneId);
    if (!scene) throw new ProjectActionError("INVALID_INPUT", "Please reload the page and try again.", { issues: [{ path: "sceneId", message: "is not a scene of this storyboard" }] });
    const block = scene.narration.find((n) => n.id === edit.narrationId);
    if (!block) throw new ProjectActionError("INVALID_INPUT", "Please reload the page and try again.", { issues: [{ path: "narrationId", message: "is not a narration block of this scene" }] });
    block.text = edit.text;
    if (edit.speech !== undefined) block.speech = edit.speech;
    if (edit.display !== undefined) block.display = edit.display;
  };
}

/**
 * D4 (F19): the only change is the plan's voice preset, for the project's language (a voice of
 * another language is never offered: the language can't change, PRD decision #25). Choosing the
 * voice the plan already has → 400 INVALID_INPUT (nothing saved).
 */
export function voiceChange(voiceGender: "female" | "male"): (plan: StoredPlan) => void {
  return (plan) => {
    if (voiceGenderOfPreset(plan.voicePreset) === voiceGender) {
      throw new ProjectActionError("INVALID_INPUT", `This project already uses the ${voiceGender} voice.`, { issues: [{ path: "voiceGender", message: "unchanged" }] });
    }
    plan.voicePreset = voicePresetFor(plan.language as VoiceLanguage, voiceGender).preset;
  };
}
