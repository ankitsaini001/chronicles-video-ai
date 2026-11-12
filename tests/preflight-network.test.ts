import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPreflight } from "../src/cli/preflight";
import { escapeHtml, highlightNarration } from "../packages/pipeline/src/planning";
import { ElevenLabsReadClient } from "../packages/pipeline/src/providers";
import { withTempDir } from "./helpers";

/** Mock fetch: routes by URL; records requests. No real network is used. */
function mockFetch(routes: Array<[RegExp, (url: string) => Response]>) {
  const calls: { url: string; method: string; headers: Headers }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, method: init?.method ?? (input instanceof Request ? input.method : "GET"), headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
    for (const [pattern, respond] of routes) if (pattern.test(url)) return respond(url);
    return new Response(JSON.stringify({ error: { message: "unrouted" } }), { status: 500, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ENV = {
  GEMINI_API_KEY: "test-gemini-key-123456",
  GEMINI_MODEL: "gemini-9-flash",
  ELEVENLABS_API_KEY: "test-eleven-key-123456",
  ELEVENLABS_MODEL: "eleven_multilingual_v2",
  ELEVENLABS_VOICE_ID_INDIAN_MALE: "VoiceMale01",
  ELEVENLABS_VOICE_ID_INDIAN_FEMALE: "VoiceFemale01",
  ELEVENLABS_VOICE_ID_HINDI_MALE: "",
  ELEVENLABS_VOICE_ID_HINDI_FEMALE: "",
};

const elevenRoutes: Array<[RegExp, (url: string) => Response]> = [
  [/api\.elevenlabs\.io\/v1\/models$/, () => json([{ model_id: "eleven_multilingual_v2", name: "Multilingual v2", can_do_text_to_speech: true, languages: [{ name: "English" }, { name: "Hindi" }] }])],
  [/v1\/voices\/VoiceFemale01$/, () => json({ voice_id: "VoiceFemale01", name: "Asha", category: "premade", labels: { accent: "indian", gender: "female" } })],
  [/v1\/voices\/VoiceMale01$/, () => json({ detail: { status: "voice_not_found", message: "not found" } }, 404)],
];

describe("preflight --network (mocked providers)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("reports available model and voices, flags a missing voice, never calls generation or TTS, never prints keys", () =>
    withTempDir(async (dir) => {
      const { fn, calls } = mockFetch([
        [/generativelanguage\.googleapis\.com\/.*models\/gemini-9-flash/, () => json({ name: "models/gemini-9-flash", displayName: "Gemini 9 Flash", inputTokenLimit: 1000000, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent", "countTokens"] })],
        ...elevenRoutes,
      ]);
      const { ok, lines } = await runPreflight({ projectRoot: dir, runsDir: `${dir}/runs`, network: true, fetch: fn });
      const text = lines.join("\n");
      expect(text).toContain('model "gemini-9-flash" is available (Gemini 9 Flash)');
      expect(text).toContain('VoiceFemale01 = "Asha", category premade (accent: indian, gender: female)');
      expect(text).toMatch(/VoiceMale01 was not found/);
      expect(ok).toBe(false); // a configured English voice is missing
      expect(calls.every((c) => c.method === "GET")).toBe(true);
      expect(calls.some((c) => /generateContent|text-to-speech/.test(c.url))).toBe(false);
      expect(text).not.toContain(ENV.GEMINI_API_KEY);
      expect(text).not.toContain(ENV.ELEVENLABS_API_KEY);
    }));

  it("unknown Gemini model: fails clearly and lists Flash-class models without substituting", () =>
    withTempDir(async (dir) => {
      const { fn } = mockFetch([
        [/models\/gemini-9-flash/, () => json({ error: { code: 404, status: "NOT_FOUND", message: "models/gemini-9-flash is not found" } }, 404)],
        [/generativelanguage\.googleapis\.com\/v1beta\/models\?/, () =>
          json({ models: [
            { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] },
            { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
          ] })],
        ...elevenRoutes,
      ]);
      const { ok, lines } = await runPreflight({ projectRoot: dir, runsDir: `${dir}/runs`, network: true, fetch: fn });
      const text = lines.join("\n");
      expect(ok).toBe(false);
      expect(text).toMatch(/\[fail\] Gemini: Gemini model "gemini-9-flash" is not available/);
      expect(text).toContain("no automatic substitution");
      expect(text).toContain("gemini-2.5-flash, gemini-flash-latest");
      expect(text).not.toContain("gemini-2.5-pro");
    }));

  it("on the free plan, a Voice Library (professional) voice fails preflight before any speech is attempted", () =>
    withTempDir(async (dir) => {
      const { fn, calls } = mockFetch([
        [/models\/gemini-9-flash/, () => json({ name: "models/gemini-9-flash", supportedGenerationMethods: ["generateContent"] })],
        [/v1\/user\/subscription$/, () => json({ tier: "free", character_count: 160, character_limit: 10000, next_character_count_reset_unix: 1796000000 })],
        [/v1\/voices\/VoiceFemale01$/, () => json({ voice_id: "VoiceFemale01", name: "Riya", category: "professional", labels: {} })],
        [/v1\/voices\/VoiceMale01$/, () => json({ voice_id: "VoiceMale01", name: "Default", category: "premade", labels: {} })],
        ...elevenRoutes,
      ]);
      const { ok, lines } = await runPreflight({ projectRoot: dir, runsDir: `${dir}/runs`, network: true, fetch: fn });
      const text = lines.join("\n");
      expect(ok).toBe(false);
      expect(text).toMatch(/\[fail\] Voice ELEVENLABS_VOICE_ID_INDIAN_FEMALE.*Voice Library voice: on the free plan/);
      expect(text).toMatch(/\[ok\]\s+Voice ELEVENLABS_VOICE_ID_INDIAN_MALE/);
      expect(text).toContain("tier free, 160 / 10000 characters used");
      expect(calls.every((c) => c.method === "GET")).toBe(true);
    }));

  it("without --network nothing is fetched", () =>
    withTempDir(async (dir) => {
      const { fn, calls } = mockFetch([]);
      const { lines } = await runPreflight({ projectRoot: dir, runsDir: `${dir}/runs`, fetch: fn });
      expect(calls).toHaveLength(0);
      expect(lines.join("\n")).toContain("add --network");
    }));
});

describe("ElevenLabs read client", () => {
  it("sends the key only in the xi-api-key header and maps 401 to auth", async () => {
    const { fn, calls } = mockFetch([[/v1\/models$/, () => json({ detail: { status: "invalid_api_key", message: "Invalid API key" } }, 401)]]);
    await expect(new ElevenLabsReadClient("secret-key-value", fn).listModels()).rejects.toMatchObject({ kind: "auth" });
    expect(calls[0]!.headers.get("xi-api-key")).toBe("secret-key-value");
    expect(calls[0]!.url).not.toContain("secret-key-value");
  });
});

describe("review page helpers", () => {
  it("escapes HTML and highlights anchors as whole words", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
    const html = highlightNarration("Heat <b>rises</b>; the heat source glows.", [{ phrase: "heat source", eventNumber: 2 }, { phrase: "Heat", eventNumber: 1 }]);
    expect(html).toBe("<mark>Heat<sup>1</sup></mark> &lt;b&gt;rises&lt;/b&gt;; the <mark>heat source<sup>2</sup></mark> glows.");
  });
});
