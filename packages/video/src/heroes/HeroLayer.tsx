import type React from "react";
import type { HeroStep } from "@bytereel/pipeline/contracts";
import { heroDef } from "@bytereel/pipeline/planning/hero-catalog";
import { LiveIcon } from "../icons/LiveIcon";
import { clamp01, kickOf, pop, rise, wave } from "../motion";
import { HERO_ART } from "./index";
import { Glow, HeroDefs, type HeroProps } from "./kit";

/**
 * The hero layer (F22b): the scene's current hero object, big and centred at (cx, cy), gently
 * floating. A new object pops in while the old one shrinks away; objects of the same family
 * (cloud -> rain cloud) stay in place and morph. A step without a hero shows the scene's icon large
 * in a glowing medallion, so the screen is never empty.
 */

export type HeroCues = ReadonlyMap<string, { frame: number; word: string }[]>;

/** Frames before a scene's start at which its first hero is already drawn (transition overlap). */
export const HERO_LEAD = 14;

const keyOf = (step: HeroStep) => step.hero ?? `icon:${step.icon}`;
const familyOf = (step: HeroStep) => (step.hero ? heroDef(step.hero).family : `icon:${step.icon}`);

/** The step on screen at `frame` and the one before it. */
export function heroAt(steps: readonly HeroStep[], frame: number): { current: HeroStep | null; previous: HeroStep | null; index: number } {
  let index = -1;
  steps.forEach((s, i) => {
    if (i === 0 ? frame >= s.startFrame - HERO_LEAD : frame >= s.startFrame) index = i;
  });
  return { current: steps[index] ?? null, previous: steps[index - 1] ?? null, index };
}

/** One hero object drawn at `size` px (square). */
export const HeroSvg: React.FC<{ step: HeroStep; size: number } & HeroProps> = ({ step, size, ...props }) => {
  const art = step.hero ? HERO_ART[step.hero] : null;
  return (
    <svg width={size} height={size} viewBox="-300 -300 600 600" style={{ overflow: "visible", display: "block" }}>
      <HeroDefs />
      {art ? (
        <g transform={art.scale ? `scale(${art.scale})` : undefined}>
          <art.Draw {...props} />
        </g>
      ) : (
        <Medallion {...props} />
      )}
    </svg>
  );
};

/** The fallback hero: a glowing medallion ring (the scene icon is drawn on top in HTML). */
const Medallion: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 30);
  return (
    <g>
      <Glow r={330} opacity={0.55 + 0.25 * kick} />
      <circle r={215} fill="#120C07" />
      <circle r={215} fill="url(#h-glow-amber)" opacity={0.35} />
      <circle r={215} fill="none" stroke="#F5A524" strokeWidth={26} strokeOpacity={0.16} />
      <circle r={215} fill="none" stroke="#F5A524" strokeWidth={7} />
      <circle r={180} fill="none" stroke="#F5B65A" strokeWidth={2} strokeOpacity={0.45} strokeDasharray="4 14" transform={`rotate(${frame * 0.4})`} />
    </g>
  );
};

export const HeroLayer: React.FC<{ steps: readonly HeroStep[]; cues: HeroCues; frame: number; cx: number; cy: number; size: number; opacity?: number }> = ({
  steps,
  cues,
  frame,
  cx,
  cy,
  size,
  opacity = 1,
}) => {
  const { current, previous } = heroAt(steps, frame);
  if (!current) return null;
  const sameFamily = !!previous && familyOf(previous) === familyOf(current);
  const out = previous && !sameFamily ? rise(frame, current.startFrame, 12) : 1;
  // a family's first step keeps the entrance pop when objects morph
  let enterFrame = current.startFrame - (current === steps[0] ? HERO_LEAD : 0);
  if (sameFamily) {
    for (const s of steps) if (s.startFrame <= frame && familyOf(s) === familyOf(current)) enterFrame = Math.min(enterFrame, s.startFrame);
  }
  const draw = (step: HeroStep, t: number, leaving: boolean) => {
    const cueList = cues.get(keyOf(step)) ?? [];
    const since = step.startFrame;
    const float = wave(frame, 140, since * 0.01) * 10;
    const sway = wave(frame, 200, 0.3) * 1.5;
    const breathe = 1 + 0.015 * wave(frame, 90);
    const scale = leaving ? 1 - 0.25 * t : (0.72 + 0.28 * Math.min(1.04, t)) * breathe;
    const cueFrames = cueList.map((c) => c.frame);
    return (
      <div
        key={`${keyOf(step)}-${since}`}
        style={{
          position: "absolute",
          left: cx - size / 2,
          top: cy - size / 2 + float + (leaving ? -30 * t : 0),
          width: size,
          height: size,
          opacity: leaving ? 1 - t : clamp01(t * 1.6),
          transform: `scale(${scale.toFixed(4)}) rotate(${sway.toFixed(3)}deg)`,
        }}
      >
        <HeroSvg step={step} size={size} frame={frame} cues={cueFrames} cueWords={cueList} since={since} />
        {!step.hero && (
          <div style={{ position: "absolute", left: size * 0.25, top: size * 0.25, width: size * 0.5, height: size * 0.5 }}>
            <LiveIcon name={step.icon} size={size * 0.5} frame={frame} cues={cueFrames} />
          </div>
        )}
      </div>
    );
  };
  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      {previous && !sameFamily && out < 1 && draw(previous, out, true)}
      {draw(current, pop(frame, sameFamily ? enterFrame : current.startFrame - (current === steps[0] ? HERO_LEAD : 0), 170, 14), false)}
    </div>
  );
};
