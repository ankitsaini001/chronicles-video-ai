import { createBrainstormProvider, DEFAULT_BRAINSTORM_MODEL, type PlannerProvider } from "@bytereel/pipeline/brainstorm";
import { fakeGeminiFetch } from "./fake-gemini";

// The AI used by C7 POST /api/v1/brainstorm (server only): Gemini with GEMINI_API_KEY and its own
// model GEMINI_BRAINSTORM_MODEL (optional, default gemini-3.1-flash-lite; the storyboard planner
// keeps GEMINI_MODEL), from the environment (the root .env locally, Vercel's settings in production).
// The key is passed only to the Gemini SDK; it is never logged or sent to the browser.
//
// E2E_FAKE_GEMINI=1 swaps Gemini's HTTP API for a local stand-in (fake-gemini.ts) so the automated
// end-to-end check makes no real AI calls. It is honoured ONLY on a local test server: database
// `bytereel_test`, address http://localhost:3230–3239, and not on Vercel. If the switch is set
// anywhere else, brainstorm refuses to run at all (500, with the reason in the server log), so it
// can never quietly be on in production and never quietly fall back to real calls in a test.

export const FAKE_GEMINI_ENV = "E2E_FAKE_GEMINI";
const TEST_DB = "bytereel_test";
const TEST_ORIGIN = /^http:\/\/localhost:323\d$/;
/** A plain model id such as "gemini-3.1-flash-lite". */
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,79}$/;

/** Why the fake switch can't be used here, or null when it is off or allowed. */
export function fakeGeminiProblem(env: NodeJS.ProcessEnv): string | null {
  const flag = env[FAKE_GEMINI_ENV];
  if (flag === undefined || flag === "") return null;
  if (flag !== "1") return `${FAKE_GEMINI_ENV} must be "1" or unset.`;
  if (env.VERCEL || env.VERCEL_ENV) return `${FAKE_GEMINI_ENV} is set on Vercel. Remove it from the project's environment variables.`;
  if (env.MONGODB_DB !== TEST_DB) return `${FAKE_GEMINI_ENV} is only allowed with MONGODB_DB=${TEST_DB}.`;
  if (!TEST_ORIGIN.test(env.BETTER_AUTH_URL ?? "")) return `${FAKE_GEMINI_ENV} is only allowed on a local test server (http://localhost:3230–3239).`;
  return null;
}

export type BrainstormProviderResult = { ok: true; provider: PlannerProvider; fake: boolean } | { ok: false; problem: string };

export function brainstormProviderFromEnv(env: NodeJS.ProcessEnv = process.env): BrainstormProviderResult {
  const problem = fakeGeminiProblem(env);
  if (problem) return { ok: false, problem };
  if (env[FAKE_GEMINI_ENV] === "1") {
    return { ok: true, fake: true, provider: createBrainstormProvider({ apiKey: "e2e-fake-key", model: "fake-gemini-e2e", fetch: fakeGeminiFetch }) };
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_BRAINSTORM_MODEL?.trim() || DEFAULT_BRAINSTORM_MODEL;
  if (!apiKey) return { ok: false, problem: "GEMINI_API_KEY is missing. Add it to the .env file (or Vercel's environment variables)." };
  if (!MODEL_ID.test(model)) return { ok: false, problem: "GEMINI_BRAINSTORM_MODEL is not a model id (e.g. gemini-3.1-flash-lite). Fix it or leave it empty for the default." };
  // A "-latest" alias can switch to another model at any time (speed, quality, settings): PRD #26.
  if (/(^|-)latest$/.test(model)) return { ok: false, problem: "GEMINI_BRAINSTORM_MODEL must be a fixed model id, not a moving \"-latest\" alias." };
  return { ok: true, fake: false, provider: createBrainstormProvider({ apiKey, model }) };
}
