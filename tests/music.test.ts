import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MUSIC_FILE, MUSIC_SAMPLE_RATE, musicInputFor, synthMusicBed } from "../packages/pipeline/src/pipeline/music";
import { hashPlan } from "../packages/pipeline/src/planning";
import { sha256 } from "../packages/pipeline/src/shared/hash";
import { MUSIC_FILE as THEME_MUSIC_FILE } from "../packages/pipeline/src/theme";
import { compileTimeline, synthesizeSceneAlignment } from "../packages/pipeline/src/timing";
import { validPlan } from "./helpers";

function input() {
  const plan = validPlan();
  const alignments = Object.fromEntries(plan.scenes.map((s) => [s.id, synthesizeSceneAlignment(s, plan.language)]));
  const { timeline, captions } = compileTimeline({ plan, planHash: hashPlan(plan), alignments });
  return { timeline, music: musicInputFor(timeline, captions) };
}

/** A short bed (6.5 s) keeps the test fast; the synthesis is the same for any length. */
const SHORT = { durationSeconds: 6.5, speech: [[0.4, 2.2], [2.9, 5.6]] as [number, number][], impacts: [0], whooshes: [3], chimes: [4.2], fadeOutAt: 6 };

describe("music bed (F22b)", () => {
  it("gives the same bytes for the same input (free, deterministic)", () => {
    expect(sha256(synthMusicBed(SHORT))).toBe(sha256(synthMusicBed({ ...SHORT, speech: SHORT.speech.map((s) => [...s] as [number, number]) })));
    expect(sha256(synthMusicBed(SHORT))).not.toBe(sha256(synthMusicBed({ ...SHORT, chimes: [] })));
  });

  it("is a 48 kHz stereo 16-bit WAV whose length follows the video (one stereo sample per 1/48000 s)", () => {
    const { timeline, music } = input();
    expect(music.durationSeconds).toBe(timeline.totalFrames / timeline.fps);
    const wav = synthMusicBed({ ...SHORT, durationSeconds: music.durationSeconds / 10 });
    const samples = Math.ceil((music.durationSeconds / 10) * MUSIC_SAMPLE_RATE);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(2); // stereo
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(samples * 4);
    expect(wav.length).toBe(44 + samples * 4);
    // the sound effects: an impact on frame 0, a whoosh at every scene change
    expect(music.impacts).toEqual([0]);
    expect(music.whooshes).toEqual(timeline.scenes.slice(1).map((s) => s.startFrame / timeline.fps));
  });

  it("the render stage and the composition use one file name", () => {
    expect(MUSIC_FILE).toBe("music-bed.wav");
    expect(MUSIC_FILE).toBe(THEME_MUSIC_FILE);
    // packages/video/src/Explainer.tsx plays the shared constant and never spells its own name
    const explainer = readFileSync(path.join(import.meta.dirname, "..", "packages", "video", "src", "Explainer.tsx"), "utf8");
    expect(explainer).toMatch(/import \{[^}]*\bMUSIC_FILE\b[^}]*\} from "@bytereel\/pipeline\/theme"/);
    expect(explainer).not.toContain("music-bed.wav");
  });
});
