import { VIDEO_FORMAT } from "../contracts";

/**
 * Frame accounting (PIPELINE_DESIGN.md §6 "Scene and frame accounting").
 *
 * - event start = floor(seconds × fps), event end = ceil(seconds × fps)
 * - scene frames = ceil((audioDuration + trailingHold) × fps)
 * - each scene starts at the previous scene's exact end, so rounding never accumulates
 * - holds: 0-500 ms per scene; the final takeaway may hold up to 1 s more (0-1500 ms)
 * - total must be 1,800-2,700 frames (60-90 s at 30 fps), otherwise the plan goes back for adjustment
 *
 * A tiny epsilon absorbs binary floating point noise, e.g. (2.5 + 0.4) × 30 = 86.99999999999999
 * must give 87 frames, not 88.
 */

export const FPS = VIDEO_FORMAT.fps;
export const MIN_TOTAL_FRAMES = 60 * FPS; // 1800
export const MAX_TOTAL_FRAMES = 90 * FPS; // 2700
export const MAX_SCENE_HOLD_MS = 500;
export const MAX_TAKEAWAY_EXTRA_HOLD_MS = 1000;
export const MAX_TAKEAWAY_HOLD_MS = MAX_SCENE_HOLD_MS + MAX_TAKEAWAY_EXTRA_HOLD_MS;

const EPSILON = 1e-6;

export function startFrameOf(seconds: number, fps: number = FPS): number {
  return Math.floor(seconds * fps + EPSILON);
}

export function endFrameOf(seconds: number, fps: number = FPS): number {
  return Math.ceil(seconds * fps - EPSILON);
}

export function sceneFrames(audioDurationSeconds: number, holdMs: number, fps: number = FPS): number {
  return endFrameOf(audioDurationSeconds + holdMs / 1000, fps);
}

/** Lay scenes end to end. Returns each scene's start frame and the total. */
export function placeScenes(durations: readonly number[]): { starts: number[]; totalFrames: number } {
  const starts: number[] = [];
  let cursor = 0;
  for (const duration of durations) {
    starts.push(cursor);
    cursor += duration;
  }
  return { starts, totalFrames: cursor };
}
