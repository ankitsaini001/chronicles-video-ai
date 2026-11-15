import type React from "react";
import { useMemo } from "react";
import type { HeroName } from "@bytereel/pipeline/planning/hero-catalog";
import { spline } from "../geometry";
import { kickOf, pulse, rise, seeded, wave } from "../motion";
import { Cloud, Droplet, Glow, Globe, Neon, Precipitation, Sparkle, Sun, Vapour, type HeroArt, type HeroProps, type PrecipKind } from "./kit";

/**
 * Nature heroes: the twelve objects of the approved v4 water-cycle sample (chai cup, dinosaur,
 * glacier, rain cloud, cloud, vapour, sun, groundwater, river, ocean, water drop, globe), redrawn
 * without blur filters (soft gradient glows instead) so they render fast.
 */

// ---------- chai cup ----------

const ChaiCup: React.FC<{ frame: number; ripple: number; glow: number }> = ({ frame, ripple, glow }) => (
  <g>
    <Glow y={150} r={290} ry={80} opacity={0.6 * glow} />
    {/* saucer */}
    <ellipse cx={0} cy={150} rx={210} ry={34} fill="#2A1D12" stroke="#F5B65A" strokeWidth={4} opacity={0.95} />
    <ellipse cx={0} cy={144} rx={150} ry={20} fill="#1A120A" />
    {/* handle */}
    <path d="M 128 -40 C 210 -48 216 70 116 74" fill="none" stroke="#F5B65A" strokeWidth={30} strokeOpacity={0.25} strokeLinecap="round" />
    <path d="M 128 -40 C 210 -48 216 70 116 74" fill="none" stroke="#F5B65A" strokeWidth={22} strokeLinecap="round" />
    <path d="M 128 -40 C 210 -48 216 70 116 74" fill="none" stroke="#7A3E14" strokeWidth={10} strokeLinecap="round" />
    {/* body: rim light, then body */}
    <path d="M -150 -98 L 150 -98 L 120 120 Q 112 146 80 146 L -80 146 Q -112 146 -120 120 Z" fill="#F5B65A" opacity={0.35} transform="translate(-6 -6) scale(1.03)" />
    <path d="M -150 -98 L 150 -98 L 120 120 Q 112 146 80 146 L -80 146 Q -112 146 -120 120 Z" fill="#F5B65A" transform="translate(-3 -3)" />
    <path d="M -150 -98 L 150 -98 L 120 120 Q 112 146 80 146 L -80 146 Q -112 146 -120 120 Z" fill="url(#h-cup)" />
    <path d="M -118 -60 L -96 110" stroke="#FFE2A8" strokeWidth={10} strokeLinecap="round" opacity={0.45} />
    {/* tea surface */}
    <ellipse cx={0} cy={-98} rx={150} ry={26} fill="#5A2C0E" stroke="#FFE2A8" strokeWidth={4} />
    <ellipse cx={-30} cy={-102} rx={70} ry={8} fill="#C86A22" opacity={0.6} />
    {ripple > 0 && ripple < 1 && <ellipse cx={0} cy={-98} rx={30 + ripple * 110} ry={(30 + ripple * 110) * 0.17} fill="none" stroke="#FFE2A8" strokeWidth={5} opacity={1 - ripple} />}
    <Vapour x={-90} y={-128} w={180} h={200 + wave(frame, 80) * 10} frame={frame} amount={1} strands={3} warm={1} seed={7} />
  </g>
);

const ChaiObject: React.FC<HeroProps> = ({ frame, cues }) => {
  // a drop falls into the cup just before each cue, then the tea ripples
  const cue = cues.find((c) => frame >= c - 18 && frame < c + 26);
  const dropT = cue !== undefined && frame < cue ? (frame - (cue - 18)) / 18 : null;
  const ripple = cue !== undefined && frame >= cue ? (frame - cue) / 26 : 0;
  return (
    <g transform="translate(0 50) scale(1.02)">
      <ChaiCup frame={frame} ripple={ripple} glow={1 + 0.6 * pulse(frame, cue ?? -99, 30)} />
      {dropT !== null && <Droplet x={0} y={-265 + dropT * dropT * 165} s={1.4} opacity={Math.min(1, dropT * 4)} />}
    </g>
  );
};

// ---------- dinosaur (a long-necked sauropod lowering its head to drink) ----------

const Dinosaur: React.FC<{ frame: number; dip: number }> = ({ frame, dip }) => {
  const sway = wave(frame, 120) * 3;
  const headY = 10 + dip * 70 + sway;
  const neck = `M -60 -40 C -150 -150 -250 -150 -300 ${headY - 40}`;
  // `grow` thickens every shape (an outline glow when drawn under the body)
  const body = (fill: string, stroke?: string, grow = 0) => {
    const edge = grow > 0 ? { stroke: fill, strokeWidth: grow, strokeLinejoin: "round" as const } : {};
    return (
      <>
        <path d="M 110 -40 C 230 -40 300 10 360 60 C 290 30 210 20 110 30 Z" fill={fill} {...edge} />
        <rect x={-80} y={0} width={42} height={120} rx={18} fill={fill} {...edge} />
        <rect x={-20} y={10} width={40} height={112} rx={18} fill={fill} {...edge} />
        <rect x={60} y={0} width={44} height={120} rx={18} fill={fill} {...edge} />
        <rect x={110} y={6} width={40} height={114} rx={18} fill={fill} {...edge} />
        <ellipse cx={30} cy={-20} rx={150} ry={86} fill={fill} {...edge} />
        <path d={neck} fill="none" stroke={stroke ?? fill} strokeWidth={50 + grow} strokeLinecap="round" />
        <ellipse cx={-312} cy={headY - 30} rx={44} ry={26} fill={fill} {...edge} transform={`rotate(${20 + dip * 25} -312 ${headY - 30})`} />
      </>
    );
  };
  return (
    <g>
      <g opacity={0.22}>{body("#F5A524", undefined, 26)}</g>
      <g transform="translate(-3 -3)">{body("#FFC24A", undefined, 9)}</g>
      <g>{body("url(#h-dino)", "#5A4636")}</g>
      <circle cx={-326} cy={headY - 38} r={5} fill="#FFE2A8" />
      {[-40, 10, 60, 110].map((px, i) => (
        <circle key={i} cx={px} cy={-98 + Math.abs(px - 30) * 0.12} r={7} fill="#9A8068" />
      ))}
    </g>
  );
};

const DinosaurObject: React.FC<HeroProps> = ({ frame, since }) => {
  const dip = rise(frame, since + 10, 24) * (0.75 + 0.25 * wave(frame, 50));
  return (
    <g>
      <ellipse cx={-235} cy={120} rx={110} ry={20} fill="#0E3A5C" />
      <ellipse cx={-235} cy={116} rx={92} ry={13} fill="#2F8FD8" opacity={0.75} />
      <Glow x={-235} y={116} r={130} ry={40} color="blue" opacity={0.6} />
      <g transform="translate(30 10) scale(0.8)">
        <Dinosaur frame={frame} dip={dip} />
      </g>
    </g>
  );
};

// ---------- globe ----------

const GlobeObject: React.FC<HeroProps> = ({ frame, cues }) => <Globe r={235 * (1 + 0.04 * kickOf(frame, cues))} frame={frame} id="hero-globe" />;

// ---------- ocean (a round window onto the sea) ----------

const OCEAN_LAYERS: [number, number, number, number, string][] = [
  [-40, 9, 170, 0.07, "#2C86C9"],
  [25, 12, 210, 0.055, "#1E6DAA"],
  [95, 14, 250, 0.045, "#14527F"],
  [170, 16, 290, 0.038, "#0B3358"],
];

const OceanObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const R = 250;
  const kick = kickOf(frame, cues, 40);
  const band = (y: number, amp: number, len: number, speed: number) => {
    const pts: string[] = [];
    for (let x = -R - 20; x <= R + 20; x += 20) pts.push(`${x},${(y + Math.sin((x / len) * Math.PI * 2 + frame * speed) * amp * (1 + 0.6 * kick)).toFixed(1)}`);
    return pts;
  };
  return (
    <g>
      <Glow r={R + 90} color="blue" opacity={0.6} />
      <defs>
        <clipPath id="hero-ocean-clip">
          <circle r={R} />
        </clipPath>
        <linearGradient id="hero-ocean-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1A120A" />
          <stop offset="100%" stopColor="#5A3412" />
        </linearGradient>
      </defs>
      <g clipPath="url(#hero-ocean-clip)">
        <rect x={-R} y={-R} width={2 * R} height={2 * R} fill="url(#hero-ocean-sky)" />
        <Glow x={80} y={-70} r={110} color="gold" />
        <circle cx={80} cy={-70} r={46} fill="#FFD27A" />
        {OCEAN_LAYERS.map(([y, amp, len, speed, color], i) => {
          const top = band(y, amp, len, speed);
          return (
            <g key={i}>
              <polygon points={[`${-R - 20},${R}`, ...top, `${R + 20},${R}`].join(" ")} fill={color} />
              <polyline points={top.join(" ")} fill="none" stroke="#BFE9FF" strokeWidth={3} opacity={0.55 - i * 0.1} />
            </g>
          );
        })}
        <Glow x={80} y={-32} r={130} ry={18} color="gold" />
        {[0, 1, 2, 3, 4].map((i) => {
          const t = ((frame * 0.9 + i * 47) % 200) / 200;
          return <circle key={i} cx={-150 + i * 75} cy={230 - t * 200} r={4 + (i % 3) * 2} fill="none" stroke="#BFE9FF" strokeWidth={2} opacity={0.6 * (1 - t)} />;
        })}
      </g>
      <circle r={R} fill="none" stroke="#8FD6FF" strokeWidth={16} opacity={0.15} />
      <circle r={R} fill="none" stroke="#8FD6FF" strokeWidth={6} opacity={0.75} />
    </g>
  );
};

// ---------- glacier / iceberg ----------

const GlacierObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const bob = wave(frame, 110) * 6;
  const kick = kickOf(frame, cues, 30);
  const water: string[] = [];
  for (let x = -290; x <= 290; x += 20) water.push(`${x},${(30 + Math.sin(x / 40 + frame * 0.06) * 5).toFixed(1)}`);
  return (
    <g>
      <Glow y={60} r={320} ry={150} color="cyan" opacity={0.35} />
      <g transform={`translate(0 ${bob})`}>
        <polygon points="-215,30 -260,120 -180,235 -30,275 140,240 245,125 205,30" fill="#7CC4FF" opacity={0.25} stroke="#BFE9FF" strokeOpacity={0.35} strokeWidth={3} />
        <polygon points="-205,30 -160,-50 -105,-35 -45,-205 25,-115 75,-170 160,-25 205,30" fill="#EAF6FF" />
        <polygon points="-45,-205 25,-115 0,30 -70,30" fill="#CFE6F7" />
        <polygon points="75,-170 160,-25 205,30 90,30 60,-60" fill="#B7D7EE" />
        <polygon points="-160,-50 -105,-35 -120,30 -205,30" fill="#D6EBFA" />
        <Neon d="M -205 30 L -160 -50 L -105 -35 L -45 -205 L 25 -115 L 75 -170 L 160 -25 L 205 30" color="#FFFFFF" width={4} />
      </g>
      <polyline points={water.join(" ")} fill="none" stroke="#8FD6FF" strokeWidth={5} opacity={0.85} />
      <Sparkle x={-30} y={-150 + bob} s={0.6 + 0.6 * kick} opacity={0.4 + 0.6 * kick} rot={frame * 2} />
      <Sparkle x={110} y={-90 + bob} s={0.4 + 0.5 * kick} opacity={0.3 + 0.6 * kick} rot={-frame * 2} />
    </g>
  );
};

// ---------- sun ----------

const SunObject: React.FC<HeroProps> = ({ frame, cues }) => <Sun x={0} y={0} r={150} frame={frame} heat={Math.max(kickOf(frame, cues, 30), 0.15 + 0.1 * wave(frame, 70))} />;

// ---------- vapour (steam rising from water) ----------

const VapourObject: React.FC<HeroProps> = ({ frame, cues, since }) => {
  const amount = rise(frame, since, 24);
  const kick = kickOf(frame, cues, 40);
  const strands = [-150, -90, -30, 30, 90, 150];
  return (
    <g>
      <defs>
        <linearGradient id="hero-vapour" gradientUnits="userSpaceOnUse" x1="0" y1="200" x2="0" y2="-260">
          <stop offset="0%" stopColor="#FFE2A8" stopOpacity={0.95} />
          <stop offset="55%" stopColor="#F4F1EC" stopOpacity={0.6} />
          <stop offset="100%" stopColor="#F4F1EC" stopOpacity={0} />
        </linearGradient>
      </defs>
      <ellipse cx={0} cy={215} rx={250} ry={52} fill="#0E3A5C" />
      <ellipse cx={0} cy={208} rx={230} ry={40} fill="#2F8FD8" opacity={0.85} />
      <Glow y={204} r={200} ry={30} color="gold" opacity={0.6 + 0.3 * kick} />
      {strands.map((x0, i) => {
        const h = (380 + 60 * kick) * amount * (0.8 + (0.2 * ((i * 37) % 5)) / 4);
        const pts = Array.from({ length: 8 }, (_, j) => {
          const k = j / 7;
          return { x: x0 * (1 - 0.25 * k) + Math.sin(k * 5 + frame * 0.06 + i) * (14 + 26 * k), y: 195 - k * h };
        });
        const d = spline(pts).d;
        return (
          <g key={i}>
            <path d={d} fill="none" stroke="url(#hero-vapour)" strokeWidth={34} strokeLinecap="round" opacity={0.18} />
            <path d={d} fill="none" stroke="url(#hero-vapour)" strokeWidth={12} strokeLinecap="round" pathLength={1} strokeDasharray="0.3 0.12" strokeDashoffset={frame * 0.012 + i * 0.13} />
          </g>
        );
      })}
    </g>
  );
};

// ---------- cloud / rain cloud (one family: they morph) ----------

const CondenseDots: React.FC<{ frame: number; cues: number[] }> = ({ frame, cues }) => {
  const dots = useMemo(() => {
    const rnd = seeded(41);
    return Array.from({ length: 22 }, () => ({ a: rnd() * Math.PI * 2, d: 200 + rnd() * 90, r: 4 + rnd() * 4 }));
  }, []);
  const cue = [...cues].reverse().find((c) => frame >= c && frame < c + 40);
  if (cue === undefined) return null;
  const t = (frame - cue) / 40;
  return (
    <g>
      {dots.map((p, i) => (
        <circle key={i} cx={Math.cos(p.a) * p.d * (1 - t)} cy={-20 + Math.sin(p.a) * p.d * 0.6 * (1 - t)} r={p.r} fill="#E8F6FF" opacity={Math.min(1, (1 - t) * 1.6)} />
      ))}
    </g>
  );
};

const CloudObject: React.FC<HeroProps> = ({ frame, cues }) => (
  <g>
    <Cloud x={-150} y={70} s={0.55} frame={frame} seed={3} opacity={0.85} glow={0} />
    <Cloud x={160} y={90} s={0.5} frame={frame} seed={6} opacity={0.85} glow={0} />
    <Cloud x={0} y={0} s={1.3 + 0.05 * kickOf(frame, cues)} frame={frame} seed={1} glow={0.9} />
    <CondenseDots frame={frame} cues={cues} />
  </g>
);

const PRECIP: Record<string, PrecipKind> = { snow: "snow", hail: "hail" };

const RainCloudObject: React.FC<HeroProps> = ({ frame, cueWords, since }) => {
  const dark = rise(frame, since, 24);
  // the latest rain / snow / hail word picks what falls; rain starts shortly after the cloud darkens
  const started = cueWords.filter((c) => c.frame <= frame);
  const last = started[started.length - 1];
  const word = last ? last.word.toLowerCase().replace(/[^a-z]/g, "").slice(0, 4) : "";
  const kind: PrecipKind = PRECIP[word] ?? "rain";
  const kindStart = last ? last.frame : since + 12;
  return (
    <g>
      <Precipitation x={-200} y={-30} w={400} h={300} frame={frame} start={Math.min(kindStart, since + 12)} kind="rain" count={36} seed={3} opacity={kind === "rain" ? 1 : 0.35} />
      {kind !== "rain" && <Precipitation x={-200} y={-30} w={400} h={300} frame={frame} start={kindStart} kind={kind} count={kind === "snow" ? 20 : 14} seed={5} />}
      <Cloud x={0} y={-110} s={1.3} dark={dark} frame={frame} seed={1} glow={0.7} />
    </g>
  );
};

// ---------- land block: river / groundwater (one family) ----------

const BLOCK = { l: { x: -260, y: -90 }, t: { x: 0, y: -215 }, r: { x: 260, y: -90 }, b: { x: 0, y: 35 }, h: 200 };
const RIVER = spline([
  { x: -130, y: -152 },
  { x: -70, y: -118 },
  { x: -40, y: -70 },
  { x: 20, y: -52 },
  { x: 80, y: -20 },
  { x: 130, y: -28 },
]).d;
const PINES: [number, number][] = [
  [-150, -110],
  [-110, -75],
  [150, -110],
  [100, -150],
];

const LandObject: React.FC<HeroProps & { mode: "river" | "groundwater" }> = ({ frame, cues, mode }) => {
  const { l, t, r, b, h } = BLOCK;
  const bob = wave(frame, 120) * 5;
  const kick = kickOf(frame, cues, 40);
  const seep = mode === "groundwater";
  return (
    <g transform={`translate(0 ${bob})`}>
      <ellipse cx={0} cy={250} rx={300} ry={40} fill="#000" opacity={0.35} />
      <polygon points={`${l.x},${l.y} ${b.x},${b.y} ${b.x},${b.y + h} ${l.x},${l.y + h}`} fill="#3A2614" />
      <polygon points={`${l.x},${l.y + 60} ${b.x},${b.y + 60} ${b.x},${b.y + 120} ${l.x},${l.y + 120}`} fill="#4A3220" />
      <polygon points={`${l.x},${l.y + 140} ${b.x},${b.y + 140} ${b.x},${b.y + h} ${l.x},${l.y + h}`} fill="#2F8FD8" opacity={seep ? 0.75 + 0.25 * kick : 0.5} />
      <polygon points={`${b.x},${b.y} ${r.x},${r.y} ${r.x},${r.y + h} ${b.x},${b.y + h}`} fill="#4E3420" />
      <polygon points={`${b.x},${b.y + 140} ${r.x},${r.y + 140} ${r.x},${r.y + h} ${b.x},${b.y + h}`} fill="#3B9BE0" opacity={seep ? 0.8 + 0.2 * kick : 0.55} />
      {!seep && <path d="M 130 -28 L 150 162" stroke="#8FD6FF" strokeWidth={14} strokeLinecap="round" opacity={0.8} strokeDasharray="16 10" strokeDashoffset={-frame * 3} />}
      <polygon points={`${l.x},${l.y} ${t.x},${t.y} ${r.x},${r.y} ${b.x},${b.y}`} fill="#4E7A4A" />
      <polyline points={`${l.x},${l.y} ${b.x},${b.y} ${r.x},${r.y}`} fill="none" stroke="#F5A524" strokeWidth={3} opacity={0.5} />
      <path d={RIVER} fill="none" stroke="#14507F" strokeWidth={34} strokeLinecap="round" />
      {!seep && <path d={RIVER} fill="none" stroke="#3BA7E8" strokeWidth={40} strokeOpacity={0.25} strokeLinecap="round" />}
      <path d={RIVER} fill="none" stroke="#3BA7E8" strokeWidth={24} strokeLinecap="round" />
      <path d={RIVER} fill="none" stroke="#DDF3FF" strokeWidth={5} strokeLinecap="round" strokeDasharray="14 22" strokeDashoffset={-frame * (seep ? 1.2 : 2.6 + 2 * kick)} />
      {PINES.map(([x, y], i) => (
        <polygon key={i} points={`${x},${y - 46} ${x - 15},${y} ${x + 15},${y}`} fill="#2F5A2C" />
      ))}
      {seep &&
        [0, 1, 2, 3, 4].map((i) => {
          const tt = ((frame * 1.4 + i * 28) % 140) / 140;
          const x = -215 + i * 45;
          const y0 = l.y + (x - l.x) * ((b.y - l.y) / (b.x - l.x)) + 20;
          return <Droplet key={i} x={x} y={y0 + tt * 120} s={0.55} opacity={Math.min(1, (1 - tt) * 2)} glow={false} />;
        })}
    </g>
  );
};
const RiverObject: React.FC<HeroProps> = (p) => <LandObject {...p} mode="river" />;
const GroundwaterObject: React.FC<HeroProps> = (p) => <LandObject {...p} mode="groundwater" />;

// ---------- water drop ----------

const DropObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 30);
  return (
    <g>
      <ellipse cx={0} cy={230} rx={190} ry={30} fill="#2F8FD8" opacity={0.35} />
      {[0, 1, 2].map((i) => {
        const tt = ((frame + i * 25) % 75) / 75;
        return <ellipse key={i} cx={0} cy={230} rx={60 + tt * 170} ry={(60 + tt * 170) * 0.16} fill="none" stroke="#BFE9FF" strokeWidth={4} opacity={0.7 * (1 - tt)} />;
      })}
      <g transform={`translate(0 ${-20 + wave(frame, 70) * 8}) scale(${1 + 0.05 * kick})`}>
        <Droplet x={0} y={0} s={6.2} />
        <ellipse cx={-55} cy={-10} rx={18} ry={44} fill="#FFFFFF" opacity={0.35} transform="rotate(20 -55 -10)" />
      </g>
    </g>
  );
};

export const NATURE_HEROES = {
  "chai-cup": { Draw: ChaiObject },
  dinosaur: { Draw: DinosaurObject },
  glacier: { Draw: GlacierObject },
  "rain-cloud": { Draw: RainCloudObject, scale: 1.1 },
  cloud: { Draw: CloudObject, scale: 1.15 },
  vapour: { Draw: VapourObject },
  sun: { Draw: SunObject, scale: 1.2 },
  groundwater: { Draw: GroundwaterObject },
  river: { Draw: RiverObject },
  ocean: { Draw: OceanObject },
  drop: { Draw: DropObject },
  globe: { Draw: GlobeObject },
} satisfies Partial<Record<HeroName, HeroArt>>;
