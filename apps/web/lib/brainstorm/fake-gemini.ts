import { readFileSync } from "node:fs";
import path from "node:path";

// A stand-in for the Gemini HTTP API, ONLY for the automated end-to-end checks (tools/e2e/f14-…,
// f15-…). It answers the same streamed format as Gemini, so the real adapter, retries and checks run.
// It is switched on only by provider.ts / lib/plan/provider.ts, and only on a local test server
// (see fakeGeminiProblem).
// Brainstorm (C7): the subject picks the answer: "e2e busy" → 503 every time, "e2e unsafe" → safety
// block, "e2e unsuitable" → suitable:false, "e2e invalid" → 4 ideas every time, "e2e repair" → 4
// ideas, then 5 after the repair message; anything else → 5 ideas in the requested language.
// Storyboard planner (F15, prompts with a <<<CREATOR IDEA block): "e2e busy" → 503 every time,
// "e2e unsafe" → safety block, "e2e invalid" → an invalid plan every time, "e2e repair" → invalid,
// then valid after the repair message; anything else → the valid water-cycle plan from fixtures/.

type GeminiRequestBody = { contents?: { role?: string; parts?: { text?: string }[] }[] };

/** The fixture plan without the code-owned fields (what the model would write). */
function fixturePlannerOutput(): Record<string, unknown> {
  const candidates = [path.resolve(process.cwd(), "../../fixtures/water-cycle.plan.json"), path.resolve(process.cwd(), "fixtures/water-cycle.plan.json")];
  for (const file of candidates) {
    try {
      // Only the e2e stand-in reads this file; keep it out of the deployment trace.
      const plan = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Record<string, unknown>;
      for (const key of ["schemaVersion", "projectId", "ownerId", "versionId", "parentVersionId", "language", "voicePreset", "sources"]) delete plan[key];
      return plan;
    } catch {
      // try the next place
    }
  }
  throw new Error("fake Gemini: fixtures/water-cycle.plan.json not found");
}

function planAnswer(idea: string, isRepair: boolean): Response {
  if (idea.includes("e2e busy")) return Response.json({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }, { status: 503 });
  if (idea.includes("e2e unsafe")) return sse({ promptFeedback: { blockReason: "SAFETY" }, modelVersion: "fake-gemini-e2e" });
  const plan = fixturePlannerOutput();
  const invalid = idea.includes("e2e invalid") || (idea.includes("e2e repair") && !isRepair);
  if (invalid) plan.scenes = (plan.scenes as unknown[]).slice(0, 1); // one scene: fails the 3–10 scenes rule
  return answer(JSON.stringify(plan));
}

function sse(chunk: unknown): Response {
  return new Response(`data: ${JSON.stringify(chunk)}\r\n\r\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function answer(text: string): Response {
  return sse({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 300, thoughtsTokenCount: 200, totalTokenCount: 1400 },
    modelVersion: "fake-gemini-e2e",
  });
}

function ideas(count: number, subject: string, prompt: string): string {
  const hi = prompt.includes("in Hindi (Devanagari script)");
  const list = Array.from({ length: count }, (_, i) =>
    hi
      ? { title: `विचार ${i + 1}: ${subject}`, hook: `क्या आप जानते हैं ${subject} के बारे में यह बात ${i + 1}?`, angle: `एक आसान उदाहरण से समझिए (${i + 1})` }
      : { title: `Idea ${i + 1} about ${subject}`, hook: `Did you know this fact number ${i + 1} about ${subject}?`, angle: `Explained with everyday example ${i + 1}` },
  );
  return JSON.stringify({ suitable: true, ideas: list });
}

export const fakeGeminiFetch: typeof fetch = async (_input, init) => {
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GeminiRequestBody;
  const prompt = body.contents?.[0]?.parts?.[0]?.text ?? "";
  const idea = /<<<CREATOR IDEA\n([\s\S]*?)\nCREATOR IDEA>>>/.exec(prompt)?.[1];
  if (idea !== undefined) return planAnswer(idea, (body.contents?.length ?? 0) > 1);
  const subject = /<<<SUBJECT\n([\s\S]*?)\nSUBJECT>>>/.exec(prompt)?.[1] ?? "";
  const isRepair = (body.contents?.length ?? 0) > 1;
  if (subject.includes("e2e busy")) {
    return Response.json({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }, { status: 503 });
  }
  if (subject.includes("e2e unsafe")) return sse({ promptFeedback: { blockReason: "SAFETY" }, modelVersion: "fake-gemini-e2e" });
  if (subject.includes("e2e unsuitable")) return answer(JSON.stringify({ suitable: false, ideas: [] }));
  if (subject.includes("e2e invalid")) return answer(ideas(4, subject, prompt));
  if (subject.includes("e2e repair") && !isRepair) return answer(ideas(4, subject, prompt));
  return answer(ideas(5, subject, prompt));
};
