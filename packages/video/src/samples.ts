import { PlanSchema, type CaptionTrack, type Timeline } from "@bytereel/pipeline/contracts";
import { compileTimeline, synthesizeSceneAlignment } from "@bytereel/pipeline/timing";
import waterCyclePlan from "../../../fixtures/water-cycle.plan.json";

/**
 * Studio preview data. Not pipeline output and never written to a run folder.
 * waterCycleFixture(): the water-cycle fixture plan compiled with SYNTHETIC SILENT timing, in the
 * browser, so `npm run studio` shows the same video the render-fixture command produces.
 */

const PREVIEW_HASH = `sha256:${"0".repeat(64)}`;

export function waterCycleFixture(): { timeline: Timeline; captions: CaptionTrack } {
  const plan = PlanSchema.parse(waterCyclePlan);
  const alignments = Object.fromEntries(plan.scenes.map((s) => [s.id, synthesizeSceneAlignment(s, plan.language)]));
  return compileTimeline({ plan, planHash: PREVIEW_HASH, alignments });
}
