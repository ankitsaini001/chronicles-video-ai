import type { z } from "zod";
import { PlanSchema, type Plan } from "../contracts";
import { validatePlanSemantics, type PlanStats } from "./semantic-validation";
import type { ValidationIssue } from "./validation-issue";

export type PlanValidationResult =
  | { ok: true; plan: Plan; stats: PlanStats; issues: []; warnings: ValidationIssue[] }
  | { ok: false; stage: "schema" | "semantic"; issues: ValidationIssue[]; stats: PlanStats | null };

/**
 * Full plan validation: schema first (shape), then semantic rules.
 * Provider JSON that parses is NOT automatically a valid plan (design §3).
 */
export function validatePlan(input: unknown): PlanValidationResult {
  const parsed = PlanSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, stage: "schema", issues: zodIssuesToValidationIssues(parsed.error, input), stats: null };
  }
  const { issues, warnings, stats } = validatePlanSemantics(parsed.data);
  if (issues.length > 0) return { ok: false, stage: "semantic", issues, stats };
  return { ok: true, plan: parsed.data, stats, issues: [], warnings };
}

function zodIssuesToValidationIssues(error: z.ZodError, input: unknown): ValidationIssue[] {
  return error.issues.map((issue) => ({
    sceneId: sceneIdForPath(issue.path, input),
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

/** ["scenes", 2, "events", 0] -> "scenes[2].events[0]" */
function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((part, i) => (typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`))
    .join("");
}

/** If the path points inside scenes[n], look up that scene's id in the raw input for a friendlier message. */
function sceneIdForPath(path: readonly PropertyKey[], input: unknown): string | null {
  if (path[0] !== "scenes" || typeof path[1] !== "number") return null;
  const scenes = (input as { scenes?: unknown })?.scenes;
  if (!Array.isArray(scenes)) return null;
  const id = (scenes[path[1]] as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : `#${path[1]}`;
}
