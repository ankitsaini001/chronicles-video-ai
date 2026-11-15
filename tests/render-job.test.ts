import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeElevenLabsSpeech, silentMp3 } from "../apps/web/lib/video/fake-elevenlabs";
import { ensureProjectTmp, isInside, projectRoot } from "../apps/web/lib/video/render-process";
import { fakeVoiceProblem, voiceEstimatorFor, voiceSetupFromEnv, VoiceNotConfiguredError } from "../apps/web/lib/video/voice";
import type { Plan } from "../packages/pipeline/src/contracts";
import { hashPlan } from "../packages/pipeline/src/planning";
import type { RenderJob, RenderReport } from "../packages/pipeline/src/pipeline/render";
import { durationMessage, runRenderJob } from "../packages/pipeline/src/pipeline/render-job";
import { THUMBNAIL_SECONDS, type RenderJobSpec } from "../packages/pipeline/src/pipeline/render-protocol";
import { cacheRecordFor, speechCacheKey, speechConfigFor, speechRequestFor } from "../packages/pipeline/src/pipeline/speech";
import { DurationOutOfRangeError } from "../packages/pipeline/src/timing";
import type { Mp4Probe } from "../packages/pipeline/src/validation";
import { validPlan, withTempDir } from "./helpers";

// F23: the render job the generate worker runs in its child process (packages/pipeline/src/pipeline/
// render-job.ts), the stand-in voice used by the e2e check, and the temp-folder guard. No network,
// no Remotion (the renderer and the probes are fakes here; the e2e check renders for real).

const ROOT = path.resolve(import.meta.dirname, "..");

const goodProbe = (frames: number): Mp4Probe => ({
  codec: "h264",
  width: 1080,
  height: 1920,
  frameRate: "30/1",
  decodedFrames: frames,
  durationSeconds: frames / 30,
  pixelFormat: "yuv420p",
  audioStreams: 1,
  audioCodec: "aac",
  audioDurationSeconds: frames / 30,
  audioSampleRate: 48000,
});

/** Narration for every scene from the stand-in voice, written into `dir` like the worker does. */
async function narrated(plan: Plan, dir: string) {
  const config = speechConfigFor(plan, "e2eStandInFemale", "e2e_stand_in");
  const fake = new FakeElevenLabsSpeech("en");
  const scenes: RenderJobSpec["scenes"] = [];
  const seconds: Record<string, number> = {};
  for (const [i, scene] of plan.scenes.entries()) {
    const request = speechRequestFor(plan, i, config);
    const response = await fake.synthesize(request);
    const audioFile = path.join(dir, `${scene.id}.mp3`);
    await writeFile(audioFile, response.audio);
    scenes.push({ sceneId: scene.id, audioFile, record: cacheRecordFor(speechCacheKey(scene, config), request, response, new Date()) });
    seconds[audioFile] = response.audio.byteLength / 417 * (1152 / 44100);
  }
  return { config, scenes, probeAudio: async (file: string) => ({ codec: "mp3", sampleRate: 44100, channels: 1, decodedSeconds: seconds[file]! }) };
}

function fakeRender(seen: RenderJob[]) {
  return async (job: RenderJob): Promise<RenderReport> => {
    seen.push(job);
    await writeFile(job.outputPath, "mp4 bytes");
    if (job.thumbnail) await writeFile(job.thumbnail.outputPath, "jpeg bytes");
    job.onFrameProgress?.(0.5);
    job.onFrameProgress?.(1);
    return { musicMs: 0, bundleMs: 1, renderMs: 2, stillsMs: 0, previews: [], thumbnailPath: job.thumbnail?.outputPath ?? null };
  };
}

describe("render job (Timing animations → Adding captions → Rendering → Checking)", () => {
  it("renders the v4 video with the music bed and a thumbnail at 1.5 s, all inside the work folder", async () => {
    await withTempDir(async (dir) => {
      const plan = validPlan();
      const { config, scenes, probeAudio } = await narrated(plan, dir);
      const seen: RenderJob[] = [];
      const phases: string[] = [];
      const workDir = path.join(dir, "work");
      const result = await runRenderJob(
        { workDir, plan, planHash: hashPlan(plan), speechConfig: config, scenes, music: true, thumbnailSeconds: THUMBNAIL_SECONDS },
        { render: fakeRender(seen), probeAudio, probe: async () => goodProbe(seen[0]!.timeline.totalFrames), onProgress: (p, pct) => phases.push(`${p}:${pct}`) },
      );
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      const job = seen[0]!;
      expect(job.music).toBe(true);
      expect(job.thumbnail?.frame).toBe(45);
      expect(isInside(dir, job.workDir) && isInside(dir, job.publicDir!) && isInside(dir, result.files.video)).toBe(true);
      expect(job.timeline.schemaVersion).toBe(2);
      expect(job.captions.schemaVersion).toBe(2);
      expect(result.qa.ok).toBe(true);
      expect(result.frames).toBe(job.timeline.totalFrames);
      expect(JSON.parse(await readFile(result.files.timeline, "utf8")).totalFrames).toBe(job.timeline.totalFrames);
      // Every scene's narration is served from the public folder at audio/<scene id>.mp3.
      for (const scene of job.timeline.scenes) expect(scene.audioKey).toBe(`audio/${scene.sceneId}.mp3`);
      expect(phases[0]).toBe("timing:0");
      expect(phases).toContain("captions:100");
      expect(phases).toContain("rendering:50");
      expect(phases.at(-1)).toBe("checking:100");
    });
  });

  it("a video that fails the MP4 checks is a failure, never ready", async () => {
    await withTempDir(async (dir) => {
      const plan = validPlan();
      const { config, scenes, probeAudio } = await narrated(plan, dir);
      const seen: RenderJob[] = [];
      const result = await runRenderJob(
        { workDir: path.join(dir, "w"), plan, planHash: hashPlan(plan), speechConfig: config, scenes, music: true, thumbnailSeconds: 1.5 },
        { render: fakeRender(seen), probeAudio, probe: async () => goodProbe(10) },
      );
      expect(result).toMatchObject({ status: "failed", stage: "validate" });
    });
  });

  it("words that can't be timed come back as needs_input for that scene (no guessing)", async () => {
    await withTempDir(async (dir) => {
      const plan = validPlan();
      const { config, scenes, probeAudio } = await narrated(plan, dir);
      // The recording of scene 2 says something else than the plan: the alignment doesn't spell its text.
      const other = await new FakeElevenLabsSpeech("en").synthesize({ ...speechRequestFor(plan, 1, config), text: "Completely different words here." });
      scenes[1] = { ...scenes[1]!, record: { ...scenes[1]!.record, alignment: other.alignment, normalizedAlignment: null } };
      const result = await runRenderJob({ workDir: path.join(dir, "w"), plan, planHash: hashPlan(plan), speechConfig: config, scenes, music: false, thumbnailSeconds: 1.5 }, { render: fakeRender([]), probeAudio });
      expect(result).toMatchObject({ status: "needs_input", reason: "alignment_uncertain", sceneId: plan.scenes[1]!.id, message: "Please adjust the wording in scene 2." });
    });
  });

  it("a video outside 60–90 s comes back as needs_input with a plain message", async () => {
    await withTempDir(async (dir) => {
      const plan = validPlan();
      const { config, scenes } = await narrated(plan, dir);
      // Every clip 30 s long: far over 90 s in total.
      const result = await runRenderJob(
        { workDir: path.join(dir, "w"), plan, planHash: hashPlan(plan), speechConfig: config, scenes, music: false, thumbnailSeconds: 1.5 },
        { render: fakeRender([]), probeAudio: async () => ({ codec: "mp3", sampleRate: 44100, channels: 1, decodedSeconds: 30 }) },
      );
      expect(result.status).toBe("needs_input");
      if (result.status !== "needs_input") return;
      expect(result.reason).toBe("duration_out_of_range");
      expect(result.message).toMatch(/^Your narration runs about \d+ seconds; videos must be 60–90 s\. Try asking: "make it shorter"\.$/);
      expect(durationMessage(new DurationOutOfRangeError(1500, 1800, 2700, 30))).toContain('"explain a bit more"');
    });
  });

  it("a render error after Cancel is reported as cancelled", async () => {
    await withTempDir(async (dir) => {
      const plan = validPlan();
      const { config, scenes, probeAudio } = await narrated(plan, dir);
      let cancelled = false;
      const result = await runRenderJob(
        { workDir: path.join(dir, "w"), plan, planHash: hashPlan(plan), speechConfig: config, scenes, music: false, thumbnailSeconds: 1.5 },
        {
          probeAudio,
          isCancelled: () => cancelled,
          render: async () => {
            cancelled = true;
            throw new Error("renderMedia() got cancelled");
          },
        },
      );
      expect(result).toEqual({ status: "cancelled" });
    });
  });
});

describe("stand-in voice (E2E only, zero ElevenLabs calls)", () => {
  it("makes silent MP3 frames of the asked length and timings for exactly the text sent", async () => {
    const audio = silentMp3(5);
    expect(audio.byteLength % 417).toBe(0);
    expect(audio[0]).toBe(0xff);
    const response = await new FakeElevenLabsSpeech("en").synthesize({ voiceId: "x", modelId: "m", text: "Water rises, cools and falls.", previousText: null, nextText: null, settings: {} as never, outputFormat: "mp3_44100_128", seed: 1, applyTextNormalization: "auto" });
    expect(response.alignment!.characters.join("")).toBe("Water rises, cools and falls.");
    const seconds = (response.audio.byteLength / 417) * (1152 / 44100);
    expect(seconds).toBeGreaterThanOrEqual(response.alignment!.character_end_times_seconds.at(-1)!);
    expect(response.characterCost).toBe(29);
  });

  it("'e2e voice busy' fails as busy three calls in a row (two quick retries counted first), then works", async () => {
    const fake = new FakeElevenLabsSpeech("en");
    const request = { voiceId: "x", modelId: "m", text: `Unique ${Math.random()} e2e voice busy.`, previousText: null, nextText: null, settings: {} as never, outputFormat: "mp3_44100_128", seed: 1, applyTextNormalization: "auto" as const };
    const attempts: number[] = [];
    await expect(fake.synthesize(request, { beforeAttempt: (n) => void attempts.push(n) })).rejects.toMatchObject({ kind: "transient" });
    expect(attempts).toEqual([1, 2, 3]);
    await expect(fake.synthesize(request)).resolves.toMatchObject({ retries: 0 });
  });

  it("is allowed only on the test database and a local test port, never on Vercel", () => {
    const ok = { E2E_FAKE_ELEVENLABS: "1", MONGODB_DB: "bytereel_test", BETTER_AUTH_URL: "http://localhost:3232" };
    expect(fakeVoiceProblem(ok)).toBeNull();
    expect(fakeVoiceProblem({})).toBeNull();
    expect(fakeVoiceProblem({ ...ok, MONGODB_DB: "bytereel" })).toMatch(/only allowed with MONGODB_DB=bytereel_test/);
    expect(fakeVoiceProblem({ ...ok, BETTER_AUTH_URL: "http://localhost:3000" })).toMatch(/local test server/);
    expect(fakeVoiceProblem({ ...ok, VERCEL: "1" })).toMatch(/Vercel/);
    expect(fakeVoiceProblem({ ...ok, E2E_FAKE_ELEVENLABS: "yes" })).toMatch(/must be "1"/);
    expect(voiceSetupFromEnv({ ...ok, MONGODB_DB: "bytereel" })).toMatchObject({ ok: false });
  });

  it("the REAL voice is refused on the test database (a test can never spend real characters)", () => {
    const setup = voiceSetupFromEnv({ MONGODB_DB: "bytereel_test", ELEVENLABS_API_KEY: "k".repeat(40), ELEVENLABS_MODEL: "eleven_multilingual_v2" });
    expect(setup).toMatchObject({ ok: false });
    if (!setup.ok) expect(setup.problem).toMatch(/stand-in voice/);
  });

  it("the real voice: the plan's preset voice from the environment, never a fallback", () => {
    const env = { MONGODB_DB: "bytereel", ELEVENLABS_API_KEY: "k".repeat(40), ELEVENLABS_MODEL: "eleven_multilingual_v2", ELEVENLABS_VOICE_ID_INDIAN_FEMALE: "AbCdEf0123456789wxyz" };
    const setup = voiceSetupFromEnv(env);
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    const plan = validPlan();
    expect(setup.configFor({ ...plan, voicePreset: "indian-english-female" }).voiceId).toBe("AbCdEf0123456789wxyz");
    expect(() => setup.configFor({ ...plan, voicePreset: "indian-english-male" })).toThrow(VoiceNotConfiguredError);
    expect(voiceSetupFromEnv({ ...env, ELEVENLABS_API_KEY: "" })).toMatchObject({ ok: false });
  });

  it("the voice estimate: one recording per scene with the characters ElevenLabs bills; stand-in keys differ from real ones", () => {
    const plan = validPlan();
    const fake = voiceSetupFromEnv({ E2E_FAKE_ELEVENLABS: "1", MONGODB_DB: "bytereel_test", BETTER_AUTH_URL: "http://localhost:3232" });
    const real = voiceSetupFromEnv({ MONGODB_DB: "bytereel", ELEVENLABS_API_KEY: "k".repeat(40), ELEVENLABS_MODEL: "eleven_multilingual_v2", ELEVENLABS_VOICE_ID_INDIAN_FEMALE: "AbCdEf0123456789wxyz" });
    if (!fake.ok || !real.ok) throw new Error("setup");
    const stored = { ...plan, voicePreset: "indian-english-female" } as never;
    const a = voiceEstimatorFor(fake)(stored);
    const b = voiceEstimatorFor(real)(stored);
    expect(a).toHaveLength(plan.scenes.length);
    expect(a.every((s) => /^sha256:[0-9a-f]{64}$/.test(s.cacheKey) && s.characters > 0)).toBe(true);
    expect(a.map((s) => s.characters)).toEqual(b.map((s) => s.characters));
    expect(a.some((s, i) => s.cacheKey === b[i]!.cacheKey)).toBe(false);
  });
});

describe("temporary files stay inside the project (F22b MUST)", () => {
  it("finds the project root and checks folders are inside it", () => {
    expect(projectRoot(path.join(ROOT, "apps", "web"))).toBe(ROOT);
    expect(isInside(ROOT, path.join(ROOT, "runs", ".tmp"))).toBe(true);
    expect(isInside(ROOT, "/tmp")).toBe(false);
    expect(isInside(ROOT, ROOT)).toBe(false);
    expect(isInside(ROOT, path.join(ROOT, "..", "elsewhere"))).toBe(false);
  });

  it("sets TMPDIR to <project>/runs/.tmp when it points outside the project (and leaves a good one alone)", () => {
    const saved = process.env.TMPDIR;
    try {
      const env: NodeJS.ProcessEnv = { TMPDIR: "/tmp" };
      process.env.TMPDIR = "/tmp";
      const outside = ensureProjectTmp(ROOT, env);
      expect(outside).toEqual({ tmp: path.join(ROOT, "runs", ".tmp"), changed: true });
      expect(env.TMPDIR).toBe(path.join(ROOT, "runs", ".tmp"));
      process.env.TMPDIR = path.join(ROOT, "runs", ".tmp");
      expect(ensureProjectTmp(ROOT, {}).changed).toBe(false);
    } finally {
      process.env.TMPDIR = saved;
    }
  });
});
