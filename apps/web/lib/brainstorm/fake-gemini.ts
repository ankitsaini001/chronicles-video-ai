// A stand-in for the Gemini HTTP API, ONLY for the automated end-to-end check (tools/e2e/f14-…).
// It answers the same streamed format as Gemini, so the real adapter, retries and checks run.
// It is switched on only by provider.ts, and only on a local test server (see fakeGeminiProblem).
// The subject picks the answer: "e2e busy" → 503 every time, "e2e unsafe" → safety block,
// "e2e unsuitable" → suitable:false, "e2e invalid" → 4 ideas every time, "e2e repair" → 4 ideas,
// then 5 after the repair message; anything else → 5 ideas in the requested language.

type GeminiRequestBody = { contents?: { role?: string; parts?: { text?: string }[] }[] };

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
