import type React from "react";
import type { HeroName } from "@bytereel/pipeline/planning/hero-catalog";
import { clamp01, kickOf, pop, rise, wave } from "../motion";
import { Glow, Neon, Sparkle, type HeroArt, type HeroProps } from "./kit";

/**
 * Generic heroes: target, rocket, trophy, question mark, checklist.
 * Same recipe as the nature objects: dark rich bodies, an amber rim light up-left, soft gradient
 * glows (no filters), one gentle idle motion and a short act when the narration names the object.
 */

/** Rim light: a faint amber halo and a bright amber copy of the silhouette just up-left of the body. */
const Lit: React.FC<{ d: string; fill: string; rim?: string; halo?: number; dx?: number; dy?: number }> = ({ d, fill, rim = "#F5B65A", halo = 0.3, dx = -3, dy = -3 }) => (
  <>
    {halo > 0 && <path d={d} fill={rim} opacity={halo} transform={`translate(${dx * 2} ${dy * 2})`} />}
    <path d={d} fill={rim} transform={`translate(${dx} ${dy})`} />
    <path d={d} fill={fill} />
  </>
);

/** The most recent cue at or before `frame` (or null). */
const lastCue = (frame: number, cues: readonly number[]) => {
  let best: number | null = null;
  for (const c of cues) if (c <= frame && (best === null || c > best)) best = c;
  return best;
};

// ---------- target (an arrow thuds into the bullseye on cue) ----------

const RINGS: [number, string][] = [
  [232, "#D9363E"],
  [186, "#F7EFE6"],
  [140, "#D9363E"],
  [94, "#F7EFE6"],
  [48, "#D9363E"],
];
const ARROW_ANGLE = -36;
const FLIGHT = 9;
const FEATHER = "M 186 -5 L 232 -5 L 284 -44 L 240 -44 Z";

const Arrow: React.FC = () => (
  <g>
    <line x1={0} y1={0} x2={262} y2={0} stroke="#F5B65A" strokeWidth={16} strokeLinecap="round" transform="translate(-2 -3)" />
    <line x1={0} y1={0} x2={262} y2={0} stroke="#7A4A22" strokeWidth={12} strokeLinecap="round" />
    <line x1={20} y1={-3} x2={250} y2={-3} stroke="#D8A060" strokeWidth={3} strokeLinecap="round" />
    {[1, -1].map((s) => (
      <g key={s} transform={`scale(1 ${s})`}>
        <path d={FEATHER} fill="#F5B65A" transform="translate(-2 -3)" />
        <path d={FEATHER} fill={s > 0 ? "#F5A524" : "#D9363E"} />
        <path d="M 236 -6 L 270 -36" stroke="#FFE2A8" strokeWidth={3} strokeLinecap="round" opacity={0.7} />
      </g>
    ))}
    <rect x={258} y={-9} width={22} height={18} rx={6} fill="#3A2614" />
  </g>
);

const TargetObject: React.FC<HeroProps> = ({ frame, cues, since }) => {
  const shot = lastCue(frame, cues.length ? cues : [since + 10]);
  const u = shot === null ? -1 : frame - shot;
  const flying = u >= 0 && u < FLIGHT;
  const after = u - FLIGHT; // frames since the thud
  const d = flying ? 480 * Math.pow(1 - u / FLIGHT, 1.4) : 0;
  const wobble = after >= 0 ? 6 * Math.sin(after * 1.7) * Math.exp(-after / 7) : 0;
  const shake = after >= 0 ? 5 * Math.sin(after * 2.4) * Math.exp(-after / 5) : 0;
  const flash = after >= 0 && after < 16 ? after / 16 : 1;
  return (
    <g>
      <Glow r={330} color="red" opacity={0.3 + 0.06 * wave(frame, 60) + (flash < 1 ? 0.3 * (1 - flash) : 0)} />
      <g transform={`translate(${(shake * 0.6).toFixed(2)} ${shake.toFixed(2)})`}>
        <circle cx={10} cy={14} r={232} fill="#4A0E12" />
        <circle cx={-6} cy={-6} r={232} fill="#F5B65A" opacity={0.3} />
        <circle cx={-3} cy={-3} r={232} fill="#F5B65A" />
        {RINGS.map(([r, c]) => (
          <circle key={r} r={r} fill={c} />
        ))}
        <circle r={232} fill="url(#h-shade)" opacity={0.55} />
        <path d="M -190 -60 A 200 200 0 0 1 -70 -190" fill="none" stroke="#FFFFFF" strokeWidth={12} strokeLinecap="round" opacity={0.28} />
        {flash < 1 && <circle r={30 + 110 * flash} fill="none" stroke="#FFE2A8" strokeWidth={8} opacity={1 - flash} />}
        {u >= FLIGHT && <circle r={11} fill="#2A0A0C" />}
      </g>
      {u >= 0 && (
        <g transform={`rotate(${ARROW_ANGLE + wobble})`} opacity={flying ? Math.min(1, u / 3 + 0.3) : 1}>
          <g transform={`translate(${d.toFixed(1)} 0)`}>
            <Arrow />
          </g>
        </g>
      )}
    </g>
  );
};

// ---------- rocket (flame flickers, streaks rush past) ----------

const ROCKET_TILT = 38;
const ROCKET_BODY = "M 0 -250 C 64 -204 92 -120 92 -20 L 84 118 L -84 118 L -92 -20 C -92 -120 -64 -204 0 -250 Z";
const FIN = "M -84 6 C -142 36 -172 100 -166 172 C -142 152 -112 138 -84 132 Z";
const FIN_MID = "M -13 70 L 13 70 L 15 172 Q 0 184 -15 172 Z";
const NOZZLE = "M -56 116 L 56 116 L 70 154 L -70 154 Z";
/** World (-3,-3) rim offset expressed in the tilted rocket's own coordinates. */
const RIM = (() => {
  const t = (ROCKET_TILT * Math.PI) / 180;
  return { x: -3 * Math.cos(t) - 3 * Math.sin(t), y: 3 * Math.sin(t) - 3 * Math.cos(t) };
})();
const STREAKS: [number, number, number][] = [
  [-150, 0, 1],
  [-118, 70, 0.8],
  [128, 30, 0.9],
  [162, 110, 1.1],
  [-178, 140, 0.7],
  [190, 10, 0.75],
];

const flame = (len: number, w: number) => `M ${-w} 150 C ${-w} ${150 + len * 0.45} ${-w * 0.35} ${150 + len * 0.8} 0 ${150 + len} C ${w * 0.35} ${150 + len * 0.8} ${w} ${150 + len * 0.45} ${w} 150 Z`;

const RocketObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 40);
  const flick = 1 + 0.12 * Math.sin(frame * 1.7) + 0.08 * Math.sin(frame * 2.9 + 1) + 0.05 * Math.sin(frame * 5.3);
  const len = (110 + 90 * kick) * flick;
  const jx = Math.sin(frame * 2.3) * 4 * kick;
  const jy = Math.cos(frame * 3.1) * 4 * kick;
  const speed = 9 + 14 * kick;
  return (
    <g transform={`translate(${(jx - 6).toFixed(2)} ${(jy + 8).toFixed(2)}) rotate(${ROCKET_TILT})`}>
      <defs>
        <clipPath id="h-rocket-clip">
          <path d={ROCKET_BODY} />
        </clipPath>
        <linearGradient id="h-rocket-hull" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#7A8498" />
          <stop offset="32%" stopColor="#F4F6FA" />
          <stop offset="62%" stopColor="#D6DCE6" />
          <stop offset="100%" stopColor="#5A6478" />
        </linearGradient>
        <linearGradient id="h-rocket-red" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#8A1820" />
          <stop offset="35%" stopColor="#FF6A4A" />
          <stop offset="70%" stopColor="#D9363E" />
          <stop offset="100%" stopColor="#6A0E16" />
        </linearGradient>
      </defs>
      {/* speed streaks and exhaust puffs behind */}
      {STREAKS.map(([x, off, w], i) => (
        <line key={i} x1={x} y1={-200} x2={x} y2={320} stroke="#FFE2A8" strokeWidth={4 * w} strokeLinecap="round" strokeDasharray="56 170" strokeDashoffset={-(frame * speed * w + off)} opacity={0.3 + 0.35 * kick} />
      ))}
      {[0, 1, 2, 3].map((i) => {
        const t = ((frame * (1.6 + kick) + i * 22) % 88) / 88;
        return <circle key={i} cx={Math.sin(i * 2.1) * 26 * t} cy={170 + len * 0.6 + t * 120} r={24 + t * 46} fill="url(#h-glow-white)" opacity={0.6 * (1 - t)} />;
      })}
      <Glow y={150 + len * 0.45} r={len * 0.9 + 40} ry={len * 0.75 + 30} opacity={0.8 + 0.2 * kick} />
      <path d={flame(len, 62)} fill="#E8701A" opacity={0.9} />
      <path d={flame(len * 0.78, 46)} fill="#F5A524" />
      <path d={flame(len * 0.55, 30)} fill="#FFE2A8" />
      <path d={flame(len * 0.32, 15)} fill="#FFFFFF" />
      {/* fins, nozzle, hull */}
      <Lit d={FIN} fill="url(#h-rocket-red)" dx={RIM.x} dy={RIM.y} />
      <g transform="scale(-1 1)">
        <path d={FIN} fill="#F5B65A" transform={`translate(${-RIM.x} ${RIM.y})`} />
        <path d={FIN} fill="url(#h-rocket-red)" />
      </g>
      <path d={NOZZLE} fill="url(#h-steel)" />
      <path d={NOZZLE} fill="#1A1E26" opacity={0.45} />
      <Lit d={ROCKET_BODY} fill="url(#h-rocket-hull)" dx={RIM.x} dy={RIM.y} />
      <g clipPath="url(#h-rocket-clip)">
        <rect x={-100} y={-260} width={200} height={122} fill="url(#h-rocket-red)" />
        <rect x={-100} y={-142} width={200} height={8} fill="#5A0E14" opacity={0.5} />
        <rect x={-100} y={64} width={200} height={26} fill="url(#h-rocket-red)" />
      </g>
      <path d={FIN_MID} fill="url(#h-rocket-red)" />
      <path d="M -58 -150 C -66 -90 -66 -20 -62 90" fill="none" stroke="#FFFFFF" strokeWidth={10} strokeLinecap="round" opacity={0.45} />
      {/* window */}
      <circle cx={0} cy={-46} r={52} fill="#F5B65A" />
      <circle cx={0} cy={-46} r={46} fill="url(#h-gold)" />
      <circle cx={0} cy={-46} r={34} fill="url(#h-screen)" />
      <circle cx={0} cy={-46} r={34} fill="url(#h-glow-cyan)" opacity={0.5 + 0.4 * kick} />
      <path d="M -20 -62 A 24 24 0 0 1 4 -72" fill="none" stroke="#FFFFFF" strokeWidth={7} strokeLinecap="round" opacity={0.8} />
    </g>
  );
};

// ---------- trophy (a shine sweeps the cup; sparkles on cue) ----------

const CUP = "M -168 -206 L 168 -206 C 168 -66 110 4 0 6 C -110 4 -168 -66 -168 -206 Z";
const HANDLE = "M -158 -168 C -258 -178 -252 -40 -112 -50";
const STAR = (() => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const r = i % 2 === 0 ? 52 : 22;
    pts.push(`${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r - 112).toFixed(1)}`);
  }
  return pts.join(" ");
})();
/** x, y, delay after the cue, size */
const TROPHY_SPARKLES: [number, number, number, number][] = [
  [-196, -236, 0, 1],
  [214, -178, 4, 0.85],
  [-238, -40, 8, 0.7],
  [226, 30, 2, 0.75],
  [120, -282, 10, 0.6],
  [-96, -290, 6, 0.55],
];

const TrophyObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 30);
  const cue = lastCue(frame, cues);
  const sweep = ((frame * 6) % 760) - 380;
  return (
    <g transform="translate(0 4)">
      <defs>
        <clipPath id="h-trophy-clip">
          <path d={CUP} />
        </clipPath>
        <linearGradient id="h-trophy-gold" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#B86E12" />
          <stop offset="28%" stopColor="#FFE7A6" />
          <stop offset="55%" stopColor="#F5B33A" />
          <stop offset="100%" stopColor="#7A420A" />
        </linearGradient>
      </defs>
      <Glow y={-80} r={320} color="gold" opacity={0.4 + 0.4 * kick + 0.06 * wave(frame, 70)} />
      {/* base */}
      <rect x={-138} y={116} width={276} height={102} rx={14} fill="#F5B65A" transform="translate(-3 -3)" />
      <rect x={-138} y={116} width={276} height={102} rx={14} fill="url(#h-dark)" />
      <rect x={-72} y={144} width={144} height={46} rx={8} fill="url(#h-gold)" />
      <rect x={-56} y={160} width={112} height={6} rx={3} fill="#7A420A" opacity={0.6} />
      <rect x={-56} y={172} width={70} height={6} rx={3} fill="#7A420A" opacity={0.6} />
      <Lit d="M -70 80 L 70 80 L 94 118 L -94 118 Z" fill="url(#h-trophy-gold)" halo={0} />
      <Lit d="M -26 2 L 26 2 L 18 82 L -18 82 Z" fill="url(#h-trophy-gold)" halo={0} />
      <ellipse cx={0} cy={44} rx={34} ry={12} fill="url(#h-trophy-gold)" />
      {/* handles */}
      {[1, -1].map((s) => (
        <g key={s} transform={`scale(${s} 1)`}>
          <path d={HANDLE} fill="none" stroke="#F5B65A" strokeWidth={26} strokeLinecap="round" transform={`translate(${-3 * s} -3)`} />
          <path d={HANDLE} fill="none" stroke="#C47A16" strokeWidth={22} strokeLinecap="round" />
          <path d={HANDLE} fill="none" stroke="#FFE2A8" strokeWidth={6} strokeLinecap="round" opacity={0.6} transform="translate(-4 -4)" />
        </g>
      ))}
      {/* cup */}
      <Lit d={CUP} fill="url(#h-trophy-gold)" />
      <g clipPath="url(#h-trophy-clip)">
        <polygon points={`${sweep},-240 ${sweep + 46},-240 ${sweep - 34},30 ${sweep - 80},30`} fill="#FFFFFF" opacity={0.35} />
      </g>
      <polygon points={STAR} fill="#A5600E" transform="translate(3 4)" opacity={0.7} />
      <polygon points={STAR} fill="url(#h-gold)" />
      <ellipse cx={0} cy={-206} rx={168} ry={28} fill="#FFE2A8" />
      <ellipse cx={0} cy={-203} rx={152} ry={20} fill="#7A420A" />
      <Sparkle x={-120} y={-206} s={0.35 + 0.15 * wave(frame, 50)} opacity={0.5 + 0.4 * wave(frame, 50)} rot={frame * 2} />
      {cue !== null &&
        TROPHY_SPARKLES.map(([x, y, delay, size], i) => {
          const t = frame - cue - delay;
          if (t < 0 || t > 34) return null;
          return <Sparkle key={i} x={x} y={y} s={1.5 * size * pop(frame, cue + delay, 200, 12)} opacity={1 - t / 34} rot={t * 4} />;
        })}
    </g>
  );
};

// ---------- question mark (3D, glowing, bobbing) ----------

const Q_DEPTH = 10;

const QuestionObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 34);
  const bob = wave(frame, 80) * 8;
  const tilt = wave(frame, 120) * 3 + Math.sin(kick * Math.PI * 3) * 6 * kick;
  const s = 1 + 0.08 * kick;
  const glyph = (fill: string, dx: number, dy: number, key: string | number, opacity = 1) => (
    <text key={key} x={dx} y={186 + dy} textAnchor="middle" fontFamily="Inter" fontWeight={800} fontSize={540} fill={fill} opacity={opacity}>
      ?
    </text>
  );
  return (
    <g>
      <defs>
        <linearGradient id="h-question-mark-face" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFF1C8" />
          <stop offset="40%" stopColor="#FFC24A" />
          <stop offset="100%" stopColor="#E8801A" />
        </linearGradient>
      </defs>
      <Glow y={10} r={300} color="gold" opacity={0.45 + 0.4 * kick + 0.08 * wave(frame, 50)} />
      <ellipse cx={0} cy={250} rx={130} ry={18} fill="#000" opacity={0.35} />
      <g transform={`translate(0 ${bob.toFixed(2)}) rotate(${tilt.toFixed(2)}) scale(${s.toFixed(4)})`}>
        {Array.from({ length: Q_DEPTH }, (_, i) => {
          const k = Q_DEPTH - i; // far layers first
          const shade = Math.round(70 + (1 - k / Q_DEPTH) * 70);
          return glyph(`rgb(${shade + 40},${Math.round(shade * 0.55)},${Math.round(shade * 0.12)})`, k * 1.6, k * 2.2, i);
        })}
        {glyph("#FFE2A8", -4, -4, "rim")}
        {glyph("url(#h-question-mark-face)", 0, 0, "face")}
      </g>
      <Sparkle x={150} y={-200 + bob} s={0.35 + 0.5 * kick} opacity={0.4 + 0.6 * kick} rot={frame * 2} />
      <Sparkle x={-150} y={-60 + bob} s={0.25 + 0.4 * kick} opacity={0.3 + 0.6 * kick} rot={-frame * 2} />
    </g>
  );
};

// ---------- checklist (clipboard; ticks draw in one by one) ----------

const ROWS = [-96, 14, 124];
const TICK = "M -24 0 L -6 20 L 34 -30";
const BOARD = "M -196 -226 Q -196 -246 -176 -246 L 176 -246 Q 196 -246 196 -226 L 196 236 Q 196 256 176 256 L -176 256 Q -196 256 -196 236 Z";

const ChecklistObject: React.FC<HeroProps> = ({ frame, cues, since }) => {
  const kick = kickOf(frame, cues, 30);
  // the first tick draws as the list arrives, each cue draws the next; any left tick themselves later
  const later = cues.filter((c) => c > since + 8).sort((a, b) => a - b);
  const tickAt = ROWS.map((_, i) => (i === 0 ? since + 8 : later[i - 1] ?? since + 8 + i * 60));
  return (
    <g>
      <defs>
        <linearGradient id="h-checklist-board" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#A8642A" />
          <stop offset="55%" stopColor="#7A4418" />
          <stop offset="100%" stopColor="#4A280C" />
        </linearGradient>
        <linearGradient id="h-checklist-paper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFFBF4" />
          <stop offset="100%" stopColor="#E6DACA" />
        </linearGradient>
      </defs>
      <Glow r={320} color="amber" opacity={0.35 + 0.3 * kick} />
      <Lit d={BOARD} fill="url(#h-checklist-board)" />
      <rect x={-164} y={-196} width={328} height={420} rx={14} fill="#2A180A" opacity={0.5} transform="translate(6 8)" />
      <rect x={-164} y={-196} width={328} height={420} rx={14} fill="url(#h-checklist-paper)" />
      {/* clip */}
      <rect x={-86} y={-270} width={172} height={66} rx={18} fill="#F5B65A" transform="translate(-3 -3)" />
      <rect x={-86} y={-270} width={172} height={66} rx={18} fill="url(#h-steel)" />
      <circle cx={0} cy={-250} r={13} fill="#2A2018" />
      <rect x={-60} y={-224} width={120} height={10} rx={5} fill="#FFFFFF" opacity={0.45} />
      <rect x={-120} y={-170} width={170} height={20} rx={10} fill="#F5A524" />
      {ROWS.map((y, i) => {
        const at = tickAt[i] ?? Infinity;
        const draw = rise(frame, at, 12);
        const bump = frame >= at ? pop(frame, at, 220, 10) : 0;
        const flash = clamp01(1 - (frame - at) / 20);
        return (
          <g key={y}>
            <g transform={`translate(-102 ${y}) scale(${(1 + 0.12 * Math.max(0, Math.sin(Math.min(1, bump) * Math.PI))).toFixed(4)})`}>
              {draw > 0 && frame - at < 20 && <circle r={70} fill="url(#h-glow-green)" opacity={flash} />}
              <rect x={-32} y={-32} width={64} height={64} rx={13} fill={draw > 0 ? "#E8F6E2" : "#FFFFFF"} stroke="#8A6A4A" strokeWidth={6} />
              {draw > 0 && <Neon d={TICK} color="#2FA34A" width={13} pathLength={1} dash="1 1" dashOffset={1 - draw} />}
            </g>
            <rect x={-46} y={y - 22} width={176} height={18} rx={9} fill={draw > 0 ? "#B9C8B0" : "#CDBFAE"} />
            <rect x={-46} y={y + 8} width={110} height={14} rx={7} fill="#DCD0C0" />
          </g>
        );
      })}
    </g>
  );
};

export const GENERIC_HEROES = {
  target: { Draw: TargetObject },
  rocket: { Draw: RocketObject },
  trophy: { Draw: TrophyObject },
  "question-mark": { Draw: QuestionObject },
  checklist: { Draw: ChecklistObject },
} satisfies Partial<Record<HeroName, HeroArt>>;
