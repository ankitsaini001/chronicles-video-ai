import type React from "react";
import { AbsoluteFill } from "remotion";
import { seeded, wave } from "./motion";
import { C, LAYOUT } from "./theme";

/**
 * The dark stage behind every scene: a warm black gradient with an amber glow and a vignette (one
 * element, plain CSS gradients, the same on every frame), plus a few drifting light motes. Kept
 * cheap on purpose: no blur filters, few particles, and a still background (a glow that moved or
 * pulsed changed every pixel of every frame: about 10% bigger files, F22b measurements).
 */

interface Mote {
  x: number;
  y: number;
  r: number;
  speed: number;
  phase: number;
  twinkle: number;
}

function makeMotes(seed: number, count: number, rMin: number, rMax: number): Mote[] {
  const rnd = seeded(seed);
  return Array.from({ length: count }, () => ({
    x: rnd() * LAYOUT.width,
    y: rnd() * LAYOUT.height,
    r: rMin + rnd() * (rMax - rMin),
    speed: 0.15 + rnd() * 0.5,
    phase: rnd() * 10,
    twinkle: 40 + rnd() * 80,
  }));
}

const wrap = (v: number, max: number) => ((v % max) + max) % max;
const FAR = makeMotes(11, 18, 1, 2.2);
const MID = makeMotes(23, 6, 2.5, 3.6);

const BACKGROUND = [
  "radial-gradient(120% 80% at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%)",
  "radial-gradient(48% 34% at 62% 38%, rgba(245,165,36,0.2), transparent 72%)",
  `linear-gradient(180deg, #120C08 0%, ${C.bg} 45%, ${C.bgDeep} 100%)`,
].join(", ");

export const Backdrop: React.FC<{ frame: number }> = ({ frame }) => {
  const layer = (motes: Mote[], drift: number, fill: string, dust: boolean) =>
    motes.map((m, i) => {
      const x = wrap(m.x + wave(frame, 180 + i * 7, m.phase) * 14, LAYOUT.width + 80) - 40;
      const y = wrap(m.y - frame * m.speed * drift, LAYOUT.height + 80) - 40;
      const a = 0.35 + 0.65 * (0.5 + 0.5 * wave(frame, m.twinkle, m.phase));
      return <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r={dust ? m.r : m.r * 2.4} fill={fill} opacity={(dust ? 0.55 * a : a).toFixed(2)} />;
    });
  return (
    <AbsoluteFill style={{ background: BACKGROUND }}>
      <svg width={LAYOUT.width} height={LAYOUT.height} style={{ position: "absolute", inset: 0 }}>
        <defs>
          <radialGradient id="bd-mote">
            <stop offset="0%" stopColor="#FFC766" stopOpacity={0.95} />
            <stop offset="45%" stopColor="#F5A524" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#F5A524" stopOpacity={0} />
          </radialGradient>
        </defs>
        {layer(FAR, 0.3, "#FFE2A8", true)}
        {layer(MID, 1, "url(#bd-mote)", false)}
      </svg>
    </AbsoluteFill>
  );
};
