import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SceneAlignmentSchema, SceneSchema, type CharacterAlignment, type Scene } from "../packages/pipeline/src/contracts";
import {
  approveRun,
  buildSceneAlignment,
  cacheRecordFor,
  generateRun,
  loadManifest,
  runPlanStage,
  sceneContext,
  speechCacheKey,
  speechConfigFor,
  speechRequestFor,
  type GenerateOptions,
} from "../packages/pipeline/src/pipeline";
import type { RenderJob, RenderReport } from "../packages/pipeline/src/pipeline/render";
import { classifySpeechError, ElevenLabsSpeech, ProviderError, type SpeechProvider, type SpeechRequest, type SpeechResponse } from "../packages/pipeline/src/providers";
import { ArtifactKeys, LocalArtifactStore, LocalSpeechCache } from "../packages/pipeline/src/storage";
import { AlignmentMappingError, AlignmentValidationError, resolveProviderAlignment, speechInputForScene, timeSceneBlocks } from "../packages/pipeline/src/timing";
import { evaluateProbe, parseAudioProbe, type AudioProbe, type Mp4Probe } from "../packages/pipeline/src/validation";
import { validPlan, withTempDir } from "./helpers";
import { MockPlanner, modelOutputFromFixture, TOPIC } from "./planner-helpers";

// ---------- synthetic provider data (no network) ----------

/** Per-character alignment for `text`: 0.065 s per non-space character, spaces take no time. */
function alignText(text: string, offset = 0.1): CharacterAlignment {
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let t = offset;
  for (const ch of text) {
    characters.push(ch);
    starts.push(Math.round(t * 1000) / 1000);
    if (ch !== " ") t += 0.065;
    ends.push(Math.round(t * 1000) / 1000);
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}

const endOf = (a: CharacterAlignment) => a.character_end_times_seconds.at(-1)!;

function testScene(texts: string[]): Scene {
  return SceneSchema.parse({
    id: "scene-test",
    type: "takeaway",
    narration: texts.map((text, i) => ({ id: `line-${i + 1}`, text })),
    objects: [{ id: "h", kind: "headline", label: "Test" }],
    events: [],
  });
}

const resolve = (speechText: string, original: CharacterAlignment | null, normalized: CharacterAlignment | null, audio = 30) =>
  resolveProviderAlignment({ sceneId: "s", speechText, original, normalized, audioDurationSeconds: audio, locale: "en" });

// ---------- alignment validation + normalization mapping ----------

describe("provider alignment validation", () => {
  const text = "Water rises.";
  const good = alignText(text);

  it("uses the original alignment when it spells the speech text", () => {
    expect(resolve(text, good, alignText(text))).toMatchObject({ mappedFrom: "original", alignment: good });
  });

  it("rejects unequal array lengths, non-finite / negative times, unordered starts, end < start and times past the audio", () => {
    const broken = (patch: (a: CharacterAlignment) => void) => {
      const a = structuredClone(good);
      patch(a);
      return () => resolve(text, a, null);
    };
    expect(broken((a) => a.character_end_times_seconds.pop())).toThrow(/array lengths differ/);
    expect(broken((a) => (a.character_start_times_seconds[3] = Number.NaN))).toThrow(/non-finite or negative/);
    expect(broken((a) => (a.character_start_times_seconds[0] = -0.2))).toThrow(/non-finite or negative/);
    expect(broken((a) => (a.character_start_times_seconds[5] = 0.01))).toThrow(/before character 4/);
    expect(broken((a) => (a.character_end_times_seconds[2] = 0.05))).toThrow(/ends .* before it starts/);
    expect(() => resolve(text, good, null, endOf(good) - 0.3)).toThrow(/after the audio ends/);
    expect(() => resolve(text, null, null)).toThrow(AlignmentValidationError);
  });

  it("validates the normalized alignment too", () => {
    const bad = alignText(text);
    bad.characters.pop();
    expect(() => resolve(text, good, bad)).toThrow(/array lengths differ/);
  });

  it("stops (no guess) when the original does not spell the text and there is no normalized alignment", () => {
    expect(() => resolve(text, alignText("Water rises!"), null)).toThrow(/does not spell the text that was sent/);
  });

  it('maps "97%" back from the spoken "ninety-seven percent" (many-to-many) and keeps word times', () => {
    const speechText = "About 97% is ocean water.";
    const spoken = " About ninety-seven percent is ocean water.";
    const normalized = alignText(spoken);
    const result = resolve(speechText, alignText("About 97 % is ocean water."), normalized);
    expect(result.mappedFrom).toBe("normalized");
    expect(result.alignment.characters.join("")).toBe(speechText);
    // "97%" spans from "ninety" start to "percent" end in the spoken alignment.
    const ninety = spoken.indexOf("ninety");
    const percentEnd = spoken.indexOf("percent") + "percent".length - 1;
    const i97 = speechText.indexOf("97");
    expect(result.alignment.character_start_times_seconds[i97]).toBeCloseTo(normalized.character_start_times_seconds[ninety]!, 3);
    expect(result.alignment.character_end_times_seconds[i97 + 2]).toBeCloseTo(normalized.character_end_times_seconds[percentEnd]!, 3);
    // "is" keeps its own spoken time.
    const isAt = speechText.indexOf(" is ") + 1;
    expect(result.alignment.character_start_times_seconds[isAt]).toBeCloseTo(normalized.character_start_times_seconds[spoken.indexOf(" is ") + 1]!, 3);
  });

  it("maps repeated words positionally, and ignores punctuation and apostrophe styles", () => {
    const speechText = "Rain, rain — Earth’s rain falls.";
    const spoken = "Rain rain Earth's rain falls";
    const result = resolve(speechText, alignText("Rain, rain - Earth's rain falls."), alignText(spoken));
    expect(result.mappedFrom).toBe("normalized");
    const starts = result.alignment.character_start_times_seconds;
    const firstRain = starts[0]!;
    const secondRain = starts[speechText.indexOf("rain")]!;
    const thirdRain = starts[speechText.lastIndexOf("rain")]!;
    expect(firstRain).toBeLessThan(secondRain);
    expect(secondRain).toBeLessThan(thirdRain);
    // Ordered and valid after mapping.
    for (let i = 1; i < starts.length; i++) expect(starts[i]!).toBeGreaterThanOrEqual(starts[i - 1]!);
  });

  it("raises a recoverable mapping error when normalized words cannot be reconciled", () => {
    expect(() => resolve("About 97% is ocean.", alignText("x"), alignText("About ninety percent is ocean."))).toThrow(AlignmentMappingError);
  });
});

// ---------- the scene alignment built from a provider response ----------

describe("buildSceneAlignment", () => {
  const plan = validPlan();
  const config = speechConfigFor(plan, "voiceF", "eleven_multilingual_v2");

  it('maps the approved text "ninety-seven percent" against a provider that spoke it as written', () => {
    const scene = { ...testScene(["About ninety-seven percent of Earth’s water is salty.", "Only about one percent is fresh."]) };
    const { speechText } = speechInputForScene(scene);
    const request: SpeechRequest = { ...speechRequestFor({ ...plan, scenes: [scene] }, 0, config) };
    const alignment = alignText(speechText);
    const record = cacheRecordFor(speechCacheKey(scene, config), request, fakeResponse(alignment, alignText(speechText)), new Date("2026-11-12T10:00:00Z"));
    const built = buildSceneAlignment({ plan, scene, config, record, probe: probeFor(endOf(alignment) + 0.3) });
    expect(SceneAlignmentSchema.parse(built).speech).toMatchObject({ mappedFrom: "original", voiceId: "voiceF", cacheKey: record.cacheKey });
    expect(built.audioDurationSeconds).toBeCloseTo(endOf(alignment) + 0.3, 3);
    expect(timeSceneBlocks(scene, built, "en")).toHaveLength(2);
  });

  it("rejects alignment past the decoded audio (probe of the real file)", () => {
    const scene = testScene(["Water rises."]);
    const { speechText } = speechInputForScene(scene);
    const record = cacheRecordFor(speechCacheKey(scene, config), speechRequestFor({ ...plan, scenes: [scene] }, 0, config), fakeResponse(alignText(speechText), null), new Date());
    expect(() => buildSceneAlignment({ plan, scene, config, record, probe: probeFor(0.3) })).toThrow(/after the audio ends/);
  });
});

// ---------- cache key ----------

describe("speech cache key", () => {
  const plan = validPlan();
  const config = speechConfigFor(plan, "voiceF", "eleven_multilingual_v2");
  const scene = plan.scenes[1]!;
  const key = speechCacheKey(scene, config);

  it("changes with narration, pronunciation, voice, model and settings", () => {
    const edited = structuredClone(scene);
    edited.narration[0]!.text += " Really.";
    expect(speechCacheKey(edited, config)).not.toBe(key);
    const pron = structuredClone(scene);
    pron.narration[0]!.speech = pron.narration[0]!.text.replace("97%", "ninety seven percent");
    expect(speechCacheKey(pron, config)).not.toBe(key);
    expect(speechCacheKey(scene, { ...config, voiceId: "voiceM" })).not.toBe(key);
    expect(speechCacheKey(scene, { ...config, modelId: "eleven_flash_v2_5" })).not.toBe(key);
    expect(speechCacheKey(scene, { ...config, settings: { ...config.settings, stability: 0.6 } })).not.toBe(key);
  });

  it("ignores visual-only changes and the neighbouring-scene continuity context", () => {
    const visual = structuredClone(scene);
    visual.objects[0]!.label = "Something else";
    expect(speechCacheKey(visual, config)).toBe(key);
    const otherPlan = structuredClone(plan);
    otherPlan.scenes[0]!.narration.at(-1)!.text = "A different previous line.";
    expect(sceneContext(otherPlan, 1).previousText).toBe("A different previous line.");
    expect(speechCacheKey(otherPlan.scenes[1]!, config)).toBe(key);
  });

  it("sends previous_text / next_text from the neighbouring scenes", () => {
    const request = speechRequestFor(plan, 1, config);
    expect(request.previousText).toBe(plan.scenes[0]!.narration.at(-1)!.text);
    expect(request.nextText).toBe(plan.scenes[2]!.narration[0]!.text);
    expect(speechRequestFor(plan, 0, config).previousText).toBeNull();
    expect(speechRequestFor(plan, plan.scenes.length - 1, config).nextText).toBeNull();
  });
});

// ---------- ElevenLabs adapter (mocked fetch) ----------

describe("ElevenLabs speech adapter", () => {
  const request: SpeechRequest = {
    voiceId: "voiceF",
    modelId: "eleven_multilingual_v2",
    text: "Water rises.",
    previousText: "Before.",
    nextText: "After.",
    settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 },
    outputFormat: "mp3_44100_128",
    seed: 1,
    applyTextNormalization: "auto",
  };
  const okBody = () =>
    JSON.stringify({ audio_base64: Buffer.from("mp3").toString("base64"), alignment: alignText("Water rises."), normalized_alignment: alignText(" Water rises.") });

  it("posts to the with-timestamps endpoint with the configured voice, model, context and key header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(okBody(), { status: 200, headers: { "x-character-count": "12", "request-id": "req-1" } });
    }) as unknown as typeof fetch;
    const response = await new ElevenLabsSpeech("secret-key", fetchFn).synthesize(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voiceF/with-timestamps?output_format=mp3_44100_128");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("secret-key");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ text: "Water rises.", model_id: "eleven_multilingual_v2", previous_text: "Before.", next_text: "After.", seed: 1 });
    expect(response).toMatchObject({ characterCost: 12, requestId: "req-1", retries: 0 });
    expect(Buffer.from(response.audio).toString()).toBe("mp3");
    expect(response.normalizedAlignment?.characters.join("")).toBe(" Water rises.");
  });

  it("retries transient errors at most twice, honoring Retry-After, and calls beforeAttempt for every attempt", async () => {
    let n = 0;
    const waits: number[] = [];
    const attempts: number[] = [];
    const fetchFn = (async () => {
      n++;
      return n < 3 ? new Response('{"detail":{"status":"system_busy","message":"busy"}}', { status: 429, headers: { "retry-after": "3" } }) : new Response(okBody(), { status: 200 });
    }) as unknown as typeof fetch;
    const response = await new ElevenLabsSpeech("k", fetchFn).synthesize(request, {
      beforeAttempt: (a) => void attempts.push(a),
      retry: { sleep: async (ms) => void waits.push(ms) },
    });
    expect(response.retries).toBe(2);
    expect(waits).toEqual([3000, 3000]);
    expect(attempts).toEqual([1, 2, 3]);

    n = -10; // always failing now
    await expect(new ElevenLabsSpeech("k", fetchFn).synthesize(request, { retry: { sleep: async () => undefined } })).rejects.toMatchObject({ kind: "transient" });
  });

  it.each([
    [401, "invalid_api_key", "Invalid API key", "auth"],
    [400, "voice_not_found", "A voice with the voice_id voiceF was not found.", "voice-unavailable"],
    [401, "quota_exceeded", "This request exceeds your quota of 10000.", "quota"],
    [401, "detected_unusual_activity", "Unusual activity detected. Free Tier usage disabled.", "account-restricted"],
    [402, "paid_plan_required", "Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.", "account-restricted"],
  ])("stops immediately on %i %s (no retry, no other voice)", async (status, code, message, kind) => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      return new Response(JSON.stringify({ detail: { status: code, message } }), { status });
    }) as unknown as typeof fetch;
    const error = await new ElevenLabsSpeech("k", fetchFn).synthesize(request, { retry: { sleep: async () => undefined } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind, retryable: false });
    expect(n).toBe(1);
  });

  it("classifies busy/server errors as transient", () => {
    expect(classifySpeechError(429, "too_many_concurrent_requests", "")).toBe("transient");
    expect(classifySpeechError(503, null, "Service Unavailable")).toBe("transient");
    expect(classifySpeechError(422, null, "text: field required")).toBe("invalid-request");
  });
});

// ---------- audio probe + MP4 audio checks ----------

describe("audio validation", () => {
  it("derives the decoded MP3 duration from decoded frames, and rejects files without audio", () => {
    const out = JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 1, nb_read_frames: "383", duration: "10.03" }] });
    expect(parseAudioProbe(out)).toEqual({ codec: "mp3", sampleRate: 44100, channels: 1, decodedSeconds: Math.round(((383 * 1152) / 44100) * 10000) / 10000 });
    expect(() => parseAudioProbe(JSON.stringify({ streams: [] }))).toThrow(/no audio stream/);
  });

  it("requires one AAC audio track as long as the video for live runs", () => {
    const timeline = { fps: 30, width: 1080, height: 1920, totalFrames: 2100, timingSource: "elevenlabs" } as never;
    const probe: Mp4Probe = {
      codec: "h264", width: 1080, height: 1920, frameRate: "30/1", decodedFrames: 2100, durationSeconds: 70, pixelFormat: "yuv420p",
      audioStreams: 1, audioCodec: "aac", audioDurationSeconds: 70.02, audioSampleRate: 48000,
    };
    expect(evaluateProbe(probe, timeline).every((c) => c.ok)).toBe(true);
    const failing = (p: Partial<Mp4Probe>) => evaluateProbe({ ...probe, ...p }, timeline).filter((c) => !c.ok).map((c) => c.name);
    expect(failing({ audioStreams: 0, audioCodec: null, audioDurationSeconds: null })).toEqual(expect.arrayContaining(["audio present"]));
    expect(failing({ audioDurationSeconds: 64.5 })).toEqual([expect.stringMatching(/audio duration matches video/)]);
  });
});

// ---------- generate / resume orchestration (mock provider, fake probes and renderer) ----------

const NOW = () => new Date("2026-11-12T10:00:00.000Z");

function fakeResponse(alignment: CharacterAlignment, normalized: CharacterAlignment | null, audioSeconds = endOf(alignment) + 0.25): SpeechResponse {
  return { audio: new Uint8Array(Buffer.from(`FAKE-MP3 ${audioSeconds.toFixed(4)}`)), alignment, normalizedAlignment: normalized, requestId: "req", characterCost: null, retries: 0, durationMs: 1 };
}

function probeFor(seconds: number): AudioProbe {
  return { codec: "mp3", sampleRate: 44100, channels: 1, decodedSeconds: Math.round(seconds * 10000) / 10000 };
}

/** Reads the duration written into the fake MP3 bytes. */
async function fakeProbeAudio(file: string): Promise<AudioProbe> {
  const text = await readFile(file, "utf8");
  const match = /^FAKE-MP3 ([\d.]+)$/.exec(text);
  if (!match) throw new Error("not a fake mp3");
  return probeFor(Number(match[1]));
}

class MockSpeech implements SpeechProvider {
  readonly name = "mock-elevenlabs";
  readonly requests: SpeechRequest[] = [];
  constructor(private readonly fail?: (request: SpeechRequest) => Error | null) {}
  async synthesize(request: SpeechRequest, options: { beforeAttempt?: (attempt: number) => Promise<void> | void } = {}): Promise<SpeechResponse> {
    await options.beforeAttempt?.(1);
    this.requests.push(request);
    const error = this.fail?.(request);
    if (error) throw error;
    return { ...fakeResponse(alignText(request.text), alignText(request.text)), characterCost: [...request.text].length };
  }
}

async function fakeRender(job: RenderJob): Promise<RenderReport> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(job.outputPath, "not really an mp4");
  await fs.mkdir(job.previewDir, { recursive: true });
  const previews = [];
  for (const p of job.previewFrames) {
    const file = path.join(job.previewDir, `${p.id}.png`);
    await fs.writeFile(file, `png ${p.frame}`);
    previews.push({ ...p, path: file });
  }
  // The composition receives every scene's audio through publicDir.
  for (const scene of job.timeline.scenes) await fs.access(path.join(job.publicDir!, scene.audioKey!));
  return { bundleMs: 1, renderMs: 2, stillsMs: 3, previews };
}

const goodLiveProbe = (frames: number): Mp4Probe => ({
  codec: "h264", width: 1080, height: 1920, frameRate: "30/1", decodedFrames: frames, durationSeconds: frames / 30, pixelFormat: "yuv420p",
  audioStreams: 1, audioCodec: "aac", audioDurationSeconds: frames / 30, audioSampleRate: 48000,
});

async function approvedLiveRun(store: LocalArtifactStore) {
  const result = await runPlanStage({ store, provider: new MockPlanner([JSON.stringify(modelOutputFromFixture())]), topic: TOPIC, voicePreset: "indian-english-female", projectId: "water-cycle-abc123", now: NOW });
  if (result.status !== "awaiting-approval") throw new Error("plan failed");
  await approveRun({ store, run: result.run, planHash: result.planHash, now: NOW });
  return result;
}

function generateOptions(dir: string, store: LocalArtifactStore, run: GenerateOptions["run"], speech: MockSpeech, extra: Partial<GenerateOptions> = {}): GenerateOptions {
  let lastFrames = 0;
  return {
    store,
    run,
    mode: "generate",
    speechCache: new LocalSpeechCache(dir),
    speechConfig: (plan) => speechConfigFor(plan, "voiceF", "eleven_multilingual_v2"),
    speechProvider: () => speech,
    render: async (job) => {
      lastFrames = job.timeline.totalFrames;
      return fakeRender(job);
    },
    probe: async () => goodLiveProbe(lastFrames),
    probeAudio: fakeProbeAudio,
    now: NOW,
    ...extra,
  };
}

describe("generate / resume (mock speech provider, no network)", () => {
  it("synthesizes each scene once, compiles with real audio durations, renders with audio and is ready for review", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const planned = await approvedLiveRun(store);
      const speech = new MockSpeech();
      const result = await generateRun(generateOptions(dir, store, planned.run, speech));
      if (result.status !== "ready-for-review") throw new Error(`${result.status}: ${"message" in result ? result.message : ""}`);
      expect(speech.requests).toHaveLength(planned.plan.scenes.length);
      expect(speech.requests.every((r) => r.voiceId === "voiceF" && r.modelId === "eleven_multilingual_v2")).toBe(true);
      expect(result.compiled.timeline.timingSource).toBe("elevenlabs");
      expect(result.compiled.timeline.scenes.every((s) => s.audioKey === `audio/${s.sceneId}.mp3`)).toBe(true);
      expect(result.qa.liveResult).toBe(true);
      const manifest = (await loadManifest(store, planned.run))!;
      expect(manifest.state).toBe("ready-for-review");
      expect(manifest.timingSource).toBe("elevenlabs");
      expect(manifest.scenes.every((s) => s.speech.status === "succeeded")).toBe(true);
      const total = planned.plan.scenes.reduce((sum, s) => sum + [...speechInputForScene(s).speechText].length, 0);
      expect(manifest.speechUsage).toEqual({ requests: planned.plan.scenes.length, charactersSent: total, charactersReported: total });
      // Scene length is the decoded audio duration (+ hold), not the last caption character.
      const first = result.compiled.timeline.scenes[0]!;
      const savedAlignment = SceneAlignmentSchema.parse(await store.readJson(planned.run, ArtifactKeys.alignment(first.sceneId)));
      expect(first.audioDurationSeconds).toBe(savedAlignment.audioDurationSeconds);
      expect(savedAlignment.speech?.providerAlignment).not.toBeNull();
      expect(savedAlignment.normalizedAlignment).not.toBeNull();

      // Running generate again calls nothing.
      const again = await generateRun(generateOptions(dir, store, planned.run, speech));
      expect(again.status).toBe("already-done");
      expect(speech.requests).toHaveLength(planned.plan.scenes.length);
    }));

  it("a render failure resumes without any new speech call", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const planned = await approvedLiveRun(store);
      const speech = new MockSpeech();
      const failed = await generateRun(generateOptions(dir, store, planned.run, speech, { render: async () => { throw new Error("chromium crashed"); } }));
      expect(failed).toMatchObject({ status: "failed", stage: "render" });
      expect((await loadManifest(store, planned.run))!.state).toBe("failed");
      const calls = speech.requests.length;
      expect(calls).toBe(planned.plan.scenes.length);

      // generate on a failed run points to resume.
      expect(await generateRun(generateOptions(dir, store, planned.run, speech))).toMatchObject({ status: "refused", message: expect.stringMatching(/resume/) });
      const resumed = await generateRun(generateOptions(dir, store, planned.run, speech, { mode: "resume" }));
      expect(resumed.status).toBe("ready-for-review");
      expect(speech.requests).toHaveLength(calls);
      if (resumed.status === "ready-for-review") expect(resumed.scenes.every((s) => s.source === "run")).toBe(true);
    }));

  it("reuses the content-addressed cache when the run's copy is missing or changed (no new call)", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const planned = await approvedLiveRun(store);
      const speech = new MockSpeech();
      await generateRun(generateOptions(dir, store, planned.run, speech, { render: async () => { throw new Error("boom"); } }));
      const sceneId = planned.plan.scenes[2]!.id;
      await writeFile(path.join(store.runDir(planned.run), ArtifactKeys.audio(sceneId)), "tampered");
      const calls = speech.requests.length;
      const resumed = await generateRun(generateOptions(dir, store, planned.run, speech, { mode: "resume" }));
      expect(resumed.status).toBe("ready-for-review");
      expect(speech.requests).toHaveLength(calls);
      if (resumed.status === "ready-for-review") expect(resumed.scenes.find((s) => s.sceneId === sceneId)?.source).toBe("cache");
    }));

  it("a probe synthesizes only the named scene; the full run then synthesizes only the rest", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const planned = await approvedLiveRun(store);
      const speech = new MockSpeech();
      const probeScene = planned.plan.scenes.at(-1)!.id;
      const probe = await generateRun(generateOptions(dir, store, planned.run, speech, { onlyScenes: [probeScene] }));
      expect(probe).toMatchObject({ status: "speech-only" });
      expect(speech.requests).toHaveLength(1);
      expect((await loadManifest(store, planned.run))!.state).toBe("plan-approved");

      const full = await generateRun(generateOptions(dir, store, planned.run, speech));
      expect(full.status).toBe("ready-for-review");
      expect(speech.requests).toHaveLength(planned.plan.scenes.length);
      expect(speech.requests.filter((r) => r.text === speechInputForScene(planned.plan.scenes.at(-1)!).speechText)).toHaveLength(1);
    }));

  it("never sends a request over the character budget", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const planned = await approvedLiveRun(store);
      const speech = new MockSpeech();
      const first = [...speechInputForScene(planned.plan.scenes[0]!).speechText].length;
      const result = await generateRun(generateOptions(dir, store, planned.run, speech, { maxCharacters: first + 5 }));
      expect(result).toMatchObject({ status: "needs-input", stage: "speech", message: expect.stringMatching(/budget/) });
      expect(speech.requests).toHaveLength(1);
      expect((await loadManifest(store, planned.run))!.speechUsage.charactersSent).toBe(first);
    }));

  it("stops immediately on a refused voice and never swaps in another voice", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const planned = await approvedLiveRun(store);
      const speech = new MockSpeech(() => new ProviderError({ provider: "elevenlabs", kind: "account-restricted", message: "Free users cannot use library voices via the API" }));
      const result = await generateRun(generateOptions(dir, store, planned.run, speech));
      expect(result).toMatchObject({ status: "failed", stage: "speech", message: expect.stringMatching(/library voices.*no other voice was used/) });
      expect(speech.requests).toHaveLength(1);
      expect(new Set(speech.requests.map((r) => r.voiceId))).toEqual(new Set(["voiceF"]));
      expect((await loadManifest(store, planned.run))!.state).toBe("failed");
    }));

  it("an unmappable alignment is a recoverable needs-input error, never a stretched guess", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const planned = await approvedLiveRun(store);
      const speech = new MockSpeech();
      speech.synthesize = async (request) => {
        speech.requests.push(request);
        return fakeResponse(alignText(`${request.text} extra`), alignText(`${request.text} extra`));
      };
      const result = await generateRun(generateOptions(dir, store, planned.run, speech));
      expect(result).toMatchObject({ status: "needs-input", stage: "speech", message: expect.stringMatching(/recoverable alignment error/) });
      expect((await loadManifest(store, planned.run))!.state).toBe("needs-input");
    }));
});
