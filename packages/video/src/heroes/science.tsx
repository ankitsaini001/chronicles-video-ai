import type React from "react";
import type { HeroName } from "@bytereel/pipeline/planning/hero-catalog";
import { spline, type Pt } from "../geometry";
import { clamp01, kickOf, pop, pulse, rise, seeded, wave } from "../motion";
import { Glow, Neon, Sparkle, type HeroArt, type HeroProps } from "./kit";

/**
 * Science and health heroes: atom, DNA, heart, brain, plant, lab flask, virus, magnet, light bulb.
 * Same recipe as the nature objects: dark rich bodies, an amber rim light up-left, soft gradient
 * glows (no filters), one gentle idle motion and a short act when the narration names the object.
 */

/** Rim light: a faint amber halo and a bright amber copy of the silhouette just up-left of the body. */
const Lit: React.FC<{ d: string; fill: string; rim?: string; halo?: number }> = ({ d, fill, rim = "#F5B65A", halo = 0.3 }) => (
  <>
    {halo > 0 && <path d={d} fill={rim} opacity={halo} transform="translate(-6 -6)" />}
    <path d={d} fill={rim} transform="translate(-3 -3)" />
    <path d={d} fill={fill} />
  </>
);

/** Extra distance a cue adds to a running motion (grows while the kick lasts, then stays: no jump back). */
const kickTravel = (frame: number, cues: readonly number[], len: number) => {
  let s = 0;
  for (const c of cues) {
    const t = Math.min(len, frame - c);
    if (t > 0) s += t - (t * t) / (2 * len);
  }
  return s;
};

/** The most recent cue at or before `frame` (or null). */
const lastCue = (frame: number, cues: readonly number[]) => {
  let best: number | null = null;
  for (const c of cues) if (c <= frame && (best === null || c > best)) best = c;
  return best;
};

// ---------- atom ----------

const ORBIT_TILTS = [0, 60, -60];
const ORX = 258;
const ORY = 84;
const ORBIT_BACK = `M ${-ORX} 0 A ${ORX} ${ORY} 0 0 1 ${ORX} 0`;
const ORBIT_FRONT = `M ${ORX} 0 A ${ORX} ${ORY} 0 0 1 ${-ORX} 0`;
/** x, y, proton? (drawn back to front) */
const NUCLEONS: [number, number, boolean][] = [
  [-34, -24, true],
  [30, -32, false],
  [2, -50, true],
  [-44, 18, false],
  [42, 12, true],
  [-8, 44, false],
  [28, 42, true],
  [-12, -2, true],
  [16, -8, false],
];

const orbitPt = (a: number) => ({ x: ORX * Math.cos(a), y: ORY * Math.sin(a) });

const Electron: React.FC<{ a: number }> = ({ a }) => {
  const p = orbitPt(a);
  const tail = (len: number) => {
    const q = orbitPt(a - len);
    return `M ${q.x.toFixed(1)} ${q.y.toFixed(1)} A ${ORX} ${ORY} 0 0 1 ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  };
  const s = 1 + 0.2 * Math.sin(a); // nearer = bigger
  return (
    <g>
      <path d={tail(0.9)} fill="none" stroke="#8FD6FF" strokeWidth={9} strokeLinecap="round" opacity={0.22} />
      <path d={tail(0.4)} fill="none" stroke="#CFEFFF" strokeWidth={6} strokeLinecap="round" opacity={0.55} />
      <circle cx={p.x} cy={p.y} r={40 * s} fill="url(#h-glow-cyan)" />
      <circle cx={p.x} cy={p.y} r={15 * s} fill="#E8F7FF" />
    </g>
  );
};

const AtomObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 30);
  const travel = kickTravel(frame, cues, 30);
  const angles = ORBIT_TILTS.map((_, i) => frame * (0.075 + 0.012 * i) + travel * 0.22 + i * 2.2);
  const layer = (front: boolean) =>
    ORBIT_TILTS.map((tilt, i) => {
      const a = angles[i] ?? 0;
      return (
        <g key={tilt} transform={`rotate(${tilt})`}>
          <Neon d={front ? ORBIT_FRONT : ORBIT_BACK} color="#8FD6FF" width={front ? 6.5 : 5} opacity={(front ? 0.85 : 0.45) + 0.15 * kick} />
          {Math.sin(a) >= 0 === front && <Electron a={a} />}
        </g>
      );
    });
  const s = 1 + 0.1 * kick + 0.02 * wave(frame, 50);
  return (
    <g>
      <defs>
        <radialGradient id="h-atom-p" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#FFE0B8" />
          <stop offset="45%" stopColor="#F2783A" />
          <stop offset="100%" stopColor="#7A2410" />
        </radialGradient>
        <radialGradient id="h-atom-n" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#F2F6FA" />
          <stop offset="45%" stopColor="#9AA6B8" />
          <stop offset="100%" stopColor="#3A4250" />
        </radialGradient>
      </defs>
      <Glow r={310} ry={230} color="blue" opacity={0.3 + 0.25 * kick} />
      {layer(false)}
      <Glow r={160} color="amber" opacity={0.85 + 0.15 * kick} />
      <g transform={`scale(${s.toFixed(4)})`}>
        {NUCLEONS.map(([x, y], i) => (
          <circle key={`rim${i}`} cx={x - 3} cy={y - 3} r={34} fill="#F5B65A" />
        ))}
        {NUCLEONS.map(([x, y, p], i) => (
          <circle key={i} cx={x} cy={y} r={34} fill={p ? "url(#h-atom-p)" : "url(#h-atom-n)"} />
        ))}
      </g>
      {layer(true)}
    </g>
  );
};

// ---------- DNA (double helix, turning) ----------

const DNA_LEN = 262;
const DNA_A = 116;
const DNA_K = (2 * Math.PI) / 270;
const DNA_RUNGS = 15;
const BASE_PAIRS: [string, string][] = [
  ["#FF7A6A", "#7BC86E"],
  ["#FFD27A", "#5DB8F0"],
  ["#7BC86E", "#FF7A6A"],
  ["#5DB8F0", "#FFD27A"],
];
const STRANDS = [
  { off: 0, front: "#F5B33A", back: "#7A4A12", rim: "#FFE2A8" },
  { off: Math.PI, front: "#4FA8E8", back: "#1A4A78", rim: "#BFE9FF" },
];

const DnaObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 40);
  const phase = frame * 0.045 + kickTravel(frame, cues, 30) * 0.12;
  const runsOf = (off: number) => {
    const runs: { pts: string[]; front: boolean }[] = [];
    let cur: { pts: string[]; front: boolean } | null = null;
    let prev: string | null = null;
    for (let y = -DNA_LEN; y <= DNA_LEN + 0.1; y += 9) {
      const t = DNA_K * y + phase + off;
      const p = `${(DNA_A * Math.sin(t)).toFixed(1)},${y.toFixed(1)}`;
      const front = Math.cos(t) >= 0;
      if (!cur || cur.front !== front) {
        cur = { pts: prev ? [prev] : [], front };
        runs.push(cur);
      }
      cur.pts.push(p);
      prev = p;
    }
    return runs;
  };
  const strands = STRANDS.map((s) => ({ ...s, runs: runsOf(s.off) }));
  const step = (2 * DNA_LEN) / DNA_RUNGS;
  return (
    <g>
      <Glow r={250} ry={330} color="blue" opacity={0.3 + 0.3 * kick} />
      <g transform="rotate(-24)">
        {strands.map((s, si) =>
          s.runs
            .filter((r) => !r.front)
            .map((r, ri) => <polyline key={`b${si}-${ri}`} points={r.pts.join(" ")} fill="none" stroke={s.back} strokeWidth={17} strokeLinecap="round" strokeLinejoin="round" />),
        )}
        {Array.from({ length: DNA_RUNGS }, (_, j) => {
          const y = -DNA_LEN + (j + 0.5) * step;
          const xa = DNA_A * Math.sin(DNA_K * y + phase);
          if (Math.abs(xa) < 8) return null;
          const [c1, c2] = BASE_PAIRS[j % BASE_PAIRS.length]!;
          let g = 0;
          for (const c of cues) g = Math.max(g, pulse(frame, c + j * 1.6, 14));
          const w = 11 + 5 * g;
          return (
            <g key={j}>
              <line x1={xa} y1={y} x2={0} y2={y} stroke={c1} strokeWidth={w} strokeLinecap="round" />
              <line x1={0} y1={y} x2={-xa} y2={y} stroke={c2} strokeWidth={w} strokeLinecap="round" />
              {g > 0.02 && <line x1={xa} y1={y} x2={-xa} y2={y} stroke="#FFFFFF" strokeWidth={5} strokeLinecap="round" opacity={g} />}
            </g>
          );
        })}
        {strands.map((s, si) =>
          s.runs
            .filter((r) => r.front)
            .map((r, ri) => {
              const pts = r.pts.join(" ");
              return (
                <g key={`f${si}-${ri}`}>
                  <polyline points={pts} fill="none" stroke={s.rim} strokeWidth={34} strokeOpacity={0.22} strokeLinecap="round" strokeLinejoin="round" />
                  <polyline points={pts} fill="none" stroke={s.front} strokeWidth={24} strokeLinecap="round" strokeLinejoin="round" />
                  <polyline points={pts} fill="none" stroke="#FFFFFF" strokeWidth={5} strokeOpacity={0.45} strokeLinecap="round" strokeLinejoin="round" transform="translate(-5 -2)" />
                </g>
              );
            }),
        )}
      </g>
    </g>
  );
};

// ---------- heart (beats: lub-dub) ----------

const HEART = "M 0 -95 C -30 -175 -235 -195 -235 -40 C -235 70 -110 150 0 225 C 110 150 235 70 235 -40 C 235 -195 30 -175 0 -95 Z";
const AORTA = "M 22 -100 C 22 -210 122 -214 122 -128";
const VEIN = "M -46 -104 L -46 -198";
const BRANCHES: [number, number, number, number][] = [
  [46, -172, 34, -222],
  [72, -186, 72, -236],
  [100, -180, 112, -228],
];

const HeartDefs: React.FC = () => (
  <defs>
    <radialGradient id="h-heart-body" cx="36%" cy="28%" r="85%">
      <stop offset="0%" stopColor="#FF9C8E" />
      <stop offset="35%" stopColor="#E8424A" />
      <stop offset="72%" stopColor="#A3182A" />
      <stop offset="100%" stopColor="#5A0A16" />
    </radialGradient>
    <linearGradient id="h-heart-aorta" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stopColor="#FF7A70" />
      <stop offset="100%" stopColor="#B0202E" />
    </linearGradient>
  </defs>
);

/** Lub-dub: two quick pulses per 30-frame beat (60 bpm), stronger right after a cue. */
const heartBeat = (frame: number, cues: readonly number[]) => {
  const t = ((frame % 30) + 30) % 30;
  const kick = kickOf(frame, cues, 36);
  return { kick, beat: (pulse(t, 0, 7) + 0.65 * pulse(t, 8, 7)) * (1 + 0.8 * kick) };
};

const HeartBody: React.FC = () => (
  <>
    <Lit d={HEART} fill="url(#h-heart-body)" />
    {/* a soft groove (the septum) and a glossy highlight */}
    <path d="M 22 -80 C 50 0 40 90 6 190" fill="none" stroke="#6A0E1C" strokeWidth={8} strokeLinecap="round" opacity={0.45} />
    <ellipse cx={-120} cy={-95} rx={58} ry={30} fill="#FFFFFF" opacity={0.28} transform="rotate(-35 -120 -95)" />
    <circle cx={-160} cy={-40} r={9} fill="#FFFFFF" opacity={0.35} />
  </>
);

const HeartObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const { kick, beat } = heartBeat(frame, cues);
  const s = 1 + 0.055 * beat;
  return (
    <g transform="translate(0 -6)">
      <HeartDefs />
      <Glow y={30} r={310} color="red" opacity={0.35 + 0.35 * beat + 0.2 * kick} />
      <g transform={`translate(0 30) scale(${s.toFixed(4)}) translate(0 -30)`}>
        {/* vessels behind the top of the heart */}
        <path d={VEIN} stroke="#F5B65A" strokeWidth={44} strokeLinecap="round" transform="translate(-3 -3)" />
        <path d={VEIN} stroke="#3C6FC4" strokeWidth={38} strokeLinecap="round" />
        <path d={VEIN} stroke="#8FC0FF" strokeWidth={7} strokeLinecap="round" opacity={0.6} transform="translate(-8 0)" />
        {BRANCHES.map(([x1, y1, x2, y2], i) => (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#F5B65A" strokeWidth={20} strokeLinecap="round" transform="translate(-3 -3)" />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#C8303A" strokeWidth={16} strokeLinecap="round" />
          </g>
        ))}
        <path d={AORTA} fill="none" stroke="#F5B65A" strokeWidth={50} strokeLinecap="round" transform="translate(-3 -3)" />
        <path d={`${AORTA} Z`} fill="#B82634" />
        <path d={AORTA} fill="none" stroke="url(#h-heart-aorta)" strokeWidth={44} strokeLinecap="round" />
        <path d="M 30 -148 C 42 -192 92 -206 112 -178" fill="none" stroke="#FFC0B8" strokeWidth={7} strokeLinecap="round" opacity={0.6} />
        <HeartBody />
      </g>
    </g>
  );
};

// ---------- brain (two hemispheres with folds, sparks on cue) ----------

const BRAIN_RX = 218;
const BRAIN_RY = 206;
const BRAIN_CY = -4;
const BRAIN_GAP = 7;
const BRAIN_ARC = 13;

/** Outer edge of the left hemisphere, top to bottom: half of a bumpy egg (a little wider at the back). */
const BRAIN_EDGE: Pt[] = Array.from({ length: BRAIN_ARC + 1 }, (_, i) => {
  const a = -Math.PI / 2 + (i / BRAIN_ARC) * Math.PI;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const bump = i === 0 || i === BRAIN_ARC ? 1 : i % 2 === 0 ? 1.03 : 0.972;
  return { x: -(BRAIN_GAP + (BRAIN_RX - BRAIN_GAP) * (1 + 0.06 * s) * c * bump), y: BRAIN_CY + BRAIN_RY * s * bump };
});
const mirror = (pts: Pt[]) => pts.map((p) => ({ x: -p.x, y: p.y }));
/** The straight side of each half is the midline fissure. */
const BRAIN_L = `${spline(BRAIN_EDGE).d} Z`;
const BRAIN_R = `${spline(mirror(BRAIN_EDGE)).d} Z`;

/**
 * Grooves of the left hemisphere (the right one mirrors them): one from each dip of the bumpy
 * outline curling inwards, a few from the midline outwards and two in the middle, so they read as
 * folds of the surface rather than loose lines.
 */
const FOLDS_L: Pt[][] = [
  ...BRAIN_EDGE.flatMap((v, i) => {
    if (i % 2 === 0 || i === BRAIN_ARC) return [];
    const cx = -104;
    const cy = BRAIN_CY + (v.y - BRAIN_CY) * 0.55;
    const len = Math.hypot(cx - v.x, cy - v.y);
    const d = { x: (cx - v.x) / len, y: (cy - v.y) / len };
    const n = { x: -d.y, y: d.x };
    const k = i % 4 === 1 ? 1 : -1;
    const at = (t: number, w: number) => ({ x: v.x + d.x * t + n.x * w * k, y: v.y + d.y * t + n.y * w * k });
    return [[at(-6, 0), at(32, 7), at(58, -9), at(80, 10)]];
  }),
  ...[-128, -44, 40, 124].map((y, i) => {
    const k = i % 2 === 0 ? 1 : -1;
    return [
      { x: -BRAIN_GAP, y },
      { x: -36, y: y + 7 * k },
      { x: -54, y: y - 16 * k },
      { x: -80, y: y - 8 * k },
    ];
  }),
  [{ x: -126, y: -70 }, { x: -108, y: -48 }, { x: -122, y: -20 }],
  [{ x: -112, y: 30 }, { x: -130, y: 54 }, { x: -114, y: 82 }],
];
const FOLDS = [...FOLDS_L, ...FOLDS_L.map(mirror)].map((f) => spline(f));
/** Which fold each spark runs along, and its delay after the cue. */
const SPARKS: [number, number][] = [
  [1, 0],
  [15, 3],
  [3, 6],
  [20, 9],
  [8, 12],
  [12, 4],
];

const BrainObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 40);
  const cue = lastCue(frame, cues);
  const sparks: { fold: number; t: number }[] = [];
  if (cue !== null)
    for (const [fold, delay] of SPARKS) {
      const t = (frame - cue - delay) / 16;
      if (t > 0 && t < 1.25) sparks.push({ fold, t });
    }
  // one idle spark wandering along the folds
  const idle = (frame % 70) / 70;
  sparks.push({ fold: Math.floor(frame / 70) % FOLDS.length, t: idle });
  return (
    <g>
      <defs>
        <radialGradient id="h-brain-body" cx="38%" cy="30%" r="85%">
          <stop offset="0%" stopColor="#FFC7D2" />
          <stop offset="40%" stopColor="#E9849C" />
          <stop offset="100%" stopColor="#7E2A4A" />
        </radialGradient>
      </defs>
      <Glow r={320} ry={280} color="violet" opacity={0.35 + 0.35 * kick} />
      <Lit d={BRAIN_L} fill="url(#h-brain-body)" />
      <Lit d={BRAIN_R} fill="url(#h-brain-body)" />
      <clipPath id="h-brain-clip">
        <path d={BRAIN_L} />
        <path d={BRAIN_R} />
      </clipPath>
      <g clipPath="url(#h-brain-clip)">
        {FOLDS.map((f, i) => (
          <g key={i}>
            <path d={f.d} fill="none" stroke="#FFD6DF" strokeWidth={5} strokeLinecap="round" opacity={0.5} transform="translate(-3 -4)" />
            <path d={f.d} fill="none" stroke="#8E2F55" strokeWidth={9} strokeLinecap="round" />
          </g>
        ))}
      </g>
      {sparks.map(({ fold, t }, i) => {
        const f = FOLDS[fold];
        if (!f) return null;
        const head = Math.min(1, t);
        const fade = t > 1 ? 1 - (t - 1) / 0.25 : 1;
        const p = f.at(head);
        const isIdle = i === sparks.length - 1;
        return (
          <g key={i} opacity={fade * (isIdle ? 0.55 : 1)}>
            <path d={f.d} fill="none" stroke="#FFE2A8" strokeWidth={7} strokeLinecap="round" pathLength={1} strokeDasharray="0.4 2" strokeDashoffset={0.4 - head} />
            <circle cx={p.x} cy={p.y} r={30} fill="url(#h-glow-gold)" />
            <circle cx={p.x} cy={p.y} r={8} fill="#FFFFFF" />
          </g>
        );
      })}
    </g>
  );
};

// ---------- plant (potted sprout; a new leaf unfurls on cue) ----------

const LEAF = "M 0 0 C 30 -40 100 -46 146 0 C 100 46 30 40 0 0 Z";
const POT = "M -132 70 L 132 70 L 104 240 Q 100 252 86 252 L -86 252 Q -100 252 -104 240 Z";
const STEM = "M 0 60 C -12 0 16 -70 0 -150";
/** x, y on the stem, angle, size */
const LEAVES: [number, number, number, number][] = [
  [-2, 8, 200, 1.15],
  [2, -18, -22, 1.2],
  [-2, -78, 214, 0.98],
  [4, -104, -38, 0.95],
];

const Leaf: React.FC<{ x: number; y: number; angle: number; s: number }> = ({ x, y, angle, s }) => (
  <g transform={`translate(${x} ${y}) rotate(${angle.toFixed(2)}) scale(${s.toFixed(3)})`}>
    <path d={LEAF} fill="#F5B65A" transform="translate(-2 -3)" />
    <path d={LEAF} fill="url(#h-plant-leaf)" />
    <path d="M 6 0 C 50 -4 100 -3 136 0" fill="none" stroke="#D8F5B8" strokeWidth={4} strokeLinecap="round" opacity={0.65} />
  </g>
);

const PlantObject: React.FC<HeroProps> = ({ frame, cues, since }) => {
  const kick = kickOf(frame, cues, 30);
  const first = cues.length ? Math.min(...cues) : since;
  const unfurl = cues.length ? pop(frame, first, 120, 14) : 1;
  const sway = wave(frame, 150) * 2.5;
  return (
    <g transform="translate(0 6)">
      <defs>
        <linearGradient id="h-plant-leaf" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#A6DE7E" />
          <stop offset="50%" stopColor="#5C9A48" />
          <stop offset="100%" stopColor="#2F5A2C" />
        </linearGradient>
        <linearGradient id="h-plant-pot" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#7A2E10" />
          <stop offset="35%" stopColor="#D9692A" />
          <stop offset="60%" stopColor="#F08A3A" />
          <stop offset="100%" stopColor="#6A260C" />
        </linearGradient>
      </defs>
      <Glow y={-60} r={260} color="green" opacity={0.35 + 0.3 * kick} />
      <Glow y={240} r={260} ry={60} opacity={0.5} />
      <g transform={`rotate(${sway.toFixed(3)} 0 60)`}>
        <path d={STEM} fill="none" stroke="#F5B65A" strokeWidth={18} strokeLinecap="round" transform="translate(-3 -3)" />
        <path d={STEM} fill="none" stroke="#4E8A3E" strokeWidth={15} strokeLinecap="round" />
        {LEAVES.map(([x, y, a, s], i) => (
          <Leaf key={i} x={x} y={y} angle={a + wave(frame, 80 + i * 9, i * 0.4) * 4} s={s} />
        ))}
        {unfurl > 0.01 && <Leaf x={0} y={-148} angle={-62 - 40 * (1 - Math.min(1, unfurl))} s={0.82 * unfurl} />}
        {kick > 0.01 && <Sparkle x={58} y={-232} s={0.5 + 0.4 * kick} opacity={kick} rot={frame * 3} />}
      </g>
      <Lit d={POT} fill="url(#h-plant-pot)" />
      <ellipse cx={0} cy={72} rx={128} ry={20} fill="#2A160A" />
      <rect x={-150} y={48} width={300} height={50} rx={14} fill="#F5B65A" transform="translate(-3 -3)" />
      <rect x={-150} y={48} width={300} height={50} rx={14} fill="url(#h-plant-pot)" />
      <ellipse cx={0} cy={52} rx={136} ry={14} fill="#3A2210" />
      <path d="M -110 120 L -92 226" stroke="#FFD2A0" strokeWidth={9} strokeLinecap="round" opacity={0.35} />
    </g>
  );
};

// ---------- lab flask (bubbling liquid) ----------

const FLASK = "M -44 -212 L -44 -72 L -196 160 Q -224 214 -160 214 L 160 214 Q 224 214 196 160 L 44 -72 L 44 -212 Z";
const FLASK_LEVEL = 24;
const flaskHalfWidth = (y: number) => 44 + ((y + 72) * 152) / 232;
const BUBBLES = (() => {
  const rnd = seeded(77);
  return Array.from({ length: 10 }, () => ({ x: -110 + rnd() * 220, phase: rnd(), speed: 0.7 + rnd() * 0.6, r: 6 + rnd() * 10 }));
})();
const FIZZ = [
  [-14, 0, 9],
  [12, 8, 7],
  [-4, 15, 11],
  [18, 22, 6],
];

const FlaskObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 40);
  const travel = frame * 1.4 + kickTravel(frame, cues, 30) * 3;
  const cue = lastCue(frame, cues);
  const surface: string[] = [];
  for (let x = -230; x <= 230; x += 23) surface.push(`${x},${(FLASK_LEVEL + Math.sin(x / 34 + frame * 0.12) * (3 + 5 * kick)).toFixed(1)}`);
  const range = 200 - FLASK_LEVEL;
  const sw = flaskHalfWidth(FLASK_LEVEL);
  return (
    <g>
      <defs>
        <clipPath id="h-flask-clip">
          <path d={FLASK} />
        </clipPath>
        <linearGradient id="h-flask-liquid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6CF0B4" />
          <stop offset="45%" stopColor="#22B07A" />
          <stop offset="100%" stopColor="#0B5A40" />
        </linearGradient>
      </defs>
      <Glow y={110} r={300} ry={220} color="green" opacity={0.45 + 0.4 * kick} />
      <path d={FLASK} fill="none" stroke="#F5B65A" strokeWidth={24} strokeOpacity={0.18} strokeLinejoin="round" />
      <path d={FLASK} fill="#0E1A22" opacity={0.85} />
      <path d={FLASK} fill="url(#h-glass)" />
      <g clipPath="url(#h-flask-clip)">
        <polygon points={[`-230,240`, ...surface, `230,240`].join(" ")} fill="url(#h-flask-liquid)" />
        <ellipse cx={0} cy={FLASK_LEVEL} rx={sw} ry={13} fill="#A8FFD6" opacity={0.55} />
        {BUBBLES.map((b, i) => {
          const k = ((travel * b.speed + b.phase * range) % range) / range;
          const y = 200 - k * range;
          const half = flaskHalfWidth(y) - 24;
          const x = Math.max(-half, Math.min(half, b.x * (half / 150))) + Math.sin(frame * 0.15 + b.phase * 6) * 5;
          return <circle key={i} cx={x} cy={y} r={b.r * (0.7 + 0.4 * k)} fill="#DDFFF0" fillOpacity={0.25} stroke="#E8FFF6" strokeWidth={3} opacity={Math.min(1, (1 - k) * 5)} />;
        })}
      </g>
      {/* glass: highlights, marks, outline */}
      <path d="M -150 168 L -62 30" stroke="#FFFFFF" strokeWidth={11} strokeLinecap="round" opacity={0.32} />
      <path d="M -26 -196 L -26 -96" stroke="#FFFFFF" strokeWidth={9} strokeLinecap="round" opacity={0.3} />
      {[-20, 40, 100, 160].map((y) => (
        <line key={y} x1={flaskHalfWidth(y) - 48} y1={y} x2={flaskHalfWidth(y) - 18} y2={y} stroke="#EAF6FF" strokeWidth={4} strokeLinecap="round" opacity={0.55} />
      ))}
      <path d={FLASK} fill="none" stroke="#F5B65A" strokeWidth={6} strokeLinejoin="round" transform="translate(-3 -3)" />
      <path d={FLASK} fill="none" stroke="#DDF3FF" strokeWidth={6} strokeLinejoin="round" />
      <rect x={-60} y={-238} width={120} height={28} rx={14} fill="#F5B65A" transform="translate(-3 -3)" />
      <rect x={-60} y={-238} width={120} height={28} rx={14} fill="#B8D4E8" />
      <rect x={-48} y={-232} width={44} height={8} rx={4} fill="#FFFFFF" opacity={0.6} />
      {/* fizz out of the neck on cue */}
      {cue !== null &&
        FIZZ.map(([dx, delay, r], i) => {
          const t = (frame - cue - (delay ?? 0)) / 36;
          if (t <= 0 || t >= 1) return null;
          return <circle key={i} cx={(dx ?? 0) + Math.sin(t * 9 + i) * 8} cy={-236 - t * 80} r={(r ?? 8) * (0.6 + 0.6 * t)} fill="#DDFFF0" fillOpacity={0.2} stroke="#BFFFE0" strokeWidth={3} opacity={1 - t} />;
        })}
    </g>
  );
};

// ---------- virus (spiky particle, slowly turning) ----------

const SPIKES = 14;
const VIRUS_R = 150;
const SURFACE_DOTS = (() => {
  const rnd = seeded(5);
  return Array.from({ length: 7 }, (_, i) => {
    const a = (i / 7) * Math.PI * 2 + rnd() * 0.5;
    const d = 40 + rnd() * 70;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d, r: 10 + rnd() * 6 };
  });
})();

const VirusObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 30);
  const spin = frame * 0.35 + kickTravel(frame, cues, 30) * 1.2;
  const reach = 1 + 0.12 * kick;
  const s = 1 + 0.05 * kick + 0.015 * wave(frame, 60);
  return (
    <g transform={`scale(${s.toFixed(4)})`}>
      <defs>
        <radialGradient id="h-virus-body" cx="36%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#B9D2DE" />
          <stop offset="45%" stopColor="#5E8296" />
          <stop offset="100%" stopColor="#1A2C38" />
        </radialGradient>
        <radialGradient id="h-virus-head" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#FFD2C0" />
          <stop offset="45%" stopColor="#F2553E" />
          <stop offset="100%" stopColor="#8A1A12" />
        </radialGradient>
      </defs>
      <Glow r={320} color="red" opacity={0.35 + 0.4 * kick} />
      <g transform={`rotate(${spin.toFixed(2)})`}>
        {Array.from({ length: SPIKES }, (_, i) => {
          const a = (i / SPIKES) * 360;
          const len = (i % 2 === 0 ? 62 : 52) * reach;
          return (
            <g key={i} transform={`rotate(${a})`}>
              <line x1={0} y1={-VIRUS_R + 10} x2={0} y2={-VIRUS_R - len} stroke="#E86A5A" strokeWidth={13} strokeLinecap="round" />
              <circle cx={-3} cy={-VIRUS_R - len - 3} r={25} fill="#F5B65A" />
              <circle cx={0} cy={-VIRUS_R - len} r={25} fill="url(#h-virus-head)" />
            </g>
          );
        })}
      </g>
      <circle cx={-3} cy={-3} r={VIRUS_R} fill="#F5B65A" />
      <circle r={VIRUS_R} fill="url(#h-virus-body)" />
      <g transform={`rotate(${spin.toFixed(2)})`}>
        {SURFACE_DOTS.map((d, i) => (
          <g key={i}>
            <circle cx={d.x} cy={d.y} r={d.r + 6} fill="#2A3E4C" opacity={0.55} />
            <circle cx={d.x} cy={d.y} r={d.r} fill="url(#h-virus-head)" />
          </g>
        ))}
      </g>
      <circle r={VIRUS_R} fill="url(#h-shade)" opacity={0.7} />
      <ellipse cx={-58} cy={-70} rx={46} ry={24} fill="#FFFFFF" opacity={0.22} transform="rotate(-35 -58 -70)" />
    </g>
  );
};

// ---------- magnet (horseshoe; filings pulled in on cue) ----------

const MAGNET_U = "M -118 40 L -118 -70 A 118 118 0 0 1 118 -70 L 118 40";
const MAGNET_HI = "M -150 30 L -150 -70 A 150 150 0 0 1 -60 -207";
const FIELD = [60, 110, 160].map((d) => `M -118 140 C -118 ${140 + d} 118 ${140 + d} 118 140`);
const FILINGS = (() => {
  const rnd = seeded(23);
  return Array.from({ length: 12 }, (_, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    return { x: side * (60 + rnd() * 190), y: 150 + rnd() * 110, rot: rnd() * 180, side };
  });
})();

/** Pull of the filings: snaps in just after a cue, then drifts back. */
const attract = (frame: number, cues: readonly number[]) => {
  const c = lastCue(frame, cues);
  if (c === null) return 0;
  const t = frame - c;
  return t < 10 ? rise(frame, c, 10) : 1 - rise(frame, c + 22, 40);
};

const MagnetObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 40);
  const pull = attract(frame, cues);
  return (
    <g transform="translate(0 -14)">
      <defs>
        <linearGradient id="h-magnet-red" gradientUnits="userSpaceOnUse" x1="-170" y1="0" x2="170" y2="0">
          <stop offset="0%" stopColor="#8A1620" />
          <stop offset="18%" stopColor="#FF6A5A" />
          <stop offset="45%" stopColor="#D92A34" />
          <stop offset="82%" stopColor="#A01822" />
          <stop offset="100%" stopColor="#5A0A12" />
        </linearGradient>
      </defs>
      <Glow y={-30} r={300} color="red" opacity={0.3 + 0.2 * kick} />
      <Glow y={170} r={240} ry={120} color="cyan" opacity={0.25 + 0.5 * kick} />
      {FIELD.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="#8FD6FF" strokeWidth={5} strokeLinecap="round" strokeDasharray="14 14" strokeDashoffset={-frame * (1.2 + 2 * kick) - i * 9} opacity={0.45 + 0.5 * kick} />
      ))}
      {/* the horseshoe */}
      <path d={MAGNET_U} fill="none" stroke="#F5B65A" strokeWidth={106} strokeOpacity={0.3} transform="translate(-6 -6)" />
      <path d={MAGNET_U} fill="none" stroke="#F5B65A" strokeWidth={98} transform="translate(-3 -3)" />
      <path d={MAGNET_U} fill="none" stroke="url(#h-magnet-red)" strokeWidth={98} />
      <path d={MAGNET_HI} fill="none" stroke="#FFC0B0" strokeWidth={9} strokeLinecap="round" opacity={0.5} />
      <path d="M -86 40 L -86 -70 A 86 86 0 0 1 -30 -150" fill="none" stroke="#5A0A12" strokeWidth={6} strokeLinecap="round" opacity={0.45} />
      {[-1, 1].map((side) => (
        <g key={side}>
          <rect x={side * 118 - 49} y={34} width={98} height={108} rx={8} fill="#F5B65A" transform="translate(-3 -3)" />
          <rect x={side * 118 - 49} y={34} width={98} height={108} rx={8} fill="url(#h-steel)" />
          <rect x={side * 118 - 49} y={34} width={98} height={12} fill="#3A4250" opacity={0.6} />
          <rect x={side * 118 - 34} y={58} width={12} height={72} rx={6} fill="#FFFFFF" opacity={0.55} />
          <ellipse cx={side * 118} cy={142} rx={60} ry={22} fill="url(#h-glow-cyan)" opacity={0.3 + 0.7 * kick} />
        </g>
      ))}
      {FILINGS.map((f, i) => {
        const tx = f.side * 118 + (i % 3 - 1) * 22;
        const ty = 152 + (i % 4) * 6;
        const p = clamp01(pull * (0.85 + 0.15 * ((i * 7) % 3)));
        const x = f.x + (tx - f.x) * p + wave(frame, 40 + i * 5, i) * 2;
        const y = f.y + (ty - f.y) * p;
        const rot = f.rot * (1 - p) + 90 * p;
        return (
          <g key={i} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)})`}>
            <rect x={-12} y={-4} width={24} height={8} rx={4} fill="#C9D3E0" />
            <rect x={-12} y={-4} width={24} height={3} rx={1.5} fill="#FFFFFF" opacity={0.7} />
          </g>
        );
      })}
    </g>
  );
};

// ---------- light bulb (glows brighter on cue) ----------

const BULB = "M -74 120 C -74 72 -160 26 -160 -78 A 160 160 0 1 1 160 -78 C 160 26 74 72 74 120 Z";
const FILAMENT = "M -34 -40 C -30 -78 -18 -78 -14 -40 C -10 -78 2 -78 6 -40 C 10 -78 22 -78 26 -40 C 28 -60 32 -64 34 -40";
const BULB_RAYS = Array.from({ length: 9 }, (_, i) => -160 + i * 40);

const LightbulbObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 40);
  const light = Math.min(1, 0.55 + 0.06 * wave(frame, 40) + 0.03 * wave(frame, 13, 0.3) + 0.6 * kick);
  return (
    <g transform="translate(0 -8)">
      <defs>
        <radialGradient id="h-lightbulb-light" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#FFFBEA" />
          <stop offset="35%" stopColor="#FFE08A" />
          <stop offset="75%" stopColor="#F5A524" stopOpacity={0.7} />
          <stop offset="100%" stopColor="#E8901A" stopOpacity={0.35} />
        </radialGradient>
      </defs>
      <Glow y={-70} r={330} color="gold" opacity={0.35 + 0.6 * light} />
      {BULB_RAYS.map((a, i) => {
        const len = (i % 2 === 0 ? 46 : 32) * (0.6 + 0.6 * kick);
        return (
          <g key={a} transform={`translate(0 -78) rotate(${a})`} opacity={0.3 + 0.7 * kick}>
            <line x1={0} y1={-196} x2={0} y2={-196 - len} stroke="#FFD27A" strokeWidth={10} strokeLinecap="round" />
          </g>
        );
      })}
      <path d={BULB} fill="#1A1208" />
      <path d={BULB} fill="url(#h-lightbulb-light)" opacity={light} />
      <path d={BULB} fill="url(#h-glass)" opacity={0.5} />
      {/* filament on its supports */}
      <path d="M -34 -40 L -26 110 M 34 -40 L 26 110" stroke="#B89A70" strokeWidth={5} fill="none" />
      <Glow y={-56} r={90} ry={60} color="white" opacity={light} />
      <Neon d={FILAMENT} color="#FFF3C8" width={5} />
      {/* glass outline and shine */}
      <path d={BULB} fill="none" stroke="#F5B65A" strokeWidth={7} transform="translate(-3 -3)" />
      <path d={BULB} fill="none" stroke="#FFF1CC" strokeWidth={5} />
      <path d="M -110 -120 A 120 120 0 0 1 -40 -196" fill="none" stroke="#FFFFFF" strokeWidth={14} strokeLinecap="round" opacity={0.55} />
      {/* screw base */}
      {[0, 1, 2, 3].map((i) => {
        const w = i % 2 === 0 ? 156 : 144;
        return (
          <g key={i}>
            <rect x={-w / 2} y={116 + i * 26} width={w} height={26} rx={12} fill="#F5B65A" transform="translate(-3 -3)" />
            <rect x={-w / 2} y={116 + i * 26} width={w} height={26} rx={12} fill="url(#h-steel)" />
          </g>
        );
      })}
      <path d="M -52 220 L 52 220 Q 44 252 0 254 Q -44 252 -52 220 Z" fill="#2A241E" />
      <ellipse cx={-20} cy={232} rx={14} ry={5} fill="#FFFFFF" opacity={0.25} />
    </g>
  );
};

export const SCIENCE_HEROES = {
  atom: { Draw: AtomObject },
  dna: { Draw: DnaObject },
  heart: { Draw: HeartObject },
  brain: { Draw: BrainObject },
  plant: { Draw: PlantObject, scale: 1.12 },
  flask: { Draw: FlaskObject },
  virus: { Draw: VirusObject },
  magnet: { Draw: MagnetObject },
  lightbulb: { Draw: LightbulbObject },
} satisfies Partial<Record<HeroName, HeroArt>>;
