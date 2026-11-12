import { CODE_OWNED_PLAN_FIELDS, parseTopicFile } from "../packages/pipeline/src/planning";
import type { PlannerProvider, PlannerRequest, PlannerResponse } from "../packages/pipeline/src/providers";
import { loadFixture } from "./helpers";

// ---------- helpers (no network: the provider is a mock) ----------

/** The fixture plan as a model would write it: without any code-owned field. */
export function modelOutputFromFixture(): Record<string, any> {
  const plan = loadFixture("water-cycle.plan.json");
  for (const field of CODE_OWNED_PLAN_FIELDS) delete plan[field];
  // The planner always writes an icon (or "none"); the fixture plan predates the field.
  for (const scene of plan.scenes) for (const object of scene.objects) object.icon ??= "none";
  return plan;
}

export class MockPlanner implements PlannerProvider {
  readonly name = "mock";
  readonly model = "mock-flash";
  readonly requests: PlannerRequest[] = [];
  constructor(private readonly responses: Array<string | Error>) {}
  async generate(request: PlannerRequest): Promise<PlannerResponse> {
    this.requests.push(structuredClone(request));
    const next = this.responses.shift();
    if (next === undefined) throw new Error("mock planner: no more responses");
    if (next instanceof Error) throw next;
    return {
      text: next,
      model: this.model,
      finishReason: "STOP",
      usage: { promptTokens: 1000, outputTokens: 500, thinkingTokens: 100, totalTokens: 1600 },
      retries: 0,
      durationMs: 5,
    };
  }
}

export const TOPIC = parseTopicFile(
  "# How the water cycle works\n\nExplain evaporation, condensation, precipitation and collection.",
  "examples/water-cycle.md",
);
