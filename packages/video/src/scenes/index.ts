import type { SceneType } from "@bytereel/pipeline/contracts";
import { Chart } from "./Chart";
import { Comparison } from "./Comparison";
import { Hook } from "./Hook";
import { LabeledDiagram } from "./LabeledDiagram";
import { ProcessFlow } from "./ProcessFlow";
import type { Pattern } from "./shared";
import { StepSequence } from "./StepSequence";
import { Takeaway } from "./Takeaway";
import { Timeline } from "./Timeline";

/** One v4 layout per motion pattern (PRD §8.1). */
export const PATTERNS: Record<SceneType, Pattern> = {
  "title-hook": Hook,
  "labeled-diagram": LabeledDiagram,
  "process-flow": ProcessFlow,
  comparison: Comparison,
  timeline: Timeline,
  chart: Chart,
  "step-sequence": StepSequence,
  takeaway: Takeaway,
};
