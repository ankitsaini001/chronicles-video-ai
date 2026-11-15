import type React from "react";
import { AbsoluteFill } from "remotion";
import { glide, lerp, wave } from "./motion";

/**
 * A 2D camera over the 1080x1920 stage. The camera looks at world point (x, y) with zoom z and
 * places it at screen point (sx, sy). Moves are keyframes; each starts at `at` and eases in-out
 * over `dur` frames from wherever the camera was, so moves can overlap smoothly.
 */

export interface CamState {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
}

export interface CamMove extends Partial<CamState> {
  at: number;
  dur?: number;
}

/** The resting camera: the middle of the stage band, no zoom. */
export const CAM_HOME: CamState = { x: 540, y: 775, z: 1, sx: 540, sy: 775 };

export function cameraAt(frame: number, moves: readonly CamMove[], start: CamState = CAM_HOME): CamState {
  let state = { ...start };
  for (const m of moves) {
    const t = glide(frame, m.at, m.dur ?? 30);
    if (t <= 0) continue;
    state = {
      x: m.x === undefined ? state.x : lerp(state.x, m.x, t),
      y: m.y === undefined ? state.y : lerp(state.y, m.y, t),
      z: m.z === undefined ? state.z : lerp(state.z, m.z, t),
      sx: m.sx === undefined ? state.sx : lerp(state.sx, m.sx, t),
      sy: m.sy === undefined ? state.sy : lerp(state.sy, m.sy, t),
    };
  }
  return state;
}

/** Adds a slow "handheld" drift so the frame is never perfectly still. */
export function withDrift(cam: CamState, frame: number, amount = 1): CamState {
  return { ...cam, sx: cam.sx + wave(frame, 210) * 6 * amount, sy: cam.sy + wave(frame, 170, 0.5) * 5 * amount, z: cam.z * (1 + wave(frame, 260, 0.3) * 0.006 * amount) };
}

export const cameraTransform = (cam: CamState) => `translate(${cam.sx - cam.x * cam.z}px, ${cam.sy - cam.y * cam.z}px) scale(${cam.z})`;

export const CameraView: React.FC<{ cam: CamState; children: React.ReactNode }> = ({ cam, children }) => (
  <AbsoluteFill style={{ transformOrigin: "0 0", transform: cameraTransform(cam) }}>{children}</AbsoluteFill>
);
