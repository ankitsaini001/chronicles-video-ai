// What the storyboard screen shows for each scene (F16; PRD §6.2): the pattern badge, a plain
// "Visual:" line, and the notes (AI warnings, validation warnings, and, for a version that fails
// the checks, the problems to fix). Built ONLY from the saved plan, never by an AI call, so it is
// instant, free and always matches the plan that will be rendered. Safe for the browser.

export type SceneLike = {
  id: string;
  type: string;
  narration: { id: string; text: string; speech?: string | null; display?: string | null }[];
  objects: { id: string; kind: string; label: string; value?: number | null }[];
};

export type Issue = { sceneId: string | null; path: string; message: string };

/** The motion pattern badge (PRD §8.1, short names). */
export const PATTERN_LABELS: Record<string, string> = {
  "title-hook": "Hook",
  "labeled-diagram": "Diagram",
  "process-flow": "Process",
  comparison: "Comparison",
  timeline: "Timeline",
  chart: "Chart",
  "step-sequence": "Steps",
  takeaway: "Takeaway",
};

export function patternLabel(type: string): string {
  return PATTERN_LABELS[type] ?? type;
}

const CHART_KINDS = new Set(["bar", "line-point", "pie-slice", "counter"]);

function labelsOf(scene: SceneLike, ...kinds: string[]): string[] {
  return scene.objects.filter((o) => kinds.includes(o.kind)).map((o) => o.label.trim()).filter(Boolean);
}

/**
 * "Process: Sunlight → Atmosphere → Your eyes". The pattern name, then the on-screen labels in the
 * way the pattern shows them: a flow, timeline or steps with arrows; a comparison with "vs"; a
 * diagram as the thing and its parts; a chart with its numbers; a hook or takeaway as its headline
 * and lines. Anything else: the labels in order.
 */
export function visualLine(scene: SceneLike): string {
  const { pattern, detail } = visualParts(scene);
  return detail ? `${pattern}: ${detail}` : pattern;
}

/** The two halves of the visual line: the pattern name (English) and the labels (plan language). */
export function visualParts(scene: SceneLike): { pattern: string; detail: string } {
  const pattern = patternLabel(scene.type);
  let parts = "";
  switch (scene.type) {
    case "title-hook":
      parts = labelsOf(scene, "headline", "subtitle").join(" · ");
      break;
    case "labeled-diagram": {
      const whole = labelsOf(scene, "diagram")[0];
      const pieces = labelsOf(scene, "part");
      parts = whole ? (pieces.length ? `${whole} (${pieces.join(", ")})` : whole) : pieces.join(", ");
      break;
    }
    case "process-flow":
      parts = labelsOf(scene, "node").join(" → ");
      break;
    case "comparison":
      parts = labelsOf(scene, "column").join(" vs ");
      break;
    case "timeline":
      parts = labelsOf(scene, "milestone").join(" → ");
      break;
    case "chart":
      parts = scene.objects
        .filter((o) => CHART_KINDS.has(o.kind) && o.label.trim())
        .map((o) => (typeof o.value === "number" ? `${o.label.trim()} ${formatNumber(o.value)}` : o.label.trim()))
        .join(", ");
      break;
    case "step-sequence":
      parts = labelsOf(scene, "step").join(" → ");
      break;
    case "takeaway":
      parts = labelsOf(scene, "headline", "bullet").join(" · ");
      break;
  }
  if (!parts) parts = scene.objects.filter((o) => o.kind !== "arrow" && o.kind !== "particles").map((o) => o.label.trim()).filter(Boolean).join(", ");
  return { pattern, detail: parts };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-IN") : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/** "SCENE 01" (two digits, like the design). */
export function sceneNumber(index: number): string {
  return `Scene ${String(index + 1).padStart(2, "0")}`;
}

/**
 * A validation problem in plain words. Most problems after a narration edit are about the
 * animation cues ("anchors") that point at words in the narration, or the total length.
 */
export function friendlyIssue(issue: Issue): string {
  const missing = /phrase "(.+)" was not found in narration block/.exec(issue.message);
  if (missing) {
    return `The animation is timed to the words “${missing[1]}”, which are no longer in this scene's narration. Put these words back, or ask for a change so the visuals follow the new text.`;
  }
  const twice = /phrase "(.+)" appears \d+ times in narration block/.exec(issue.message);
  if (twice) return `The words “${twice[1]}” now appear more than once, so the animation can't tell where to start. Reword one of them.`;
  const length = /estimated narration length is ([\d.]+) s/.exec(issue.message);
  if (length) {
    const seconds = Math.round(Number(length[1]));
    return `The narration is now about ${seconds} seconds; videos must be 60–90 seconds. ${seconds > 90 ? "Shorten the text, or ask for “make it shorter”." : "Add a little more explanation."}`;
  }
  return issue.message;
}

export type SceneNotes = {
  /** Notes about the whole storyboard (no scene). */
  general: { warnings: string[]; problems: string[] };
  /** Notes per scene id. */
  byScene: Map<string, { warnings: string[]; problems: string[] }>;
};

/**
 * Where each note goes: the AI's own warnings (plan.warnings) and the checker's warnings
 * (validation.warnings) as amber notes; the problems that block approval (validation.issues) as
 * red notes. A note with a scene goes on that scene's card; one without a scene (or with a scene
 * that no longer exists) is shown once, above the scenes. Duplicates are shown once.
 */
export function sceneNotes(
  plan: { scenes: { id: string }[]; warnings?: { sceneId: string | null; message: string }[] },
  validation: { issues: Issue[]; warnings: Issue[] },
): SceneNotes {
  const sceneIds = new Set(plan.scenes.map((s) => s.id));
  const general = { warnings: [] as string[], problems: [] as string[] };
  const byScene = new Map<string, { warnings: string[]; problems: string[] }>();
  const add = (sceneId: string | null, kind: "warnings" | "problems", text: string) => {
    const target = sceneId && sceneIds.has(sceneId) ? (byScene.get(sceneId) ?? byScene.set(sceneId, { warnings: [], problems: [] }).get(sceneId)!) : general;
    if (!target[kind].includes(text)) target[kind].push(text);
  };
  for (const w of plan.warnings ?? []) add(w.sceneId, "warnings", w.message);
  for (const w of validation.warnings) add(w.sceneId, "warnings", w.message);
  for (const issue of validation.issues) add(issue.sceneId, "problems", friendlyIssue(issue));
  return { general, byScene };
}
