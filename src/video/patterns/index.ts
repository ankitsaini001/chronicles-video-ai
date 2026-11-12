import type React from "react";
import type { SceneType } from "../../contracts";
import { Chart } from "./Chart";
import { Comparison } from "./Comparison";
import { LabeledDiagram } from "./LabeledDiagram";
import { ProcessFlow } from "./ProcessFlow";
import { StepSequence } from "./StepSequence";
import { Takeaway } from "./Takeaway";
import { TimelinePattern } from "./Timeline";
import { TitleHook } from "./TitleHook";
import type { PatternProps } from "./types";

/** One component per PRD motion pattern (PRD §8.1). */
export const PATTERN_COMPONENTS: Record<SceneType, React.FC<PatternProps>> = {
  "title-hook": TitleHook,
  "labeled-diagram": LabeledDiagram,
  "process-flow": ProcessFlow,
  comparison: Comparison,
  timeline: TimelinePattern,
  chart: Chart,
  "step-sequence": StepSequence,
  takeaway: Takeaway,
};

export type { PatternProps };
