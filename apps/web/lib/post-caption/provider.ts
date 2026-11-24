import { createPostCaptionProvider, type PlannerProvider } from "@bytereel/pipeline/post-caption";
import { FAKE_GEMINI_ENV, fakeGeminiProblem } from "../brainstorm/provider";
import { fakeGeminiFetch } from "../brainstorm/fake-gemini";

// The AI used by H1 POST /api/v1/projects/{projectId}/caption-suggestions (F29, server only): Gemini
// with GEMINI_API_KEY and the storyboard planner's model GEMINI_MODEL (the same as the storyboard and
// change requests), unless the optional GEMINI_CAPTION_MODEL names another one (e.g. the faster
// brainstorm model, if the planner model is too slow for the 30 s limit on the free tier).
// The test-only switch E2E_FAKE_GEMINI=1 (same safety gate as brainstorm: test database, local test
// port, never on Vercel) swaps in the local stand-in; set anywhere else, H1 refuses to run (500).

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,79}$/;

export type PostCaptionProviderResult = { ok: true; provider: PlannerProvider; fake: boolean } | { ok: false; problem: string };

export function postCaptionProviderFromEnv(env: NodeJS.ProcessEnv = process.env): PostCaptionProviderResult {
  const problem = fakeGeminiProblem(env);
  if (problem) return { ok: false, problem };
  if (env[FAKE_GEMINI_ENV] === "1") {
    return { ok: true, fake: true, provider: createPostCaptionProvider({ apiKey: "e2e-fake-key", model: "fake-gemini-e2e", fetch: fakeGeminiFetch }) };
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  const override = env.GEMINI_CAPTION_MODEL?.trim();
  const name = override ? "GEMINI_CAPTION_MODEL" : "GEMINI_MODEL";
  const model = override || (env.GEMINI_MODEL?.trim() ?? "");
  if (!apiKey) return { ok: false, problem: "GEMINI_API_KEY is missing. Add it to the .env file (or Vercel's environment variables)." };
  if (!MODEL_ID.test(model)) return { ok: false, problem: `${name} is missing or not a model id (e.g. gemini-3.6-flash).` };
  if (/(^|-)latest$/.test(model)) return { ok: false, problem: `${name} must be a fixed model id, not a moving "-latest" alias.` };
  return { ok: true, fake: false, provider: createPostCaptionProvider({ apiKey, model }) };
}
