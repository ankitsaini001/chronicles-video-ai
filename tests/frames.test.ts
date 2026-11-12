import { describe, expect, it } from "vitest";
import { hashPlan } from "../packages/pipeline/src/planning";
import {
  compileTimeline,
  DurationOutOfRangeError,
  CompileInputError,
  endFrameOf,
  placeScenes,
  sceneFrames,
  startFrameOf,
  synthesizeSceneAlignment,
  DEFAULT_SYNTHETIC_TIMING,
  type SyntheticTimingOptions,
} from "../packages/pipeline/src/timing";
import { validPlan } from "./helpers";

function compileWith(timing: SyntheticTimingOptions = DEFAULT_SYNTHETIC_TIMING, holds?: { sceneHoldMs: number; takeawayHoldMs: number }) {
  const plan = validPlan();
  const alignments = Object.fromEntries(plan.scenes.map((s) => [s.id, synthesizeSceneAlignment(s, plan.language, timing)]));
  return compileTimeline({ plan, planHash: hashPlan(plan), alignments, ...(holds ? { holds } : {}) });
}

describe("frame accounting", () => {
  it("uses floor for starts and ceil for ends", () => {
    expect(startFrameOf(1.0)).toBe(30);
    expect(startFrameOf(1.01)).toBe(30);
    expect(startFrameOf(1.0333)).toBe(30);
    expect(endFrameOf(1.0)).toBe(30);
    expect(endFrameOf(1.01)).toBe(31);
    expect(endFrameOf(0.001)).toBe(1);
  });

  it("is not fooled by floating point noise", () => {
    // (2.5 + 0.4) * 30 = 86.99999999999999 in binary floating point
    expect(sceneFrames(2.5, 400)).toBe(87);
    expect(startFrameOf(0.1 + 0.2)).toBe(9); // 0.30000000000000004 s
    expect(endFrameOf(0.7 * 3)).toBe(63); // 2.0999999999999996 s
  });

  it("allocates ceil((audio + hold) * fps) frames per scene", () => {
    expect(sceneFrames(10.0, 0)).toBe(300);
    expect(sceneFrames(10.01, 0)).toBe(301);
    expect(sceneFrames(10.0, 500)).toBe(315);
    expect(sceneFrames(12.154, 400)).toBe(377); // (12.154 + 0.4) * 30 = 376.62
  });

  it("places each scene at the previous scene's exact end (no drift)", () => {
    const durations = [377, 395, 410, 535, 448, 438];
    const { starts, totalFrames } = placeScenes(durations);
    expect(starts).toEqual([0, 377, 772, 1182, 1717, 2165]);
    expect(totalFrames).toBe(durations.reduce((a, b) => a + b, 0));
  });

  it("rounds per scene, so many tiny remainders never accumulate", () => {
    // 20 scenes of 3.01 s: each rounds up to 91 frames; total is exactly 20 * 91, starts are contiguous.
    const durations = Array.from({ length: 20 }, () => sceneFrames(3.01, 0));
    const { starts, totalFrames } = placeScenes(durations);
    expect(totalFrames).toBe(1820);
    starts.forEach((start, i) => expect(start).toBe(i * 91));
  });

  it("compiles the fixture into contiguous scenes inside 1,800-2,700 frames", () => {
    const { timeline } = compileWith();
    expect(timeline.totalFrames).toBeGreaterThanOrEqual(1800);
    expect(timeline.totalFrames).toBeLessThanOrEqual(2700);
    let cursor = 0;
    for (const scene of timeline.scenes) {
      expect(scene.startFrame).toBe(cursor);
      expect(scene.durationFrames).toBe(sceneFrames(scene.audioDurationSeconds, scene.holdMs));
      cursor += scene.durationFrames;
      for (const event of scene.events) {
        expect(event.endFrame).toBeGreaterThan(event.startFrame);
        expect(event.startFrame).toBeGreaterThanOrEqual(scene.startFrame);
        expect(event.endFrame).toBeLessThanOrEqual(scene.startFrame + scene.durationFrames);
      }
    }
    expect(cursor).toBe(timeline.totalFrames);
    expect(timeline.scenes.at(-1)!.holdMs).toBe(1200);
    expect(timeline.scenes[0]!.holdMs).toBe(400);
  });

  it("fails with 'return for plan adjustment' when too long, and never pads when too short", () => {
    const slow = { ...DEFAULT_SYNTHETIC_TIMING, wordsPerSecond: 2.0 };
    expect(() => compileWith(slow)).toThrow(DurationOutOfRangeError);
    expect(() => compileWith(slow)).toThrow(/too long.*Return the plan for adjustment/);
    const fast = { ...DEFAULT_SYNTHETIC_TIMING, wordsPerSecond: 4.5 };
    expect(() => compileWith(fast)).toThrow(/too short.*no filler/);
  });

  it("rejects holds outside 0-500 ms per scene and 0-1500 ms for the takeaway", () => {
    expect(() => compileWith(undefined, { sceneHoldMs: 501, takeawayHoldMs: 1000 })).toThrow(CompileInputError);
    expect(() => compileWith(undefined, { sceneHoldMs: 0, takeawayHoldMs: 1501 })).toThrow(CompileInputError);
    expect(() => compileWith(undefined, { sceneHoldMs: -1, takeawayHoldMs: 0 })).toThrow(CompileInputError);
    expect(() => compileWith(undefined, { sceneHoldMs: 500, takeawayHoldMs: 1500 })).not.toThrow();
  });
});
