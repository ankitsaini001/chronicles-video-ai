import type React from "react";
import { Easing, interpolate } from "remotion";
import type { TimelineEvent, TimelineObject, TimelineScene } from "../../packages/pipeline/src/contracts";
import { MOTION } from "../../packages/pipeline/src/theme";

/**
 * Frame-driven animation helpers. Everything is a pure function of the absolute frame and the
 * compiled timeline: no clocks, no Math.random, so every render of the same timeline is identical.
 */

const easeOut = Easing.out(Easing.cubic);

/** 0 -> 1 between `start` and `start + duration`, eased, clamped. */
export function ramp(frame: number, start: number, duration: number): number {
  if (duration <= 0) return frame >= start ? 1 : 0;
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });
}

/** Linear mix between a and b. */
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Deterministic 32-bit hash of a string (FNV-1a), used to seed per-object variation. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Seeded pseudo-random generator (mulberry32). Same seed -> same sequence, every render. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What a pattern component needs to know about one scene at one frame.
 * Frames are absolute (the same numbers as timeline.json).
 */
export interface SceneClock {
  frame: number;
  scene: TimelineScene;
  objects: TimelineObject[];
  objectsOfKind(kind: string): TimelineObject[];
  /** 0..1 entrance progress. */
  reveal(id: string): number;
  /** 0..1 progress of the first `action` event on `id` (0 if there is none or it has not started). */
  action(id: string, action: string): number;
  /** true if an `action` event on `id` exists. */
  has(id: string, action: string): boolean;
  /** 0..1 while a highlight / point-to is active (eases in, holds, eases out). */
  highlight(id: string): number;
  /** 0..1..0 bump during a pulse event. */
  pulse(id: string): number;
  /** max(highlight, pulse): a single "look here" value. */
  emphasis(id: string): number;
}

export function makeSceneClock(scene: TimelineScene, frame: number): SceneClock {
  const eventsFor = (id: string, action?: string): TimelineEvent[] =>
    scene.events.filter((e) => e.target === id && (action === undefined || e.action === action));
  const objectById = new Map(scene.objects.map((o) => [o.id, o]));

  const highlight = (id: string) => {
    let value = 0;
    for (const e of eventsFor(id)) {
      if (e.action !== "highlight" && e.action !== "point-to") continue;
      const holdUntil = Math.max(e.endFrame, e.startFrame + MOTION.highlightHold);
      const fadeIn = ramp(frame, e.startFrame, MOTION.highlightIn);
      const fadeOut = 1 - ramp(frame, holdUntil, 15);
      value = Math.max(value, Math.min(fadeIn, fadeOut));
    }
    return value;
  };
  const pulse = (id: string) => {
    let value = 0;
    for (const e of eventsFor(id, "pulse")) {
      const t = (frame - e.startFrame) / MOTION.pulse;
      if (t >= 0 && t <= 1) value = Math.max(value, Math.sin(Math.PI * t));
    }
    return value;
  };

  return {
    frame,
    scene,
    objects: scene.objects,
    objectsOfKind: (kind) => scene.objects.filter((o) => o.kind === kind),
    reveal: (id) => {
      const object = objectById.get(id);
      return object ? ramp(frame, object.revealFrame, MOTION.reveal) : 0;
    },
    action: (id, action) => {
      const event = eventsFor(id, action)[0];
      if (!event) return 0;
      return ramp(frame, event.startFrame, Math.max(event.endFrame - event.startFrame, MOTION.draw));
    },
    has: (id, action) => eventsFor(id, action).length > 0,
    highlight,
    pulse,
    emphasis: (id) => Math.max(highlight(id), pulse(id)),
  };
}

/** Standard entrance: fade in and slide up by `distance` px. */
export function entranceStyle(progress: number, distance = 36): React.CSSProperties {
  return { opacity: progress, transform: `translateY(${(1 - progress) * distance}px)` };
}
