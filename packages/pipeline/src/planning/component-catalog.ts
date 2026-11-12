import type { SceneType } from "../contracts";

/**
 * Fixed component catalog (PIPELINE_DESIGN.md §5 and §7).
 *
 * For each of the 8 motion patterns it lists which object kinds and event actions
 * are allowed, plus layout limits. The planner may only use what is listed here;
 * anything else fails semantic validation. The P1 Remotion components will draw
 * exactly these kinds and actions, so this file is the contract between planning
 * and rendering. Grow it only when a real topic needs something new.
 */

export interface KindRule {
  /** Maximum label length in characters (keeps text inside the layout). */
  maxLabelLength: number;
  /** true when the object needs a numeric `value` (chart bars, counters). */
  requiresValue: boolean;
}

export interface PatternRule {
  /** Plain-words description, useful for prompts and review pages. */
  description: string;
  kinds: Record<string, KindRule>;
  actions: readonly string[];
  minObjects: number;
  maxObjects: number;
  /** Optional exact/min/max counts for specific kinds, e.g. a comparison has exactly 2 columns. */
  kindCounts?: Record<string, { min: number; max: number }>;
}

const SHORT_LABEL: KindRule = { maxLabelLength: 32, requiresValue: false };
const LONG_TEXT: KindRule = { maxLabelLength: 60, requiresValue: false };
const VALUE_LABEL: KindRule = { maxLabelLength: 32, requiresValue: true };

export const COMPONENT_CATALOG: Record<SceneType, PatternRule> = {
  "title-hook": {
    description: "Opening question or bold statement",
    kinds: { headline: LONG_TEXT, subtitle: LONG_TEXT, icon: SHORT_LABEL },
    actions: ["appear", "highlight", "pulse"],
    minObjects: 1,
    maxObjects: 3,
    kindCounts: { headline: { min: 1, max: 1 } },
  },
  "labeled-diagram": {
    description: "Parts of a thing, with labels appearing in sync",
    kinds: { diagram: SHORT_LABEL, part: SHORT_LABEL, arrow: SHORT_LABEL, icon: SHORT_LABEL },
    actions: ["appear", "highlight", "point-to", "pulse"],
    minObjects: 2,
    maxObjects: 7,
    kindCounts: { diagram: { min: 1, max: 1 } },
  },
  "process-flow": {
    description: "Cause and effect, cycles and pipelines, with arrows",
    kinds: { node: SHORT_LABEL, arrow: SHORT_LABEL, icon: SHORT_LABEL, particles: SHORT_LABEL },
    actions: ["appear", "highlight", "flow", "rise", "fall", "speed-up", "gather"],
    minObjects: 2,
    maxObjects: 7,
  },
  comparison: {
    description: "Side-by-side A vs B",
    kinds: { column: SHORT_LABEL, point: LONG_TEXT, icon: SHORT_LABEL },
    actions: ["appear", "highlight", "check", "cross"],
    minObjects: 2,
    maxObjects: 8,
    kindCounts: { column: { min: 2, max: 2 } },
  },
  timeline: {
    description: "Events in order",
    kinds: { axis: SHORT_LABEL, milestone: SHORT_LABEL },
    actions: ["appear", "highlight", "advance"],
    minObjects: 2,
    maxObjects: 7,
  },
  chart: {
    description: "Simple bar, line or pie chart with animated values",
    kinds: {
      axis: SHORT_LABEL,
      bar: VALUE_LABEL,
      "line-point": VALUE_LABEL,
      "pie-slice": VALUE_LABEL,
      counter: VALUE_LABEL,
    },
    actions: ["appear", "grow", "highlight", "count-up"],
    minObjects: 2,
    maxObjects: 8,
  },
  "step-sequence": {
    description: "Ordered steps revealed one by one",
    kinds: { step: LONG_TEXT, icon: SHORT_LABEL },
    actions: ["appear", "highlight", "complete"],
    minObjects: 2,
    maxObjects: 6,
  },
  takeaway: {
    description: "Closing summary, key lesson or call to action",
    kinds: { headline: LONG_TEXT, bullet: LONG_TEXT, icon: SHORT_LABEL },
    actions: ["appear", "highlight", "pulse"],
    minObjects: 1,
    maxObjects: 4,
  },
};

/** Text and count limits that apply to every scene. */
export const SCENE_LIMITS = {
  maxNarrationBlocks: 4,
  maxNarrationBlockLength: 300,
  maxEvents: 8,
} as const;

/** Plan-level limits. */
export const PLAN_LIMITS = {
  minScenes: 3,
  maxScenes: 10,
  /** Final video must be 60–90 s inclusive (PRD + design §6). */
  targetMinSeconds: 60,
  targetMaxSeconds: 90,
  /**
   * The word-count estimate is rough; real duration is measured from audio in P2.
   * We allow 10% either side before calling the plan implausible.
   */
  estimateTolerance: 0.1,
} as const;

/**
 * Average speaking rate used for the duration estimate, in words per minute.
 * Starting values only; tune them with measured ElevenLabs output in P2/P3.
 */
export const WORDS_PER_MINUTE = {
  en: 150,
  hi: 130,
  hinglish: 140,
} as const;
