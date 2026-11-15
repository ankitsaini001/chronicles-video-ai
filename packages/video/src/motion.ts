import { Easing, interpolate, spring } from "remotion";

/**
 * Frame-pure motion helpers. Everything is a function of the absolute frame, so renders are
 * deterministic (no clocks, no Math.random).
 */

export const FPS = 30;
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const easeOut = Easing.out(Easing.cubic);
const easeInOut = Easing.inOut(Easing.cubic);

/** 0 -> 1 from `start` over `duration` frames (ease-out). */
export function rise(frame: number, start: number, duration = 12, easing: (t: number) => number = easeOut): number {
  // an infinite start means "never" (or "always" for -Infinity); interpolate() rejects it
  if (duration <= 0 || !Number.isFinite(start)) return frame >= start ? 1 : 0;
  return interpolate(frame, [start, start + duration], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing });
}

/** Ease-in-out version of rise (camera moves, morphs). */
export const glide = (frame: number, start: number, duration: number) => rise(frame, start, duration, easeInOut);

/** 1 -> 0 from `start` over `duration` frames. */
export const fall = (frame: number, start: number, duration = 12) => 1 - rise(frame, start, duration);

/** Springy pop 0 -> ~1.1 -> 1 starting at `start` (labels, cards, checks). */
export function pop(frame: number, start: number, stiffness = 180, damping = 12): number {
  if (frame < start) return 0;
  return spring({ frame: frame - start, fps: FPS, config: { stiffness, damping, mass: 0.8 } });
}

/** The standard entrance pop for cards and titles. */
export const popIn = (frame: number, at: number) => pop(frame, at, 200, 15);

/** 0..1..0 bump lasting `duration` frames. */
export function pulse(frame: number, start: number, duration = 20): number {
  const t = (frame - start) / duration;
  return t >= 0 && t <= 1 ? Math.sin(Math.PI * t) : 0;
}

/** Smooth periodic wobble (idle motion). */
export const wave = (frame: number, period: number, phase = 0) => Math.sin(((frame / period) * 2 + phase) * Math.PI);

/** Strength of the most recent cue: 1 right after a cue, fading to 0 over `len` frames. */
export function kickOf(frame: number, cues: readonly number[], len = 26): number {
  let v = 0;
  for (const c of cues) if (frame >= c && frame < c + len) v = Math.max(v, 1 - (frame - c) / len);
  return v;
}

/** Seeded PRNG (mulberry32): same seed, same numbers, every render. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
