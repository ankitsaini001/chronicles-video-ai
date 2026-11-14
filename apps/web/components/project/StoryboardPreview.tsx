import type { PlanVersionDocument } from "@bytereel/db";

// TEMPORARY read-only storyboard (F15): the saved plan version as a simple list of scenes with
// their narration, so the creator can see the AI's result. The real storyboard screen (scene cards,
// edits, approval) is F16.

const SCENE_TYPE_LABELS: Record<string, string> = {
  "title-hook": "Hook",
  "labeled-diagram": "Diagram",
  "process-flow": "Process",
  comparison: "Comparison",
  timeline: "Timeline",
  chart: "Chart",
  "step-sequence": "Steps",
  takeaway: "Takeaway",
};

/** The scene's on-screen headline when it has one, else its pattern name. */
function sceneTitle(scene: PlanVersionDocument["plan"]["scenes"][number]): string {
  const headline = scene.objects.find((o) => o.kind === "headline")?.label;
  return headline || SCENE_TYPE_LABELS[scene.type] || scene.type;
}

export function StoryboardPreview({ version, language }: { version: PlanVersionDocument; language: string }) {
  const { plan, stats } = version;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">
        {stats.sceneCount} scenes · {stats.wordCount} words · about {Math.round(stats.estimatedSeconds)} seconds
      </p>
      <ol className="flex flex-col gap-4" lang={language === "hi" ? "hi" : undefined}>
        {plan.scenes.map((scene, index) => (
          <li key={scene.id} className="rounded-2xl border border-line bg-surface-2 p-4">
            <h3 className="mb-2 font-display text-base font-bold text-text">
              <span className="mr-2 font-mono text-xs font-normal uppercase tracking-wider text-amber-light">Scene {index + 1}</span>
              {sceneTitle(scene)}
            </h3>
            {scene.narration.map((block) => (
              <p key={block.id} className="text-base leading-relaxed break-words text-text">
                {block.text}
              </p>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}
