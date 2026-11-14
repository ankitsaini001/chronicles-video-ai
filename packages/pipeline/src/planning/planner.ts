import { VOICE_PRESETS_BY_LANGUAGE, type Language, type Plan, type VoicePreset } from "../contracts";
import type { PlannerProvider, PlannerResponse, PlannerTurn, TokenUsage } from "../providers/planner";
import { assemblePlan, plannerOutputJsonSchema } from "./planner-output";
import { buildRepairPrompt, buildSystemInstruction, buildUserPrompt } from "./prompts";
import type { PlanStats } from "./semantic-validation";
import { topicSources, type TopicFile } from "./topic-file";
import { validatePlan } from "./validate-plan";
import type { ValidationIssue } from "./validation-issue";

/**
 * Plan stage logic (PIPELINE_DESIGN.md §8 "Plan"): ask the planner, assemble a full plan with
 * code-owned fields, validate (schema + semantics), and if invalid make exactly ONE repair attempt
 * that sends the validation errors back. Still invalid -> needs-input with the errors.
 *
 * Provider errors (ProviderError) are not caught here: transient ones were already retried by the
 * adapter, and fatal ones (auth, model, safety) must stop the stage immediately.
 */

export const MAX_PLAN_ATTEMPTS = 2; // the initial attempt + one bounded repair

export interface PlanAttempt {
  attempt: number;
  kind: "initial" | "repair";
  model: string;
  finishReason: string | null;
  usage: TokenUsage | null;
  retries: number;
  durationMs: number;
  valid: boolean;
  issueCount: number;
  /** Reserved fields the model returned anyway (ignored; code assigns them). */
  ignoredFields: string[];
}

export type PlannerResult =
  | { status: "valid"; plan: Plan; stats: PlanStats; attempts: PlanAttempt[]; repaired: boolean }
  | { status: "needs-input"; issues: ValidationIssue[]; stats: PlanStats | null; attempts: PlanAttempt[] };

export interface PlannerIds {
  ownerId: string;
  projectId: string;
  versionId: string;
  parentVersionId: string | null;
}

export interface PlanWithRepairOptions {
  provider: PlannerProvider;
  topic: TopicFile;
  voicePreset: VoicePreset;
  ids: PlannerIds;
  onProgress?: (message: string) => void;
}

export function languageForVoicePreset(preset: VoicePreset): Language {
  for (const [language, presets] of Object.entries(VOICE_PRESETS_BY_LANGUAGE) as [Language, readonly VoicePreset[]][]) {
    if (presets.includes(preset)) return language;
  }
  throw new Error(`unknown voice preset "${preset}"`);
}

/**
 * The fixed parts of every planner request for a language: the rules (system instruction) and the
 * response schema. Used by planWithRepair and by the web app's plan job (one request per step).
 */
export function plannerRequestBase(language: Language): { systemInstruction: string; responseJsonSchema: Record<string, unknown> } {
  return { systemInstruction: buildSystemInstruction(language), responseJsonSchema: plannerOutputJsonSchema() };
}

/**
 * The conversation for the single repair attempt: the first prompt, the model's invalid answer,
 * then the validation errors (buildRepairPrompt).
 */
export function repairTurns(initialPrompt: string, answerText: string, issues: readonly ValidationIssue[], stats: PlanStats | null, language: Language): PlannerTurn[] {
  return [
    { role: "user", text: initialPrompt },
    { role: "model", text: answerText.trim() || "(empty response)" },
    { role: "user", text: buildRepairPrompt(issues, stats, language) },
  ];
}

export async function planWithRepair(options: PlanWithRepairOptions): Promise<PlannerResult> {
  const { provider, topic, voicePreset, ids, onProgress = () => undefined } = options;
  const language = languageForVoicePreset(voicePreset);
  const owned = { ...ids, language, voicePreset, sources: topicSources(topic) };
  const { systemInstruction, responseJsonSchema } = plannerRequestBase(language);
  const initialPrompt = buildUserPrompt({ topic, language, voicePreset });
  let turns: PlannerTurn[] = [{ role: "user", text: initialPrompt }];
  const attempts: PlanAttempt[] = [];

  let lastIssues: ValidationIssue[] = [];
  let lastStats: PlanStats | null = null;
  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const kind = attempt === 1 ? "initial" : "repair";
    onProgress(attempt === 1 ? `Asking ${provider.name} (${provider.model}) for a storyboard...` : `Plan invalid (${lastIssues.length} problem(s)); one repair attempt...`);
    const response = await provider.generate({ systemInstruction, turns: [...turns], responseJsonSchema });
    const evaluated = evaluatePlannerResponse(response, owned);
    attempts.push({
      attempt,
      kind,
      model: response.model,
      finishReason: response.finishReason,
      usage: response.usage,
      retries: response.retries,
      durationMs: response.durationMs,
      valid: evaluated.ok,
      issueCount: evaluated.ok ? 0 : evaluated.issues.length,
      ignoredFields: evaluated.ignoredFields,
    });
    if (evaluated.ok) {
      return { status: "valid", plan: evaluated.plan, stats: evaluated.stats, attempts, repaired: attempt > 1 };
    }
    lastIssues = evaluated.issues;
    lastStats = evaluated.stats;
    turns = repairTurns(initialPrompt, response.text, evaluated.issues, evaluated.stats, language);
  }
  return { status: "needs-input", issues: lastIssues, stats: lastStats, attempts };
}

export type PlannerEvaluation =
  | { ok: true; plan: Plan; stats: PlanStats; ignoredFields: string[] }
  | { ok: false; issues: ValidationIssue[]; stats: PlanStats | null; ignoredFields: string[] };

/**
 * Parse one planner answer, add the code-owned fields (assemblePlan) and run the full plan
 * validation (schema + semantic rules). Never trusts the model's JSON as it is.
 */
export function evaluatePlannerResponse(response: Pick<PlannerResponse, "text" | "finishReason">, owned: Parameters<typeof assemblePlan>[1]): PlannerEvaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch (error) {
    const truncated = response.finishReason === "MAX_TOKENS" ? " The answer was cut off at the output limit; keep the plan compact." : "";
    return {
      ok: false,
      ignoredFields: [],
      stats: null,
      issues: [{ sceneId: null, path: "(response)", message: `the response was not valid JSON (${(error as Error).message}).${truncated}` }],
    };
  }
  const { plan, ignoredFields } = assemblePlan(parsed, owned);
  const result = validatePlan(plan);
  if (result.ok) return { ok: true, plan: result.plan, stats: result.stats, ignoredFields };
  return { ok: false, issues: result.issues, stats: result.stats, ignoredFields };
}

/** Sum token usage over attempts (null fields are skipped). */
export function totalUsage(attempts: readonly PlanAttempt[]): TokenUsage {
  const sum = (pick: (u: TokenUsage) => number | null) => {
    const values = attempts.map((a) => (a.usage ? pick(a.usage) : null)).filter((v): v is number => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  return {
    promptTokens: sum((u) => u.promptTokens),
    outputTokens: sum((u) => u.outputTokens),
    thinkingTokens: sum((u) => u.thinkingTokens),
    totalTokens: sum((u) => u.totalTokens),
  };
}
