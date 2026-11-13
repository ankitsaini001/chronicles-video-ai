import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VOICE_PRESET_LIST, VOICE_TEXT_LANG, voicePresetFor } from "../packages/db/src/voices";
import { LANGUAGES, VOICE_PRESETS, VOICE_PRESETS_BY_LANGUAGE } from "../packages/pipeline/src/contracts";
import { VOICE_ID_ENV_BY_PRESET } from "../packages/pipeline/src/config/config";

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
