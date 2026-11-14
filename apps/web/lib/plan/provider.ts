import { createPlanJobProvider } from "@bytereel/pipeline/planning";
import type { PlannerProvider } from "@bytereel/pipeline/providers";
import { FAKE_GEMINI_ENV, fakeGeminiProblem } from "../brainstorm/provider";
import { fakeGeminiFetch } from "../brainstorm/fake-gemini";

// The AI used by the storyboard job `plan-video` (server only): Gemini with GEMINI_API_KEY and the
// planner model GEMINI_MODEL (PRD decision #19: gemini-3.6-flash), from the environment (the root
// .env locally, Vercel's settings in production). The key goes only to the Gemini SDK.
// The test-only switch E2E_FAKE_GEMINI=1 (same safety gate as brainstorm: test database, local test
// port, never on Vercel) swaps in the local stand-in; set anywhere else, the job refuses to run.

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,79}$/;

export type PlannerProviderResult = { ok: true; provider: PlannerProvider; fake: boolean } | { ok: false; problem: string };

export function plannerProviderFromEnv(env: NodeJS.ProcessEnv = process.env): PlannerProviderResult {
  const problem = fakeGeminiProblem(env);
  if (problem) return { ok: false, problem };
  if (env[FAKE_GEMINI_ENV] === "1") {
    return { ok: true, fake: true, provider: createPlanJobProvider({ apiKey: "e2e-fake-key", model: "fake-gemini-e2e", fetch: fakeGeminiFetch }) };
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim() ?? "";
  if (!apiKey) return { ok: false, problem: "GEMINI_API_KEY is missing. Add it to the .env file (or Vercel's environment variables)." };
  if (!MODEL_ID.test(model)) return { ok: false, problem: "GEMINI_MODEL is missing or not a model id (the storyboard planner uses e.g. gemini-3.6-flash)." };
  if (/(^|-)latest$/.test(model)) return { ok: false, problem: "GEMINI_MODEL must be a fixed model id, not a moving \"-latest\" alias." };
  return { ok: true, fake: false, provider: createPlanJobProvider({ apiKey, model }) };
}
