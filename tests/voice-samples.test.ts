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
  constructor(
    private readonly failOn: number | null = null,
    private readonly failWith: () => Error = () => new ProviderError({ provider: "elevenlabs", kind: "quota", message: "quota exceeded" }),
  ) {}
  async synthesize(request: SpeechRequest, options: { retry?: { maxRetries?: number } } = {}): Promise<SpeechResponse> {
    this.calls.push({ request, maxRetries: options.retry?.maxRetries });
    if (this.failOn === this.calls.length) throw this.failWith();
    return { audio: new Uint8Array([0xff, 0xfb, 1, 2, 3]), alignment: null, normalizedAlignment: null, requestId: null, characterCost: [...request.text].length, retries: 0, durationMs: 1 };
  }
}

const probe = async () => ({ codec: "mp3", sampleRate: 44100, channels: 1, decodedSeconds: 4.2 });

type RunOver = { force?: boolean; env?: NodeJS.ProcessEnv; probe?: typeof probe; checkProbe?: () => Promise<void>; usage?: () => Promise<string | null> };

function run(root: string, speech: FakeSpeech, over: RunOver = {}) {
  const printed: string[] = [];
  return runVoiceSamplesCommand({
    projectRoot: root,
    force: over.force ?? false,
    print: (lines) => printed.push(...lines),
    env: over.env ?? ENV,
    speech: () => speech,
    probe: over.probe ?? probe,
    checkProbe: over.checkProbe ?? (async () => undefined),
    usage: over.usage ?? (async () => null),
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

  it("keeps paid audio as .unverified when its check fails, and stops", async () => {
    await withTempDir(async (root) => {
      const speech = new FakeSpeech();
      const result = await run(root, speech, {
        probe: async () => {
          throw new Error("not audio");
        },
      });
      expect(result.ok).toBe(false);
      expect(speech.calls).toHaveLength(1);
      const dir = path.join(root, VOICES_DIR);
      expect(await readdir(dir)).toEqual(["indian-english-female.mp3.unverified"]);
      expect(result.all).toContain(`kept as ${path.join(VOICES_DIR, "indian-english-female.mp3.unverified")}`);
    });
  });

  it("refuses before any call when ffprobe doesn't run", async () => {
    await withTempDir(async (root) => {
      const speech = new FakeSpeech();
      const result = await run(root, speech, {
        checkProbe: async () => {
          throw new Error("ffprobe not found");
        },
      });
      expect(result.ok).toBe(false);
      expect(speech.calls).toHaveLength(0);
      expect(result.all).toContain("REFUSED: ffprobe");
      expect(result.all).toContain("Nothing was sent.");
    });
  });

  it("refuses a voice ID with a bad format by variable name only, before any call", async () => {
    await withTempDir(async (root) => {
      const speech = new FakeSpeech();
      const result = await run(root, speech, { env: { ...ENV, ELEVENLABS_VOICE_ID_HINDI_MALE: "bad/id..123" } });
      expect(result.ok).toBe(false);
      expect(speech.calls).toHaveLength(0);
      expect(result.all).toContain("ELEVENLABS_VOICE_ID_HINDI_MALE must be letters and digits only");
      expect(result.all).not.toContain("bad/id..123");
    });
  });

  it("never prints a voice ID, even inside a provider error message", async () => {
    await withTempDir(async (root) => {
      const speech = new FakeSpeech(1, () => new ProviderError({ provider: "elevenlabs", kind: "voice-unavailable", status: 404, message: "voice_not_found: A voice with voice_id VoiceIndianFemale1 was not found" }));
      const result = await run(root, speech);
      expect(result.ok).toBe(false);
      expect(result.all).not.toContain("VoiceIndianFemale1");
      expect(result.all).toContain("voice_id [voice id] was not found");
      expect(result.all).not.toContain("may have been charged");
    });
  });

  it("after a failure still shows the account usage", async () => {
    await withTempDir(async (root) => {
      let reads = 0;
      const result = await run(root, new FakeSpeech(2), { usage: async () => `read ${++reads}` });
      expect(result.all).toContain("ElevenLabs account before: read 1");
      expect(result.all).toContain("ElevenLabs account after: read 2");
    });
  });

  it.each([
    ["a timeout / network failure (no answer)", () => new ProviderError({ provider: "elevenlabs", kind: "transient", message: "request failed: timeout" }), true],
    ["an unreadable 200 answer", () => new ProviderError({ provider: "elevenlabs", kind: "bad-response", message: "unreadable JSON" }), true],
    ["a 429 busy answer", () => new ProviderError({ provider: "elevenlabs", kind: "transient", status: 429, message: "busy" }), false],
    ["a 402 refusal", () => new ProviderError({ provider: "elevenlabs", kind: "account-restricted", status: 402, message: "payment_required" }), false],
  ])("says the call may have been charged only when it might: %s", async (_label, failWith, maybe) => {
    await withTempDir(async (root) => {
      const result = await run(root, new FakeSpeech(1, failWith));
      expect(result.ok).toBe(false);
      expect(result.all.includes("This call may have been charged: 55 characters.")).toBe(maybe);
    });
  });

  it("an empty (0-byte) sample file counts as missing and is recorded again", async () => {
    await withTempDir(async (root) => {
      const dir = path.join(root, VOICES_DIR);
      await mkdir(dir, { recursive: true });
      for (const p of VOICE_PRESET_LIST) await writeFile(path.join(dir, `${p.preset}.mp3`), p.preset === "hindi-female" ? "" : "old");
      const speech = new FakeSpeech();
      await run(root, speech);
      expect(speech.calls.map((c) => c.request.voiceId)).toEqual(["VoiceHindiFemale01"]);
    });
  });
});
