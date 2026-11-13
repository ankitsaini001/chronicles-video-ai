import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VOICE_PRESET_LIST } from "../packages/db/src/voices";
import { ProviderError, type SpeechProvider, type SpeechRequest, type SpeechResponse } from "../packages/pipeline/src/providers";
import { DEFAULT_VOICE_SETTINGS, SPEECH_SEED } from "../packages/pipeline/src/pipeline";
import { MAX_TOTAL_CHARACTERS, runVoiceSamplesCommand, SAMPLE_OUTPUT_FORMAT, speechTextFor, VOICES_DIR } from "../tools/cli/voice-samples";
import { withTempDir } from "./helpers";

// F13: the one-time voice sample generator. A fake speech provider: no network, nothing spent.

const ENV = {
  ELEVENLABS_API_KEY: "sk_test_secret_value_123",
  ELEVENLABS_MODEL: "eleven_multilingual_v2",
  ELEVENLABS_VOICE_ID_INDIAN_MALE: "VoiceIndianMale01",
  ELEVENLABS_VOICE_ID_INDIAN_FEMALE: "VoiceIndianFemale1",
  ELEVENLABS_VOICE_ID_HINDI_MALE: "VoiceHindiMale001",
  ELEVENLABS_VOICE_ID_HINDI_FEMALE: "VoiceHindiFemale01",
} as NodeJS.ProcessEnv;

class FakeSpeech implements SpeechProvider {
  readonly name = "fake";
  calls: { request: SpeechRequest; maxRetries: number | undefined }[] = [];
  constructor(private readonly failOn: number | null = null) {}
  async synthesize(request: SpeechRequest, options: { retry?: { maxRetries?: number } } = {}): Promise<SpeechResponse> {
    this.calls.push({ request, maxRetries: options.retry?.maxRetries });
    if (this.failOn === this.calls.length) throw new ProviderError({ provider: "elevenlabs", kind: "quota", message: "quota exceeded" });
    return { audio: new Uint8Array([0xff, 0xfb, 1, 2, 3]), alignment: null, normalizedAlignment: null, requestId: null, characterCost: [...request.text].length, retries: 0, durationMs: 1 };
  }
}

const probe = async () => ({ codec: "mp3", sampleRate: 44100, channels: 1, decodedSeconds: 4.2 });

function run(root: string, speech: FakeSpeech, over: { force?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const printed: string[] = [];
  return runVoiceSamplesCommand({
    projectRoot: root,
    force: over.force ?? false,
    print: (lines) => printed.push(...lines),
    env: over.env ?? ENV,
    speech: () => speech,
    probe,
    usage: async () => null,
  }).then((result) => ({ ...result, printed, all: [...printed, ...result.lines].join("\n") }));
}

describe("voice-samples command", () => {
  it("records all 6 files with the pipeline's settings, one call each, no retries", async () => {
    await withTempDir(async (root) => {
      const speech = new FakeSpeech();
      const result = await run(root, speech);
      expect(result.ok).toBe(true);
      expect(speech.calls).toHaveLength(6);
      for (const call of speech.calls) {
        expect(call.maxRetries).toBe(0);
        expect(call.request).toMatchObject({ modelId: "eleven_multilingual_v2", settings: DEFAULT_VOICE_SETTINGS, seed: SPEECH_SEED, outputFormat: SAMPLE_OUTPUT_FORMAT, applyTextNormalization: "auto", previousText: null, nextText: null });
      }
      const files = (await readdir(path.join(root, VOICES_DIR))).sort();
      expect(files).toEqual(VOICE_PRESET_LIST.map((p) => `${p.preset}.mp3`).sort());
      // One call per preset in list order; Hinglish uses the Hindi voices.
      expect(speech.calls.map((c) => c.request.voiceId)).toEqual([
        "VoiceIndianFemale1",
        "VoiceIndianMale01",
        "VoiceHindiFemale01",
        "VoiceHindiMale001",
        "VoiceHindiFemale01",
        "VoiceHindiMale001",
      ]);
      expect(speech.calls.map((c) => c.request.text)).toEqual(VOICE_PRESET_LIST.map(speechTextFor));
      // The key and voice ids are never printed.
      expect(result.all).not.toContain("sk_test_secret_value_123");
      expect(result.all).not.toMatch(/VoiceHindi|VoiceIndian/);
      expect(result.all).toMatch(/Total: \d+ characters \(limit 600\)/);
    });
  });

  it("stays within the budget: about 300 characters for all 6, well under the limit", () => {
    const total = VOICE_PRESET_LIST.reduce((sum, p) => sum + [...speechTextFor(p)].length, 0);
    expect(total).toBeLessThanOrEqual(450);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_CHARACTERS);
  });

  it("Hinglish is sent with Hindi words in Devanagari (pipeline pronunciation rule); the others as shown", () => {
    for (const p of VOICE_PRESET_LIST) {
      if (p.language === "hinglish") {
        expect(speechTextFor(p)).toBe("Hello दोस्तों! आज हम समझेंगे कि rainbow कैसे बनता है।");
        expect(p.sampleText).toBe("Hello doston! Aaj hum samjhenge ki rainbow kaise banta hai.");
      } else {
        expect(speechTextFor(p)).toBe(p.sampleText);
      }
    }
  });

  it("skips files that already exist, so a second run spends nothing", async () => {
    await withTempDir(async (root) => {
      await run(root, new FakeSpeech());
      const again = new FakeSpeech();
      const result = await run(root, again);
      expect(result.ok).toBe(true);
      expect(again.calls).toHaveLength(0);
      expect(result.all).toContain("Nothing to record");
    });
  });

  it("records only the missing file, and everything again with --force", async () => {
    await withTempDir(async (root) => {
      const dir = path.join(root, VOICES_DIR);
      await mkdir(dir, { recursive: true });
      for (const p of VOICE_PRESET_LIST) if (p.preset !== "hindi-male") await writeFile(path.join(dir, `${p.preset}.mp3`), "old");
      const one = new FakeSpeech();
      await run(root, one);
      expect(one.calls.map((c) => c.request.voiceId)).toEqual(["VoiceHindiMale001"]);
      expect(await readFile(path.join(dir, "hindi-female.mp3"), "utf8")).toBe("old");

      const all = new FakeSpeech();
      await run(root, all, { force: true });
      expect(all.calls).toHaveLength(6);
    });
  });

  it("refuses before any call when a setting is missing", async () => {
    await withTempDir(async (root) => {
      const speech = new FakeSpeech();
      const result = await run(root, speech, { env: { ...ENV, ELEVENLABS_VOICE_ID_HINDI_MALE: "" } });
      expect(result.ok).toBe(false);
      expect(speech.calls).toHaveLength(0);
      expect(result.all).toContain("REFUSED: set ELEVENLABS_VOICE_ID_HINDI_MALE in .env first. Nothing was sent.");
    });
  });

  it("stops at the first failure (no more spending) and keeps the files already made", async () => {
    await withTempDir(async (root) => {
      const speech = new FakeSpeech(3);
      const result = await run(root, speech);
      expect(result.ok).toBe(false);
      expect(speech.calls).toHaveLength(3);
      expect(result.all).toContain("FAILED hindi-female: quota exceeded");
      const files = await readdir(path.join(root, VOICES_DIR));
      expect(files.sort()).toEqual(["indian-english-female.mp3", "indian-english-male.mp3"]);
      expect(files.some((f) => f.endsWith(".part"))).toBe(false);
    });
  });

  it("does not keep a file whose audio cannot be read", async () => {
    await withTempDir(async (root) => {
      const printed: string[] = [];
      const result = await runVoiceSamplesCommand({
        projectRoot: root,
        force: false,
        print: (l) => printed.push(...l),
        env: ENV,
        speech: () => new FakeSpeech(),
        probe: async () => {
          throw new Error("not audio");
        },
        usage: async () => null,
      });
      expect(result.ok).toBe(false);
      expect(existsSync(path.join(root, VOICES_DIR, "indian-english-female.mp3"))).toBe(false);
      expect(existsSync(path.join(root, VOICES_DIR, "indian-english-female.mp3.part"))).toBe(false);
    });
  });
});
