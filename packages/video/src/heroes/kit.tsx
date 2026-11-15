import type React from "react";
import { useId, useMemo } from "react";
import { spline, type Pt } from "../geometry";
import { rise, seeded, wave } from "../motion";

/**
 * Hero kit: the shared recipe for hero objects (F22b, video style v4).
 *
 * Every hero draws in a 600 x 600 box centred on 0,0 (keep the object inside about ±260 so it fills
 * the middle of the screen; glows may spill over). Motion is a pure function of `frame`.
 *
 * Look: dark, rich shapes with a warm amber rim light and a soft glow, on the dark stage.
 * Speed: NO SVG or CSS filters (blur, drop-shadow) anywhere: they made the sample render 3x slower.
 * A glow is a circle/ellipse filled with a radial gradient (<Glow>), a neon line is a wide faint
 * stroke under a thin bright one (<Neon>). Gradients live in <HeroDefs> (ids start with "h-").
 */

export interface HeroProps {
  frame: number;
  /** Frames where the narration names this object (words or events): the object "acts" briefly. */
  cues: number[];
  /** The words at those cues (e.g. rain / snow / hail picks what falls). */
  cueWords: { frame: number; word: string }[];
  /** Frame this object became the hero. */
  since: number;
}

export interface HeroArt {
  Draw: React.FC<HeroProps>;
  /** Extra size for objects that look small in their box (default 1). */
  scale?: number;
}

export type GlowColor = "amber" | "gold" | "cyan" | "blue" | "white" | "green" | "red" | "violet";

const GLOW_RGB: Record<GlowColor, string> = {
  amber: "245,165,36",
  gold: "255,210,122",
  cyan: "143,214,255",
  blue: "47,143,216",
  white: "255,255,255",
  green: "120,200,110",
  red: "255,96,96",
  violet: "181,140,255",
};

/** Shared gradients. Include once in every hero <svg> (HeroSvg does it). */
export const HeroDefs: React.FC = () => (
  <defs>
    {(Object.keys(GLOW_RGB) as GlowColor[]).map((c) => (
      <radialGradient key={c} id={`h-glow-${c}`}>
        <stop offset="0%" stopColor={`rgb(${GLOW_RGB[c]})`} stopOpacity={0.7} />
        <stop offset="40%" stopColor={`rgb(${GLOW_RGB[c]})`} stopOpacity={0.28} />
        <stop offset="100%" stopColor={`rgb(${GLOW_RGB[c]})`} stopOpacity={0} />
      </radialGradient>
    ))}
    <radialGradient id="h-sun-core">
      <stop offset="0%" stopColor="#FFFBEA" />
      <stop offset="35%" stopColor="#FFE08A" />
      <stop offset="75%" stopColor="#FFB238" />
      <stop offset="100%" stopColor="#F0861A" />
    </radialGradient>
    <radialGradient id="h-sun-halo">
      <stop offset="0%" stopColor="#FFB238" stopOpacity={0.55} />
      <stop offset="45%" stopColor="#F5A524" stopOpacity={0.18} />
      <stop offset="100%" stopColor="#F5A524" stopOpacity={0} />
    </radialGradient>
    <linearGradient id="h-ray" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stopColor="#FFD27A" />
      <stop offset="100%" stopColor="#F08A1A" />
    </linearGradient>
    <radialGradient id="h-amber-dot">
      <stop offset="0%" stopColor="#FFFFFF" />
      <stop offset="30%" stopColor="#FFE2A8" />
      <stop offset="60%" stopColor="#F5A524" stopOpacity={0.6} />
      <stop offset="100%" stopColor="#F5A524" stopOpacity={0} />
    </radialGradient>
    <linearGradient id="h-cloud-light" gradientUnits="userSpaceOnUse" x1="0" y1="-120" x2="0" y2="50">
      <stop offset="0%" stopColor="#FFFFFF" />
      <stop offset="60%" stopColor="#E9E6E1" />
      <stop offset="100%" stopColor="#A9AFBC" />
    </linearGradient>
    <linearGradient id="h-cloud-dark" gradientUnits="userSpaceOnUse" x1="0" y1="-120" x2="0" y2="50">
      <stop offset="0%" stopColor="#9AA5B8" />
      <stop offset="60%" stopColor="#5E687D" />
      <stop offset="100%" stopColor="#353C4C" />
    </linearGradient>
    <radialGradient id="h-globe-ocean" cx="38%" cy="35%" r="75%">
      <stop offset="0%" stopColor="#59B9F0" />
      <stop offset="55%" stopColor="#1A6AA8" />
      <stop offset="100%" stopColor="#082440" />
    </radialGradient>
    <radialGradient id="h-shade" cx="35%" cy="30%" r="80%">
      <stop offset="0%" stopColor="#000" stopOpacity={0} />
      <stop offset="60%" stopColor="#000" stopOpacity={0.15} />
      <stop offset="100%" stopColor="#000" stopOpacity={0.7} />
    </radialGradient>
    <linearGradient id="h-cup" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stopColor="#7A3E14" />
      <stop offset="45%" stopColor="#D9782A" />
      <stop offset="70%" stopColor="#F5A524" />
      <stop offset="100%" stopColor="#8A4616" />
    </linearGradient>
    <linearGradient id="h-dino" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="#7A6250" />
      <stop offset="100%" stopColor="#3A2C22" />
    </linearGradient>
    {/* metals and materials for the object library */}
    <linearGradient id="h-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stopColor="#FFE7A6" />
      <stop offset="45%" stopColor="#F5B33A" />
      <stop offset="100%" stopColor="#B86E12" />
    </linearGradient>
    <linearGradient id="h-steel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stopColor="#E9EEF5" />
      <stop offset="50%" stopColor="#9AA6B8" />
      <stop offset="100%" stopColor="#4E5868" />
    </linearGradient>
    <linearGradient id="h-dark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="#2E2318" />
      <stop offset="100%" stopColor="#120C07" />
    </linearGradient>
    <linearGradient id="h-screen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stopColor="#1B3B5C" />
      <stop offset="100%" stopColor="#0A1626" />
    </linearGradient>
    <linearGradient id="h-glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stopColor="#DDF3FF" stopOpacity={0.45} />
      <stop offset="100%" stopColor="#8FD6FF" stopOpacity={0.12} />
    </linearGradient>
    <linearGradient id="h-water" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="#2C86C9" />
      <stop offset="45%" stopColor="#14507F" />
      <stop offset="100%" stopColor="#071A2C" />
    </linearGradient>
  </defs>
);

/** A soft glow: a circle (or ellipse) filled with a radial gradient. Cheap; use instead of blur. */
export const Glow: React.FC<{ x?: number; y?: number; r: number; ry?: number; color?: GlowColor; opacity?: number }> = ({ x = 0, y = 0, r, ry, color = "amber", opacity = 1 }) =>
  opacity <= 0.001 ? null : <ellipse cx={x} cy={y} rx={r} ry={ry ?? r} fill={`url(#h-glow-${color})`} opacity={opacity} />;

/** A neon line: a wide faint stroke under the bright one. */
export const Neon: React.FC<{ d: string; color?: string; width?: number; opacity?: number; dash?: string; dashOffset?: number; pathLength?: number }> = ({
  d,
  color = "#F5A524",
  width = 8,
  opacity = 1,
  dash,
  dashOffset,
  pathLength,
}) => (
  <g opacity={opacity}>
    <path d={d} fill="none" stroke={color} strokeWidth={width * 3} strokeOpacity={0.18} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} strokeDashoffset={dashOffset} pathLength={pathLength} />
    <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dash} strokeDashoffset={dashOffset} pathLength={pathLength} />
  </g>
);

/** A four-point sparkle. */
export const Sparkle: React.FC<{ x: number; y: number; s?: number; opacity?: number; color?: string; rot?: number }> = ({ x, y, s = 1, opacity = 1, color = "#FFE2A8", rot = 0 }) =>
  opacity <= 0.001 ? null : (
    <g transform={`translate(${x} ${y}) rotate(${rot}) scale(${s})`} opacity={opacity}>
      <circle r={22} fill="url(#h-glow-gold)" />
      <path d="M 0 -30 C 4 -8 8 -4 30 0 C 8 4 4 8 0 30 C -4 8 -8 4 -30 0 C -8 -4 -4 -8 0 -30 Z" fill={color} />
    </g>
  );

// ---------- shared nature pieces (from the approved v4 sample, without filters) ----------

export const Sun: React.FC<{ x: number; y: number; r: number; frame: number; heat?: number }> = ({ x, y, r, frame, heat = 0 }) => {
  const spin = frame * 0.25;
  const breathe = 1 + 0.03 * wave(frame, 60);
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={r * 2.6 * (1 + heat * 0.3)} fill="url(#h-sun-halo)" />
      {heat > 0.01 && <circle r={r * (1.2 + heat * 1.4)} fill="none" stroke="#FFC24A" strokeWidth={6} opacity={0.6 * (1 - heat * 0.6)} />}
      <g transform={`rotate(${spin}) scale(${breathe})`}>
        {Array.from({ length: 14 }, (_, i) => {
          const long = i % 2 === 0;
          const inner = r * 1.12;
          const outer = r * (long ? 1.55 : 1.38) * (1 + heat * 0.25);
          const half = long ? 9 : 6;
          return <polygon key={i} points={`${-half},${-inner} ${half},${-inner} 0,${-outer}`} fill="url(#h-ray)" transform={`rotate(${(i * 360) / 14})`} />;
        })}
      </g>
      <circle r={r * 1.35} fill="url(#h-glow-gold)" opacity={0.8} />
      <circle r={r * (1 + heat * 0.08) * breathe} fill="url(#h-sun-core)" />
    </g>
  );
};

const PUFFS: [number, number, number][] = [
  [-95, 0, 52],
  [-45, -38, 66],
  [28, -55, 80],
  [92, -12, 58],
  [-130, 18, 34],
  [135, 16, 36],
];

/** A puffy cloud. `dark` 0..1 turns it into a heavy rain cloud; `glow` adds a warm rim. */
export const Cloud: React.FC<{ x: number; y: number; s?: number; dark?: number; opacity?: number; glow?: number; frame: number; seed?: number }> = ({
  x,
  y,
  s = 1,
  dark = 0,
  opacity = 1,
  glow = 0.6,
  frame,
  seed = 0,
}) => {
  const bob = wave(frame, 150, seed) * 6;
  const shape = (fill: string, grow = 0) => (
    <>
      {PUFFS.map(([px, py, pr], i) => (
        <circle key={i} cx={px} cy={py + wave(frame, 90 + i * 13, seed + i) * 2.5} r={pr + grow} fill={fill} />
      ))}
      <rect x={-160 - grow} y={-grow} width={320 + 2 * grow} height={52 + 2 * grow} rx={26 + grow} fill={fill} />
    </>
  );
  return (
    <g transform={`translate(${x} ${y + bob}) scale(${s})`} opacity={opacity}>
      {glow > 0 && <Glow y={-10} r={250} ry={160} color={dark > 0.5 ? "cyan" : "gold"} opacity={glow * 0.6 * (1 - dark * 0.5)} />}
      {glow > 0 && <g opacity={glow * 0.14 * (1 - dark * 0.5)} transform="translate(0 -5)">{shape(dark > 0.5 ? "#9AB4D6" : "#FFE7C2", 14)}</g>}
      {glow > 0 && <g opacity={glow * 0.22 * (1 - dark * 0.5)} transform="translate(0 -4)">{shape(dark > 0.5 ? "#9AB4D6" : "#FFE7C2", 5)}</g>}
      <g opacity={1 - dark}>{shape("url(#h-cloud-light)")}</g>
      {dark > 0 && <g opacity={dark}>{shape("url(#h-cloud-dark)")}</g>}
    </g>
  );
};

export type PrecipKind = "rain" | "snow" | "hail";

/** Rain streaks, snowflakes or hail falling inside a box, starting at `start`. */
export const Precipitation: React.FC<{ x: number; y: number; w: number; h: number; frame: number; start: number; kind?: PrecipKind; count?: number; seed?: number; opacity?: number }> = ({
  x,
  y,
  w,
  h,
  frame,
  start,
  kind = "rain",
  count = 40,
  seed = 1,
  opacity = 1,
}) => {
  const drops = useMemo(() => {
    const rnd = seeded(seed * 977 + 13);
    return Array.from({ length: count }, () => ({ x: rnd() * w, phase: rnd(), speed: rnd(), size: rnd() }));
  }, [count, seed, w]);
  if (frame < start) return null;
  const base = kind === "rain" ? 26 : kind === "hail" ? 30 : 4.5;
  return (
    <g opacity={opacity}>
      {drops.map((d, i) => {
        const speed = base * (0.75 + d.speed * 0.5);
        const travelled = (frame - start) * speed - d.phase * h * 0.9;
        if (travelled < 0) return null;
        const dy = travelled % h;
        const edge = Math.min(1, dy / 40, (h - dy) / 60);
        const px = x + d.x + (kind === "snow" ? wave(frame, 70, d.phase * 4) * 16 : -dy * 0.12);
        const py = y + dy;
        if (kind === "rain") return <line key={i} x1={px} y1={py} x2={px + 6} y2={py - 46 - d.size * 20} stroke="#9FDBFF" strokeWidth={3.5} strokeLinecap="round" opacity={0.85 * edge} />;
        if (kind === "hail") return <circle key={i} cx={px} cy={py} r={5 + d.size * 4} fill="#E8F6FF" stroke="#9FDBFF" strokeWidth={2} opacity={edge} />;
        return <Snowflake key={i} x={px} y={py} s={0.5 + d.size * 0.5} rot={frame * 1.5 + d.phase * 90} opacity={edge} />;
      })}
    </g>
  );
};

export const Snowflake: React.FC<{ x: number; y: number; s?: number; rot?: number; opacity?: number; color?: string }> = ({ x, y, s = 1, rot = 0, opacity = 1, color = "#EAF7FF" }) => (
  <g transform={`translate(${x} ${y}) rotate(${rot}) scale(${s})`} opacity={opacity} stroke={color} strokeWidth={3} strokeLinecap="round">
    {[0, 60, 120].map((a) => (
      <g key={a} transform={`rotate(${a})`}>
        <line x1={0} y1={-14} x2={0} y2={14} />
        <line x1={0} y1={-9} x2={-5} y2={-13} />
        <line x1={0} y1={-9} x2={5} y2={-13} />
        <line x1={0} y1={9} x2={-5} y2={13} />
        <line x1={0} y1={9} x2={5} y2={13} />
      </g>
    ))}
  </g>
);

/** Wavy strands of vapour rising from (x..x+w, y) up by `h`. `amount` 0..1 fades it in/out. */
export const Vapour: React.FC<{ x: number; y: number; w: number; h: number; frame: number; amount: number; strands?: number; warm?: number; seed?: number }> = ({
  x,
  y,
  w,
  h,
  frame,
  amount,
  strands = 6,
  warm = 1,
  seed = 3,
}) => {
  const params = useMemo(() => {
    const rnd = seeded(seed);
    return Array.from({ length: strands }, () => ({ phase: rnd() * 6, len: 0.65 + rnd() * 0.35, amp: 14 + rnd() * 14 }));
  }, [seed, strands]);
  if (amount <= 0.001) return null;
  return (
    <g opacity={amount}>
      {params.map((p, i) => {
        const sx = x + (w * (i + 0.5)) / strands;
        const pts: Pt[] = [];
        for (let j = 0; j <= 7; j++) {
          const k = j / 7;
          pts.push({ x: sx + Math.sin(k * 5 + frame * 0.07 + p.phase) * p.amp * (0.4 + k), y: y - k * h * p.len * amount });
        }
        const { d } = spline(pts);
        const color = i % 2 === 0 ? (warm > 0.5 ? "#FFC766" : "#CFEFFF") : "#F4F1EC";
        return (
          <g key={i}>
            <path d={d} fill="none" stroke={color} strokeWidth={12} strokeLinecap="round" opacity={0.14} />
            <path d={d} pathLength={1} fill="none" stroke={color} strokeWidth={4.5} strokeLinecap="round" strokeDasharray="0.16 0.08" strokeDashoffset={frame * 0.012 + p.phase} opacity={0.85} />
          </g>
        );
      })}
    </g>
  );
};

export const Droplet: React.FC<{ x: number; y: number; s?: number; opacity?: number; glow?: boolean }> = ({ x, y, s = 1, opacity = 1, glow = true }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`} opacity={opacity}>
    {glow && <circle cy={6} r={30} fill="url(#h-glow-cyan)" />}
    <path d="M 0 -30 C 8 -16 22 -2 22 12 A 22 22 0 0 1 -22 12 C -22 -2 -8 -16 0 -30 Z" fill="#5DB8F0" />
    <path d="M -9 6 A 10 10 0 0 0 -3 20" fill="none" stroke="#E8F6FF" strokeWidth={4} strokeLinecap="round" />
  </g>
);

const CONTINENTS: Pt[][] = [
  [{ x: 0.05, y: -0.55 }, { x: 0.3, y: -0.62 }, { x: 0.42, y: -0.35 }, { x: 0.3, y: -0.1 }, { x: 0.38, y: 0.15 }, { x: 0.22, y: 0.42 }, { x: 0.12, y: 0.2 }, { x: 0.02, y: -0.15 }, { x: 0.05, y: -0.55 }],
  [{ x: 0.75, y: -0.5 }, { x: 1.15, y: -0.6 }, { x: 1.3, y: -0.3 }, { x: 1.1, y: -0.12 }, { x: 0.98, y: 0.02 }, { x: 0.82, y: -0.2 }, { x: 0.75, y: -0.5 }],
  [{ x: 0.95, y: 0.1 }, { x: 1.12, y: 0.18 }, { x: 1.08, y: 0.5 }, { x: 0.94, y: 0.62 }, { x: 0.88, y: 0.35 }, { x: 0.95, y: 0.1 }],
  [{ x: 1.55, y: 0.25 }, { x: 1.78, y: 0.3 }, { x: 1.74, y: 0.48 }, { x: 1.56, y: 0.45 }, { x: 1.55, y: 0.25 }],
  [{ x: 1.45, y: -0.45 }, { x: 1.62, y: -0.4 }, { x: 1.58, y: -0.22 }, { x: 1.46, y: -0.28 }, { x: 1.45, y: -0.45 }],
];

/**
 * A spinning globe: ocean, simple land masses scrolling across, ice caps, atmosphere glow. Its clip
 * radius changes per frame (the cue "kick"), so each globe has its own clip id: when two globes are
 * on screen (a scene hand-over), neither borrows the other's clip.
 */
export const Globe: React.FC<{ r: number; frame: number; spin?: number }> = ({ r, frame, spin = 0.004 }) => {
  const id = `globe-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const span = 2;
  const offset = (frame * spin) % span;
  return (
    <g>
      <circle r={r * 1.35} fill="url(#h-glow-cyan)" opacity={0.5} />
      <clipPath id={`${id}-clip`}>
        <circle r={r} />
      </clipPath>
      <g clipPath={`url(#${id}-clip)`}>
        <circle r={r} fill="url(#h-globe-ocean)" />
        {CONTINENTS.map((c, i) => (
          <g key={i}>
            {[0, -span, span].map((shift) => (
              <path key={shift} d={spline(c.map((p) => ({ x: (p.x - offset + shift - 0.5) * 2 * r, y: p.y * r })), 0.8).d + " Z"} fill="#5C8A4A" />
            ))}
          </g>
        ))}
        <ellipse cx={0} cy={-r * 0.98} rx={r * 0.55} ry={r * 0.16} fill="#EEF7FF" opacity={0.9} />
        <ellipse cx={0} cy={r * 0.99} rx={r * 0.5} ry={r * 0.13} fill="#EEF7FF" opacity={0.85} />
        <circle r={r} fill="url(#h-shade)" />
        <ellipse cx={-r * 0.35} cy={-r * 0.42} rx={r * 0.32} ry={r * 0.18} fill="#FFFFFF" opacity={0.18} transform={`rotate(-30 ${-r * 0.35} ${-r * 0.42})`} />
      </g>
      <circle r={r + 2} fill="none" stroke="#8FD6FF" strokeWidth={10} opacity={0.18} />
      <circle r={r + 2} fill="none" stroke="#8FD6FF" strokeWidth={4} opacity={0.6 + 0.1 * wave(frame, 80)} />
    </g>
  );
};

/** 0 -> 1 over the first `duration` frames after `since` (objects that build up when they arrive). */
export const arrive = (frame: number, since: number, duration = 24) => rise(frame, since, duration);
