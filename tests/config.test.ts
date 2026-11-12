import { describe, expect, it } from "vitest";
import { ENV_VARS, readConfig, redactSecrets, voiceIdFor } from "../packages/pipeline/src/config/config";
import { VOICE_PRESETS } from "../packages/pipeline/src/contracts";

describe("config", () => {
  it("reports missing settings without failing", () => {
    const report = readConfig({});
    expect(report.entries.every((e) => e.status === "missing")).toBe(true);
    expect(report.readyFor).toEqual({ "live-english": false, "live-hindi-hinglish": false });
    expect(report.entries.find((e) => e.name === "GEMINI_MODEL")!.shown).toContain("gemini-3.8-flash");
  });

  it("treats placeholders as missing and hides secret values", () => {
    const report = readConfig({
      GEMINI_API_KEY: "secret-gemini-key",
      ELEVENLABS_API_KEY: "replace-me",
      GEMINI_MODEL: "gemini-3.8-flash",
      ELEVENLABS_MODEL: "has space",
    });
    const byName = Object.fromEntries(report.entries.map((e) => [e.name, e]));
    expect(byName.GEMINI_API_KEY).toMatchObject({ status: "set", shown: "set (hidden)" });
    expect(byName.ELEVENLABS_API_KEY!.status).toBe("missing");
    expect(byName.GEMINI_MODEL).toMatchObject({ status: "set", shown: "gemini-3.8-flash" });
    expect(byName.ELEVENLABS_MODEL!.status).toBe("invalid");
    expect(JSON.stringify(report.entries)).not.toContain("secret-gemini-key");
  });

  it("is ready for live English once the six English settings are set", () => {
    const env = {
      GEMINI_API_KEY: "k1abc",
      GEMINI_MODEL: "gemini-3.8-flash",
      ELEVENLABS_API_KEY: "k2abc",
      ELEVENLABS_MODEL: "eleven_multilingual_v2",
      ELEVENLABS_VOICE_ID_INDIAN_MALE: "voice1",
      ELEVENLABS_VOICE_ID_INDIAN_FEMALE: "voice2",
    };
    expect(readConfig(env).readyFor).toEqual({ "live-english": true, "live-hindi-hinglish": false });
  });

  it("has four voice settings; Hinglish presets use the Hindi voices", () => {
    const voiceVars = ENV_VARS.map((e) => e.name).filter((n) => n.includes("VOICE_ID"));
    expect(voiceVars).toEqual([
      "ELEVENLABS_VOICE_ID_INDIAN_MALE",
      "ELEVENLABS_VOICE_ID_INDIAN_FEMALE",
      "ELEVENLABS_VOICE_ID_HINDI_MALE",
      "ELEVENLABS_VOICE_ID_HINDI_FEMALE",
    ]);
    const config = readConfig({
      ELEVENLABS_VOICE_ID_INDIAN_MALE: "v-en-m",
      ELEVENLABS_VOICE_ID_INDIAN_FEMALE: "v-en-f",
      ELEVENLABS_VOICE_ID_HINDI_MALE: "v-hi-m",
      ELEVENLABS_VOICE_ID_HINDI_FEMALE: "v-hi-f",
    });
    expect(voiceIdFor("hinglish-male", config)).toBe("v-hi-m");
    expect(voiceIdFor("hinglish-female", config)).toBe("v-hi-f");
    expect(voiceIdFor("hindi-female", config)).toBe("v-hi-f");
    expect(voiceIdFor("indian-english-male", config)).toBe("v-en-m");
    for (const preset of VOICE_PRESETS) expect(voiceIdFor(preset, config)).toBeDefined();
  });

  it("redacts secret values and auth headers", () => {
    const env = { GEMINI_API_KEY: "AIzaSECRET", ELEVENLABS_API_KEY: "sk_eleven" };
    const text = redactSecrets("key AIzaSECRET; Authorization: Bearer abc.def; xi-api-key=sk_other; url ?key=zzz&x=1", env);
    expect(text).not.toMatch(/AIzaSECRET|abc\.def|sk_other|zzz/);
    expect(text).toContain("[redacted]");
  });
});
