import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VOICE_PRESET_LIST, VOICE_TEXT_LANG, voicePresetFor } from "../packages/db/src/voices";
import { LANGUAGES, VOICE_PRESETS, VOICE_PRESETS_BY_LANGUAGE } from "../packages/pipeline/src/contracts";
import { VOICE_ID_ENV_BY_PRESET } from "../packages/pipeline/src/config/config";
import { API_RATE_LIMITS, type RateLimitRule } from "../packages/db/src/rate-limit";
import { handleApiRequest, type ApiDeps, type ApiEndpoint } from "../apps/web/lib/api/v1";
import type { SessionUser } from "../apps/web/lib/auth/session";
import { listVoices } from "../apps/web/lib/voices";

// F13: the shared voice preset list (API.md B4, §11.1) stays equal to the pipeline's presets.

describe("VOICE_PRESET_LIST", () => {
  it("has exactly the pipeline's 6 presets, each in the right language", () => {
    expect(VOICE_PRESET_LIST.map((p) => p.preset).sort()).toEqual([...VOICE_PRESETS].sort());
    for (const language of LANGUAGES) {
      const ours = VOICE_PRESET_LIST.filter((p) => p.language === language).map((p) => p.preset);
      expect(ours.sort()).toEqual([...VOICE_PRESETS_BY_LANGUAGE[language]].sort());
    }
  });

  it("is ordered per language, female first", () => {
    expect(VOICE_PRESET_LIST.map((p) => p.preset)).toEqual([
      "indian-english-female",
      "indian-english-male",
      "hindi-female",
      "hindi-male",
      "hinglish-female",
      "hinglish-male",
    ]);
  });

  it("points each preset at its own static MP3 and a gender that matches its id", () => {
    for (const p of VOICE_PRESET_LIST) {
      expect(p.sampleUrl).toBe(`/voices/${p.preset}.mp3`);
      expect(p.preset.endsWith(`-${p.gender}`)).toBe(true);
    }
  });

  it("matches the B4 example in API.md for Hindi (labels and text)", () => {
    expect(voicePresetFor("hi", "female")).toMatchObject({ label: "महिला आवाज़ (Female)", sampleText: "नमस्ते! आज हम समझेंगे कि इंद्रधनुष कैसे बनता है।" });
    expect(voicePresetFor("hi", "male")).toMatchObject({ label: "पुरुष आवाज़ (Male)" });
    const api = readFileSync(path.join(__dirname, "../docs/API.md"), "utf8");
    for (const p of VOICE_PRESET_LIST.filter((x) => x.language === "hi")) {
      const line = `{ "preset": "${p.preset}", "language": "hi", "gender": "${p.gender}", "label": "${p.label}", "sampleUrl": "${p.sampleUrl}", "sampleText": "${p.sampleText}", "enabled": true }`;
      expect(api).toContain(line);
    }
  });

  it("uses plain 'Female voice' / 'Male voice' labels, never a voice name or voice id", () => {
    expect(voicePresetFor("en", "female").label).toBe("Female voice");
    expect(voicePresetFor("hinglish", "male").label).toBe("Male voice");
    for (const p of VOICE_PRESET_LIST) {
      expect(p.label).toMatch(/(Female|Male)/);
      expect(Object.keys(p).sort()).toEqual(["gender", "label", "language", "preset", "sampleText", "sampleUrl"]);
    }
  });

  it("Hinglish reuses the Hindi voices but has its own Latin-script sentence", () => {
    expect(VOICE_ID_ENV_BY_PRESET["hinglish-female"]).toBe(VOICE_ID_ENV_BY_PRESET["hindi-female"]);
    expect(voicePresetFor("hinglish", "female").sampleText).toBe("Hello doston! Aaj hum samjhenge ki rainbow kaise banta hai.");
    expect(VOICE_TEXT_LANG).toEqual({ en: "en-IN", hi: "hi", hinglish: "hi-Latn" });
  });
});

// ---------- B4 GET /api/v1/voices, through the shared /api/v1 pipeline (fakes, no database) ----------

describe("B4 GET /api/v1/voices", () => {
  const APP = "http://localhost:3000";
  const user: SessionUser = {
    id: "67330c1a9f1e4b2a7c0d1e01",
    name: "Ananya Iyer",
    email: "ananya.iyer@example.in",
    role: "creator",
    timezone: "Asia/Kolkata",
    defaultLanguage: "en",
    defaultVoiceGender: "female",
    createdAt: "2026-11-12T04:30:00.000Z",
  };
  const rules: RateLimitRule[] = [];
  const deps = (signedIn = true): ApiDeps => ({
    appOrigins: [APP],
    getUser: async () => (signedIn ? user : null),
    hitRateLimit: async (rule) => {
      rules.push(rule);
      return { allowed: true, count: 1, limit: rule.limit, resetsAt: new Date(), retryAfterSeconds: 60 };
    },
    logError: () => undefined,
    newRequestId: () => "req_TEST0000000000",
  });
  const endpoint: ApiEndpoint = { rateLimit: API_RATE_LIMITS.readsPerUser, handle: async ({ request }) => listVoices(new URL(request.url)) };
  const get = (query = "", signedIn = true) => handleApiRequest(new Request(`${APP}/api/v1/voices${query}`), endpoint, deps(signedIn));

  it("lists all 6 presets with enabled: true and no voice ids", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { items: Record<string, unknown>[] };
    expect(body.items.map((i) => i.preset)).toEqual(VOICE_PRESET_LIST.map((p) => p.preset));
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(["enabled", "gender", "label", "language", "preset", "sampleText", "sampleUrl"]);
      expect(item.enabled).toBe(true);
    }
    expect(JSON.stringify(body)).not.toMatch(/voiceId|ELEVENLABS/i);
    expect(rules.at(-1)).toEqual(API_RATE_LIMITS.readsPerUser);
  });

  it("filters by language (hi → the API.md example)", async () => {
    const body = (await (await get("?language=hi")).json()) as { items: { preset: string }[] };
    expect(body.items.map((i) => i.preset)).toEqual(["hindi-female", "hindi-male"]);
    const hinglish = (await (await get("?language=hinglish")).json()) as { items: { preset: string }[] };
    expect(hinglish.items.map((i) => i.preset)).toEqual(["hinglish-female", "hinglish-male"]);
  });

  it.each(["?language=fr", "?language=", "?language=EN", "?language=en&language=hi"])("refuses %s with 400 INVALID_INPUT", async (query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "Please check the highlighted fields.",
        details: { issues: [{ path: "language", message: "must be one of en, hi, hinglish" }] },
        requestId: "req_TEST0000000000",
      },
    });
  });

  it("needs a signed-in creator", async () => {
    expect((await get("", false)).status).toBe(401);
  });
});
