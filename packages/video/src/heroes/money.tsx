import type React from "react";
import type { HeroName } from "@bytereel/pipeline/planning/hero-catalog";
import { kickOf, pulse, rise, wave } from "../motion";
import { Glow, Neon, Sparkle, type HeroArt, type HeroProps } from "./kit";

/**
 * Money and finance heroes (F22b, video style v4): rupee coins, wallet, bank, piggy bank, growth
 * chart, calculator, payment card and house. Same recipe as the nature objects: rich bodies, a warm
 * amber rim light (an amber copy of the silhouette offset up-left), soft gradient glows, no filters.
 */

/** Strongest 0..1..0 bump among the cues (an act that rises and settles back). */
const actOf = (frame: number, cues: readonly number[], len: number) => cues.reduce((v, c) => Math.max(v, pulse(frame, c, len)), 0);

/** The latest cue at or before `frame` that is less than `len` frames old. */
const latestCue = (frame: number, cues: readonly number[], len: number) => [...cues].reverse().find((c) => frame >= c && frame < c + len);

const RUPEE = "₹";

/** A gold rupee coin seen face-on (thickness shows on the right), centred on 0,0. */
const FaceCoin: React.FC<{ r: number; fill: string }> = ({ r, fill }) => {
  const fs = r * 1.15;
  const base = fs * 0.36;
  const edge = r * 0.09;
  return (
    <g>
      <circle cx={edge} r={r} fill="#8A5410" />
      <circle cx={edge * 0.55} r={r} fill="#C9861C" />
      <circle cx={-3} cy={-3} r={r} fill="#FFE2A8" />
      <circle r={r} fill={fill} />
      <circle r={r * 0.8} fill="none" stroke="#B8740F" strokeWidth={Math.max(2.5, r * 0.04)} />
      <circle r={r * 0.8 - Math.max(2.5, r * 0.04)} fill="none" stroke="#FFF0C0" strokeWidth={Math.max(1, r * 0.012)} opacity={0.7} />
      <text x={-2} y={base - 2} textAnchor="middle" fontFamily="Inter" fontWeight={800} fontSize={fs} fill="#FFF6D8">
        {RUPEE}
      </text>
      <text x={3} y={base + 3} textAnchor="middle" fontFamily="Inter" fontWeight={800} fontSize={fs} fill="#7A4508">
        {RUPEE}
      </text>
      <text y={base} textAnchor="middle" fontFamily="Inter" fontWeight={800} fontSize={fs} fill="#D08A1C">
        {RUPEE}
      </text>
    </g>
  );
};

/** Radial gold for a face-on coin (id must be unique per hero). */
const CoinFaceGradient: React.FC<{ id: string }> = ({ id }) => (
  <radialGradient id={id} cx="38%" cy="32%" r="75%">
    <stop offset="0%" stopColor="#FFF6D2" />
    <stop offset="35%" stopColor="#FFD27A" />
    <stop offset="75%" stopColor="#F0A53A" />
    <stop offset="100%" stopColor="#B86E12" />
  </radialGradient>
);

// ---------- coin stack ----------

interface StackSpec {
  x: number;
  /** Top face of the bottom coin. */
  y0: number;
  rx: number;
  ry: number;
  t: number;
}

const COIN_JITTER = [0, 5, -4, 6, -3, 4, -5, 3, 0, 2];

/** One coin of a stack: rim (with reeded edge) and top face, top face centred at x,y. */
const StackCoin: React.FC<{ x: number; y: number; rx: number; ry: number; t: number }> = ({ x, y, rx, ry, t }) => (
  <g>
    <path d={`M ${x - rx} ${y} L ${x - rx} ${y + t} A ${rx} ${ry} 0 0 0 ${x + rx} ${y + t} L ${x + rx} ${y} Z`} fill="url(#h-coin-stack-side)" stroke="#5E3608" strokeWidth={2} />
    <path d={`M ${x - rx + 6} ${y + t / 2 + 4} A ${rx} ${ry} 0 0 0 ${x + rx - 6} ${y + t / 2 + 4}`} fill="none" stroke="#6E400C" strokeWidth={t * 0.42} strokeDasharray="2.5 6" opacity={0.4} />
    <ellipse cx={x} cy={y} rx={rx} ry={ry} fill="url(#h-coin-stack-top)" stroke="#FFE2A8" strokeWidth={2} />
  </g>
);

const Stack: React.FC<StackSpec & { n: number }> = ({ x, y0, rx, ry, t, n }) => (
  <g>
    {Array.from({ length: n }, (_, i) => (
      <StackCoin key={i} x={x + (COIN_JITTER[i] ?? 0)} y={y0 - i * t} rx={rx} ry={ry} t={t} />
    ))}
    {/* the top coin: inner ring and a light catch */}
    <ellipse cx={x + (COIN_JITTER[n - 1] ?? 0)} cy={y0 - (n - 1) * t} rx={rx * 0.74} ry={ry * 0.74} fill="none" stroke="#C27A18" strokeWidth={3} />
    <ellipse cx={x + (COIN_JITTER[n - 1] ?? 0) - rx * 0.3} cy={y0 - (n - 1) * t - ry * 0.25} rx={rx * 0.28} ry={ry * 0.22} fill="#FFFFFF" opacity={0.35} />
  </g>
);

const LEFT_STACK: StackSpec = { x: -118, y0: 186, rx: 100, ry: 28, t: 27 };
const RIGHT_STACK: StackSpec = { x: 130, y0: 176, rx: 92, ry: 26, t: 27 };
const COIN_DROP = 12;

const CoinStackObject: React.FC<HeroProps> = ({ frame, cues }) => {
  // each cue drops one more coin onto the left stack (at most two extra), then it glints
  const landedCues = cues.filter((c) => frame >= c + COIN_DROP);
  const landed = Math.min(2, landedCues.length);
  const falling = landed < 2 ? latestCue(frame, cues, COIN_DROP) : undefined;
  const n = 6 + landed;
  const S = LEFT_STACK;
  const targetY = S.y0 - n * S.t;
  const lastLand = landedCues[landedCues.length - 1];
  const glint = lastLand === undefined ? 0 : pulse(frame, lastLand + COIN_DROP, 22);
  const topY = S.y0 - (n - 1) * S.t;
  const sweep = ((frame + 40) % 110) / 110;
  return (
    <g>
      <defs>
        <linearGradient id="h-coin-stack-side" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#7A4A0E" />
          <stop offset="18%" stopColor="#E3A23A" />
          <stop offset="36%" stopColor="#FFE2A8" />
          <stop offset="62%" stopColor="#E09A2E" />
          <stop offset="100%" stopColor="#6E400C" />
        </linearGradient>
        <linearGradient id="h-coin-stack-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFF2C6" />
          <stop offset="45%" stopColor="#FFCF6E" />
          <stop offset="100%" stopColor="#D88E22" />
        </linearGradient>
        <CoinFaceGradient id="h-coin-stack-face" />
        <clipPath id="h-coin-stack-clip">
          <circle r={158} />
        </clipPath>
      </defs>
      <Glow y={-20} r={330} ry={300} color="gold" opacity={0.42} />
      <ellipse cx={0} cy={238} rx={270} ry={26} fill="#000" opacity={0.45} />
      {/* the big rupee coin standing behind the stacks */}
      <g transform="translate(18 -78)">
        <Glow r={230} color="amber" opacity={0.5 + 0.3 * glint} />
        <FaceCoin r={158} fill="url(#h-coin-stack-face)" />
        <g clipPath="url(#h-coin-stack-clip)">
          <path d={`M ${-260 + sweep * 520} -180 l 60 0 l -90 360 l -60 0 Z`} fill="#FFFFFF" opacity={0.28 * Math.sin(Math.PI * sweep)} />
        </g>
      </g>
      <Stack {...RIGHT_STACK} n={4} />
      <Stack {...S} n={n} />
      {falling !== undefined && (() => {
        const p = (frame - falling) / COIN_DROP;
        const y = -330 + (targetY + 330) * p * p;
        return (
          <g opacity={Math.min(1, p * 4)}>
            <StackCoin x={S.x + (COIN_JITTER[n] ?? 0)} y={y} rx={S.rx} ry={S.ry} t={S.t} />
          </g>
        );
      })()}
      {glint > 0 && <Glow x={S.x} y={topY} r={170} ry={70} color="gold" opacity={glint} />}
      <Sparkle x={S.x + 62} y={topY - 14} s={0.5 + 0.6 * glint} opacity={Math.max(glint, 0.55 * Math.max(0, wave(frame, 70)))} rot={frame * 2} />
      <Sparkle x={-70} y={-205} s={0.55} opacity={0.7 * Math.max(0, wave(frame, 70, 1))} rot={-frame * 2} />
      <Sparkle x={RIGHT_STACK.x + 55} y={RIGHT_STACK.y0 - 3 * RIGHT_STACK.t - 8} s={0.4} opacity={0.6 * Math.max(0, wave(frame, 56, 0.5))} />
    </g>
  );
};

// ---------- wallet ----------

const Note: React.FC<{ x: number; y: number; rot: number; fill: string; ink: string }> = ({ x, y, rot, fill, ink }) => (
  <g transform={`translate(${x} ${y}) rotate(${rot})`}>
    <rect x={-140} y={-78} width={280} height={156} rx={8} fill={fill} stroke={ink} strokeWidth={2} />
    <rect x={-126} y={-64} width={252} height={128} rx={5} fill="none" stroke={ink} strokeWidth={3} opacity={0.5} />
    <circle cx={62} cy={-6} r={40} fill={ink} opacity={0.22} />
    <circle cx={62} cy={-6} r={40} fill="none" stroke={ink} strokeWidth={3} opacity={0.45} />
    <text x={-58} y={14} textAnchor="middle" fontFamily="Inter" fontWeight={800} fontSize={74} fill={ink} opacity={0.85}>
      {RUPEE}
    </text>
  </g>
);

const WalletObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const lift = actOf(frame, cues, 44);
  const bob = wave(frame, 90) * 3;
  const strap = "M 242 2 Q 260 2 260 18 L 260 102 Q 260 118 242 118 L 124 118 A 58 58 0 0 1 124 2 Z";
  return (
    <g transform="translate(0 12)">
      <defs>
        <linearGradient id="h-wallet-leather" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#97592F" />
          <stop offset="55%" stopColor="#6A3A1C" />
          <stop offset="100%" stopColor="#3E200E" />
        </linearGradient>
        <linearGradient id="h-wallet-back" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5A3018" />
          <stop offset="100%" stopColor="#24120A" />
        </linearGradient>
        <linearGradient id="h-wallet-strap" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7A4424" />
          <stop offset="100%" stopColor="#40200E" />
        </linearGradient>
        <linearGradient id="h-wallet-note-green" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#A8DC92" />
          <stop offset="55%" stopColor="#6FAE62" />
          <stop offset="100%" stopColor="#3F7A3C" />
        </linearGradient>
        <linearGradient id="h-wallet-note-violet" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#D9CCF5" />
          <stop offset="100%" stopColor="#8E78C8" />
        </linearGradient>
        <linearGradient id="h-wallet-card" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4FA6E8" />
          <stop offset="100%" stopColor="#174C86" />
        </linearGradient>
      </defs>
      <Glow y={0} r={330} ry={270} opacity={0.42 + 0.2 * lift} />
      <ellipse cx={0} cy={226} rx={262} ry={24} fill="#000" opacity={0.45} />
      {/* back of the wallet (the pocket's far side) */}
      <rect x={-240} y={-102} width={480} height={300} rx={34} fill="#F5B65A" transform="translate(-3 -3)" />
      <rect x={-240} y={-102} width={480} height={300} rx={34} fill="url(#h-wallet-back)" />
      {/* card and cash peeking out */}
      <g transform={`translate(128 ${-104 + bob * 0.6}) rotate(9)`}>
        <rect x={-100} y={-64} width={200} height={128} rx={14} fill="#F5B65A" transform="translate(-3 -3)" />
        <rect x={-100} y={-64} width={200} height={128} rx={14} fill="url(#h-wallet-card)" />
        <rect x={-74} y={-36} width={44} height={34} rx={6} fill="url(#h-gold)" />
        <path d="M -100 10 L 100 -40" stroke="#FFFFFF" strokeWidth={22} opacity={0.12} />
      </g>
      <Note x={-48} y={-112 + bob} rot={6} fill="url(#h-wallet-note-violet)" ink="#4A3480" />
      <g transform={`translate(0 ${-lift * 78})`}>
        <Note x={-92} y={-104 - bob} rot={-7} fill="url(#h-wallet-note-green)" ink="#1E4A20" />
      </g>
      {/* front pocket */}
      <rect x={-250} y={-62} width={500} height={270} rx={36} fill="#F5B65A" transform="translate(-4 -4)" />
      <rect x={-250} y={-62} width={500} height={270} rx={36} fill="url(#h-wallet-leather)" />
      <path d="M -214 -60 L 214 -60" stroke="#E7A56A" strokeWidth={4} strokeLinecap="round" opacity={0.7} />
      <rect x={-234} y={-46} width={468} height={238} rx={24} fill="none" stroke="#F2BE84" strokeWidth={3.5} strokeDasharray="13 9" opacity={0.7} />
      {/* strap with a snap button */}
      <path d={strap} fill="#F5B65A" transform="translate(-3 -3)" />
      <path d={strap} fill="url(#h-wallet-strap)" />
      <path d="M 244 14 L 124 14 A 46 46 0 0 0 124 106 L 244 106" fill="none" stroke="#F2BE84" strokeWidth={3} strokeDasharray="11 8" opacity={0.7} />
      <circle cx={124} cy={60} r={26} fill="#3A1E0C" />
      <circle cx={122} cy={58} r={23} fill="url(#h-gold)" />
      <circle cx={122} cy={58} r={11} fill="#C98420" stroke="#FFF0C0" strokeWidth={2} />
      <Sparkle x={112} y={48} s={0.35 + 0.5 * lift} opacity={0.4 + 0.6 * Math.max(lift, Math.max(0, wave(frame, 80)))} rot={frame * 2} />
      {lift > 0.05 && <Sparkle x={-150} y={-200 - lift * 60} s={0.6 * lift} opacity={lift} rot={-frame * 3} />}
    </g>
  );
};

// ---------- bank ----------

const BANK_COLS = [-180, -60, 60, 180];
const archPath = (x: number, w: number, top: number, bottom: number) =>
  `M ${x - w / 2} ${bottom} L ${x - w / 2} ${top + w / 2} A ${w / 2} ${w / 2} 0 0 1 ${x + w / 2} ${top + w / 2} L ${x + w / 2} ${bottom} Z`;
const BANK_OPENINGS: { x: number; w: number; top: number; bottom: number }[] = [
  { x: -120, w: 52, top: -40, bottom: 92 },
  { x: 0, w: 60, top: 4, bottom: 146 },
  { x: 120, w: 52, top: -40, bottom: 92 },
];

const BankObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 34);
  const light = 0.75 + 0.15 * wave(frame, 70) + 0.4 * kick;
  return (
    <g>
      <defs>
        <linearGradient id="h-bank-stone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F7E8CA" />
          <stop offset="100%" stopColor="#C2A27A" />
        </linearGradient>
        <linearGradient id="h-bank-col" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#7A5C36" />
          <stop offset="30%" stopColor="#E6CFA2" />
          <stop offset="50%" stopColor="#FFF4DC" />
          <stop offset="75%" stopColor="#CDAE7C" />
          <stop offset="100%" stopColor="#64482A" />
        </linearGradient>
        <linearGradient id="h-bank-window" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFF4D2" />
          <stop offset="45%" stopColor="#FFC85A" />
          <stop offset="100%" stopColor="#D97A1A" />
        </linearGradient>
        <linearGradient id="h-bank-tympanum" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4A3220" />
          <stop offset="100%" stopColor="#2A1B10" />
        </linearGradient>
      </defs>
      <Glow y={-10} r={340} ry={300} opacity={0.4 + 0.2 * kick} />
      <ellipse cx={0} cy={236} rx={290} ry={24} fill="#000" opacity={0.5} />
      {/* interior with warm lit windows and door */}
      <rect x={-200} y={-84} width={400} height={234} fill="#1A110A" />
      {BANK_OPENINGS.map((o) => (
        <Glow key={`g${o.x}`} x={o.x} y={(o.top + o.bottom) / 2} r={o.w * 1.5} ry={(o.bottom - o.top) * 0.85} color="gold" opacity={Math.min(1, light * 0.8)} />
      ))}
      {BANK_OPENINGS.map((o) => (
        <g key={o.x}>
          <path d={archPath(o.x, o.w + 10, o.top - 5, o.bottom + 2)} fill="#5A3A1E" />
          <path d={archPath(o.x, o.w, o.top, o.bottom)} fill="url(#h-bank-window)" opacity={Math.min(1, 0.7 + 0.3 * light)} />
          <path d={o.x === 0 ? `M 0 ${o.top + 30} V ${o.bottom}` : `M ${o.x} ${o.top + 4} V ${o.bottom} M ${o.x - o.w / 2} ${o.top + 62} H ${o.x + o.w / 2}`} stroke="#6A4014" strokeWidth={4} />
        </g>
      ))}
      {/* steps */}
      <rect x={-270} y={198} width={540} height={30} rx={4} fill="url(#h-bank-stone)" stroke="#8C7050" strokeWidth={1.5} />
      <rect x={-250} y={172} width={500} height={28} rx={4} fill="url(#h-bank-stone)" stroke="#8C7050" strokeWidth={1.5} />
      <rect x={-230} y={148} width={460} height={26} rx={4} fill="url(#h-bank-stone)" stroke="#8C7050" strokeWidth={1.5} />
      {/* columns */}
      {BANK_COLS.map((x) => (
        <g key={x}>
          <rect x={x - 20} y={-64} width={40} height={198} fill="url(#h-bank-col)" />
          <path d={`M ${x - 8} -58 V 128 M ${x + 7} -58 V 128`} stroke="#8C6A3E" strokeWidth={2.5} opacity={0.55} />
          <rect x={x - 29} y={-82} width={58} height={20} rx={3} fill="url(#h-bank-stone)" stroke="#8C7050" strokeWidth={1.5} />
          <rect x={x - 27} y={132} width={54} height={16} rx={3} fill="url(#h-bank-stone)" stroke="#8C7050" strokeWidth={1.5} />
        </g>
      ))}
      {/* entablature with dentils */}
      <rect x={-244} y={-116} width={488} height={36} fill="#F5B65A" transform="translate(-3 -3)" />
      <rect x={-244} y={-116} width={488} height={36} fill="url(#h-bank-stone)" stroke="#8C7050" strokeWidth={1.5} />
      <path d="M -236 -90 H 236" stroke="#A88A60" strokeWidth={7} strokeDasharray="9 9" />
      {/* pediment */}
      <polygon points="-262,-116 0,-244 262,-116" fill="#F5B65A" transform="translate(-3 -3)" />
      <polygon points="-262,-116 0,-244 262,-116" fill="url(#h-bank-stone)" />
      <polygon points="-202,-126 0,-224 202,-126" fill="url(#h-bank-tympanum)" />
      <Glow y={-162} r={80} color="gold" opacity={0.5 + 0.5 * kick} />
      <g transform={`translate(0 -162) scale(${1 + 0.12 * kick})`}>
        <FaceCoin r={35} fill="url(#h-gold)" />
      </g>
      <Neon d="M -262 -116 L 0 -244 L 262 -116" color="#FFD9A0" width={3} opacity={0.9} />
      <Sparkle x={22} y={-176} s={0.3 + 0.5 * kick} opacity={Math.max(kick, 0.5 * Math.max(0, wave(frame, 70, 1)))} rot={frame * 2} />
    </g>
  );
};

// ---------- piggy bank ----------

const PIG_SLOT_Y = -131;
const PIG_COIN = { x: -24, y: -212, r: 44 };

const PiggyLeg: React.FC<{ x: number; back?: boolean }> = ({ x, back = false }) => (
  <g>
    <rect x={x - 27} y={120} width={54} height={98} rx={20} fill={back ? "#A84862" : "url(#h-piggy-bank-leg)"} />
    <rect x={x - 27} y={198} width={54} height={20} rx={9} fill={back ? "#6E2A3C" : "#9A3E56"} />
  </g>
);

const PiggyBankObject: React.FC<HeroProps> = ({ frame, cues }) => {
  // the coin hovering over the slot drops in on a cue; a new one pops back a second later
  const cue = latestCue(frame, cues, 50);
  const t = cue === undefined ? -1 : frame - cue;
  const DROP = 11;
  let coinY = PIG_COIN.y + wave(frame, 60) * 7;
  let coinOpacity = 1;
  let coinScale = 1;
  if (t >= 0 && t < DROP) {
    const p = t / DROP;
    coinY = PIG_COIN.y + (PIG_SLOT_Y + PIG_COIN.r + 4 - PIG_COIN.y) * p * p;
  } else if (t >= DROP && t < 32) coinOpacity = 0;
  else if (t >= 32) {
    const p = rise(t, 32, 14);
    coinOpacity = p;
    coinScale = 0.6 + 0.4 * p;
  }
  const plop = cue === undefined ? 0 : pulse(frame, cue + DROP, 20);
  const breathe = 1 + 0.012 * wave(frame, 80) + 0.035 * plop;
  return (
    <g>
      <defs>
        <radialGradient id="h-piggy-bank-body" cx="42%" cy="30%" r="78%">
          <stop offset="0%" stopColor="#FFD6DE" />
          <stop offset="40%" stopColor="#F79DB0" />
          <stop offset="80%" stopColor="#D66C87" />
          <stop offset="100%" stopColor="#A84862" />
        </radialGradient>
        <linearGradient id="h-piggy-bank-leg" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#E68AA0" />
          <stop offset="100%" stopColor="#B8506C" />
        </linearGradient>
        <CoinFaceGradient id="h-piggy-bank-coin" />
        <clipPath id="h-piggy-bank-slot-clip">
          <rect x={-300} y={-400} width={600} height={400 + PIG_SLOT_Y} />
        </clipPath>
      </defs>
      <Glow y={10} r={320} ry={270} opacity={0.38} />
      <Glow y={-10} r={250} ry={200} color="red" opacity={0.25} />
      <ellipse cx={0} cy={226} rx={250} ry={24} fill="#000" opacity={0.45} />
      <g transform={`translate(0 218) scale(${1 + 0.02 * plop} ${breathe}) translate(0 -218)`}>
        <PiggyLeg x={-120} back />
        <PiggyLeg x={78} back />
        {/* curly tail */}
        <g transform={`rotate(${wave(frame, 46) * 8} -218 10)`}>
          <path d="M -218 14 C -262 12 -270 -40 -240 -46 C -212 -52 -212 -14 -238 -16" fill="none" stroke="#F5B65A" strokeWidth={15} strokeLinecap="round" transform="translate(-3 -3)" />
          <path d="M -218 14 C -262 12 -270 -40 -240 -46 C -212 -52 -212 -14 -238 -16" fill="none" stroke="#E07A93" strokeWidth={12} strokeLinecap="round" />
        </g>
        {/* far ear */}
        <path d="M 40 -118 C 40 -170 64 -196 98 -194 C 108 -158 96 -128 70 -108 Z" fill="#B8506A" />
        {/* body */}
        <ellipse cx={-12} cy={26} rx={216} ry={162} fill="#F5A524" opacity={0.35} transform="translate(-7 -7)" />
        <ellipse cx={-12} cy={26} rx={216} ry={162} fill="#F5B65A" transform="translate(-3 -3)" />
        <ellipse cx={-12} cy={26} rx={216} ry={162} fill="url(#h-piggy-bank-body)" />
        <ellipse cx={-90} cy={-62} rx={96} ry={42} fill="#FFFFFF" opacity={0.25} transform="rotate(-18 -90 -62)" />
        {/* near ear */}
        <path d="M 84 -112 C 82 -168 112 -200 152 -196 C 164 -152 148 -120 118 -96 Z" fill="#F5B65A" transform="translate(-3 -3)" />
        <path d="M 84 -112 C 82 -168 112 -200 152 -196 C 164 -152 148 -120 118 -96 Z" fill="#F08CA2" />
        <path d="M 98 -118 C 100 -158 118 -180 142 -182 C 148 -152 136 -130 116 -112 Z" fill="#C25B78" />
        {/* face */}
        <ellipse cx={150} cy={34} rx={30} ry={18} fill="#FF7F99" opacity={0.45} />
        <ellipse cx={118} cy={-22} rx={12} ry={15} fill="#2A1218" />
        <circle cx={122} cy={-27} r={4.5} fill="#FFFFFF" />
        <path d="M 150 92 Q 166 102 182 92" fill="none" stroke="#8A3048" strokeWidth={5} strokeLinecap="round" opacity={0.7} />
        <ellipse cx={202} cy={44} rx={36} ry={48} fill="#F5B65A" transform="translate(-3 -3)" />
        <ellipse cx={202} cy={44} rx={36} ry={48} fill="#F7A6B6" stroke="#C25B73" strokeWidth={4} />
        <ellipse cx={198} cy={28} rx={7} ry={11} fill="#8A3048" />
        <ellipse cx={198} cy={60} rx={7} ry={11} fill="#8A3048" />
        <PiggyLeg x={-80} />
        <PiggyLeg x={120} />
        {/* coin slot on the back */}
        <rect x={-76} y={PIG_SLOT_Y - 8} width={104} height={17} rx={8.5} fill="#3A1420" stroke="#F5B65A" strokeWidth={2.5} />
        <path d={`M -68 ${PIG_SLOT_Y + 9} H 20`} stroke="#FFD6DE" strokeWidth={3} strokeLinecap="round" opacity={0.7} />
      </g>
      {plop > 0 && <Glow x={PIG_COIN.x} y={PIG_SLOT_Y} r={120} ry={50} color="gold" opacity={plop} />}
      {coinOpacity > 0 && (
        <g clipPath="url(#h-piggy-bank-slot-clip)">
          <g transform={`translate(${PIG_COIN.x} ${coinY}) scale(${coinScale})`} opacity={coinOpacity}>
            <Glow r={80} color="gold" opacity={0.5} />
            <FaceCoin r={PIG_COIN.r} fill="url(#h-piggy-bank-coin)" />
          </g>
        </g>
      )}
      <Sparkle x={PIG_COIN.x + 70} y={PIG_SLOT_Y - 30} s={0.6 * plop} opacity={plop} rot={frame * 3} />
      <Sparkle x={PIG_COIN.x - 62} y={PIG_SLOT_Y - 16} s={0.45 * plop} opacity={plop} rot={-frame * 3} />
    </g>
  );
};

// ---------- growth chart ----------

const CHART_POINTS = [
  { x: -196, y: 74 },
  { x: -122, y: 26 },
  { x: -52, y: 50 },
  { x: 24, y: -40 },
  { x: 96, y: -66 },
  { x: 176, y: -150 },
];
const CHART_LINE = "M " + CHART_POINTS.map((p) => `${p.x} ${p.y}`).join(" L ");
const CHART_TIP = { x: 196, y: -171, angle: (Math.atan2(-150 + 66, 176 - 96) * 180) / Math.PI };
const CHART_BARS = [
  { x: -170, h: 62 },
  { x: -92, h: 104 },
  { x: -14, h: 134 },
  { x: 64, h: 188 },
  { x: 142, h: 252 },
];
const CHART_BASE = 176;

const GrowthChartObject: React.FC<HeroProps> = ({ frame, cues, since }) => {
  const draw = rise(frame, since + 6, 30);
  const kick = kickOf(frame, cues, 30);
  const cue = latestCue(frame, cues, 26);
  const gleam = cue === undefined ? -1 : (frame - cue) / 26;
  const tip = rise(frame, since + 30, 10) * (1 + 0.3 * kick);
  const green = "#72D86A";
  return (
    <g>
      <defs>
        <linearGradient id="h-growth-chart-bar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFD98A" />
          <stop offset="45%" stopColor="#E8901A" />
          <stop offset="100%" stopColor="#7A3E0C" />
        </linearGradient>
        <linearGradient id="h-growth-chart-card" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor="#33271B" />
          <stop offset="100%" stopColor="#120C07" />
        </linearGradient>
      </defs>
      <Glow y={0} r={340} ry={300} opacity={0.38} />
      {/* card */}
      <rect x={-252} y={-222} width={504} height={444} rx={36} fill="#F5B65A" transform="translate(-4 -4)" />
      <rect x={-252} y={-222} width={504} height={444} rx={36} fill="url(#h-growth-chart-card)" />
      <rect x={-252} y={-222} width={504} height={444} rx={36} fill="none" stroke="#F5B65A" strokeWidth={2} opacity={0.35} />
      {/* grid and axes */}
      <path d="M -214 -116 H 214 M -214 -30 H 214 M -214 56 H 214" stroke="#F7EFE6" strokeWidth={2} strokeDasharray="6 10" opacity={0.14} />
      <path d={`M -214 -180 V ${CHART_BASE} H 214`} fill="none" stroke="#F7EFE6" strokeWidth={4} strokeLinecap="round" opacity={0.55} />
      {/* bars grow in */}
      {CHART_BARS.map((b, i) => {
        const h = b.h * rise(frame, since + i * 4, 20) * (1 + 0.04 * kick * (i / 4));
        return (
          <g key={b.x}>
            <rect x={b.x - 26} y={CHART_BASE - h} width={52} height={h} rx={8} fill="url(#h-growth-chart-bar)" />
            <rect x={b.x - 20} y={CHART_BASE - h + 6} width={10} height={Math.max(0, h - 14)} rx={5} fill="#FFF2D0" opacity={0.3} />
          </g>
        );
      })}
      {/* the rising line draws in, then gleams on a cue */}
      <Glow x={CHART_TIP.x - 10} y={CHART_TIP.y + 10} r={110} color="green" opacity={(0.45 + 0.15 * wave(frame, 60) + 0.4 * kick) * draw} />
      <Neon d={CHART_LINE} color={green} width={10} pathLength={1} dash="1 1" dashOffset={1 - draw} />
      {CHART_POINTS.slice(0, -1).map((p, i) =>
        draw * (CHART_POINTS.length - 1) >= i ? <circle key={i} cx={p.x} cy={p.y} r={9} fill="#120C07" stroke={green} strokeWidth={5} /> : null,
      )}
      {gleam >= 0 && <path d={CHART_LINE} pathLength={1} fill="none" stroke="#F4FFE8" strokeWidth={8} strokeLinecap="round" strokeDasharray="0.12 2" strokeDashoffset={0.12 - gleam * 1.15} />}
      {tip > 0.01 && (
        <g transform={`translate(${CHART_TIP.x} ${CHART_TIP.y}) rotate(${CHART_TIP.angle}) scale(${tip})`}>
          <polygon points="18,0 -30,-26 -20,0 -30,26" fill={green} stroke="#E8FFE0" strokeWidth={3} strokeLinejoin="round" />
        </g>
      )}
      <Sparkle x={CHART_TIP.x + 6} y={CHART_TIP.y - 8} s={0.3 + 0.6 * kick} opacity={kick > 0 ? kick : 0.4 * draw * Math.max(0, wave(frame, 70))} rot={frame * 2} />
    </g>
  );
};

// ---------- calculator ----------

type KeyKind = "num" | "op" | "eq" | "clr";
const CALC_ROWS: [string, KeyKind][][] = [
  [["7", "num"], ["8", "num"], ["9", "num"], ["÷", "op"]],
  [["4", "num"], ["5", "num"], ["6", "num"], ["×", "op"]],
  [["1", "num"], ["2", "num"], ["3", "num"], ["−", "op"]],
  [["C", "clr"], ["0", "num"], ["=", "eq"], ["+", "op"]],
];
const CALC_VALUES = ["1,250", "2,500", "5,000", "10,000", "20,000"];
const KEY = { w: 60, h: 60, gx: 14, gy: 14, x0: -141, y0: -74 };
const KEY_FILL: Record<KeyKind, string> = { num: "url(#h-calculator-key)", op: "url(#h-calculator-op)", eq: "url(#h-calculator-op)", clr: "url(#h-calculator-clr)" };
const KEY_BASE: Record<KeyKind, string> = { num: "#1A120C", op: "#7A3E0C", eq: "#7A3E0C", clr: "#5A1A12" };
const KEY_INK: Record<KeyKind, string> = { num: "#F7EFE6", op: "#3A1C04", eq: "#3A1C04", clr: "#FFE8E0" };

const CalculatorObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 26);
  const pressed = actOf(frame, cues, 12);
  const value = CALC_VALUES[cues.filter((c) => frame >= c).length % CALC_VALUES.length] ?? "0";
  const screen = 0.85 + 0.15 * wave(frame, 75);
  return (
    <g transform="rotate(-7)">
      <defs>
        <linearGradient id="h-calculator-body" x1="0" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#4A3A2C" />
          <stop offset="100%" stopColor="#1C140E" />
        </linearGradient>
        <linearGradient id="h-calculator-key" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6E5C4A" />
          <stop offset="100%" stopColor="#40332A" />
        </linearGradient>
        <linearGradient id="h-calculator-op" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFD98A" />
          <stop offset="100%" stopColor="#E8901A" />
        </linearGradient>
        <linearGradient id="h-calculator-clr" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F07A5E" />
          <stop offset="100%" stopColor="#B8402A" />
        </linearGradient>
        <linearGradient id="h-calculator-lcd" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#24361E" />
          <stop offset="100%" stopColor="#0E180C" />
        </linearGradient>
      </defs>
      <Glow y={0} r={300} ry={330} opacity={0.4} />
      <ellipse cx={8} cy={262} rx={200} ry={20} fill="#000" opacity={0.45} />
      {/* body */}
      <rect x={-178} y={-252} width={356} height={500} rx={42} fill="#F5B65A" transform="translate(-4 -4)" />
      <rect x={-178} y={-252} width={356} height={500} rx={42} fill="url(#h-calculator-body)" />
      <rect x={-166} y={-240} width={332} height={476} rx={32} fill="none" stroke="#FFE2A8" strokeWidth={2} opacity={0.18} />
      {/* solar strip */}
      <rect x={30} y={-236} width={110} height={16} rx={4} fill="#22160E" />
      <path d="M 57 -236 V -220 M 85 -236 V -220 M 112 -236 V -220" stroke="#4A3A2C" strokeWidth={2} />
      {/* display */}
      <rect x={-142} y={-206} width={284} height={104} rx={16} fill="#0A0604" />
      <rect x={-136} y={-200} width={272} height={92} rx={12} fill="url(#h-calculator-lcd)" />
      <Glow x={40} y={-152} r={130} ry={44} color="green" opacity={0.35 * screen + 0.4 * kick} />
      <text x={-118} y={-130} fontFamily="Inter" fontWeight={800} fontSize={30} fill="#A8F0A0" opacity={0.55}>
        {RUPEE}
      </text>
      <text x={124} y={-128} textAnchor="end" fontFamily="Inter" fontWeight={800} fontSize={value.length > 5 ? 54 : 60} fill="#C8FFC0" opacity={0.9 + 0.1 * screen}>
        {value}
      </text>
      <path d="M -126 -190 L 60 -190" stroke="#FFFFFF" strokeWidth={6} strokeLinecap="round" opacity={0.08} />
      {/* keypad */}
      {CALC_ROWS.map((row, r) =>
        row.map(([label, kind], c) => {
          const x = KEY.x0 + c * (KEY.w + KEY.gx);
          const y = KEY.y0 + r * (KEY.h + KEY.gy);
          const press = kind === "eq" ? pressed * 5 : 0;
          return (
            <g key={`${r}-${c}`}>
              {kind === "eq" && <Glow x={x + KEY.w / 2} y={y + KEY.h / 2} r={90} color="gold" opacity={kick} />}
              <rect x={x} y={y + 6} width={KEY.w} height={KEY.h} rx={14} fill={KEY_BASE[kind]} />
              <rect x={x} y={y + press} width={KEY.w} height={KEY.h} rx={14} fill={KEY_FILL[kind]} stroke={kind === "eq" && kick > 0 ? "#FFF4D2" : "none"} strokeWidth={3} />
              <text x={x + KEY.w / 2} y={y + press + KEY.h / 2 + 11} textAnchor="middle" fontFamily="Inter" fontWeight={800} fontSize={30} fill={KEY_INK[kind]}>
                {label}
              </text>
            </g>
          );
        }),
      )}
    </g>
  );
};

// ---------- credit card ----------

const CARD = { w: 470, h: 296, rx: 26 };
const contactlessArc = (r: number) => {
  const a = (40 * Math.PI) / 180;
  return `M ${(r * Math.cos(-a)).toFixed(1)} ${(r * Math.sin(-a)).toFixed(1)} A ${r} ${r} 0 0 1 ${(r * Math.cos(a)).toFixed(1)} ${(r * Math.sin(a)).toFixed(1)}`;
};
const CONTACTLESS = [12, 24, 36].map(contactlessArc);

const CreditCardObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 30);
  const cue = latestCue(frame, cues, 24);
  // a bright shine sweeps across on a cue; a faint one passes now and then
  const idle = (frame % 120) / 50;
  const sweep = cue !== undefined ? (frame - cue) / 24 : idle;
  const shine = cue !== undefined ? 0.5 : 0.18;
  const sx = -330 + sweep * 660;
  const halfW = CARD.w / 2;
  const halfH = CARD.h / 2;
  return (
    <g>
      <defs>
        <linearGradient id="h-credit-card-front" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3C82CC" />
          <stop offset="50%" stopColor="#174382" />
          <stop offset="100%" stopColor="#0A1C40" />
        </linearGradient>
        <linearGradient id="h-credit-card-back" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFDC92" />
          <stop offset="50%" stopColor="#E8A23A" />
          <stop offset="100%" stopColor="#9A5A12" />
        </linearGradient>
        <clipPath id="h-credit-card-clip">
          <rect x={-halfW} y={-halfH} width={CARD.w} height={CARD.h} rx={CARD.rx} />
        </clipPath>
      </defs>
      <Glow y={0} r={340} ry={280} opacity={0.36 + 0.2 * kick} />
      <Glow x={-20} y={40} r={260} ry={200} color="blue" opacity={0.3} />
      {/* a second card behind, showing its magnetic stripe */}
      <g transform="translate(26 -66) rotate(-3)">
        <rect x={-halfW} y={-halfH} width={CARD.w} height={CARD.h} rx={CARD.rx} fill="#F5B65A" transform="translate(-3 -3)" />
        <rect x={-halfW} y={-halfH} width={CARD.w} height={CARD.h} rx={CARD.rx} fill="url(#h-credit-card-back)" />
        <rect x={-halfW} y={-112} width={CARD.w} height={50} fill="#1A120A" />
        <rect x={-halfW} y={-112} width={CARD.w} height={6} fill="#4A3A2C" />
      </g>
      {/* the front card */}
      <g transform="translate(-6 48) rotate(-13)">
        <rect x={-halfW} y={-halfH} width={CARD.w} height={CARD.h} rx={CARD.rx} fill="#F5B65A" transform="translate(-4 -4)" />
        <rect x={-halfW} y={-halfH} width={CARD.w} height={CARD.h} rx={CARD.rx} fill="url(#h-credit-card-front)" />
        <g clipPath="url(#h-credit-card-clip)">
          <polygon points="70,-150 170,-150 -10,150 -110,150" fill="#FFFFFF" opacity={0.07} />
          <polygon points="190,-150 225,-150 45,150 10,150" fill="#8FD6FF" opacity={0.14} />
          <circle cx={200} cy={130} r={150} fill="#FFFFFF" opacity={0.05} />
          {sweep >= 0 && sweep <= 1 && <path d={`M ${sx} -170 l 70 0 l -110 340 l -70 0 Z`} fill="#FFFFFF" opacity={shine * Math.sin(Math.PI * sweep)} />}
        </g>
        <rect x={-halfW} y={-halfH} width={CARD.w} height={CARD.h} rx={CARD.rx} fill="none" stroke="#9FD4FF" strokeWidth={2} opacity={0.4} />
        {/* chip */}
        <rect x={-188} y={-74} width={74} height={56} rx={10} fill="url(#h-gold)" stroke="#8A5410" strokeWidth={2} />
        <path d="M -188 -46 H -114 M -151 -74 V -18 M -169 -74 V -46 M -133 -46 V -18" stroke="#8A5410" strokeWidth={2.5} fill="none" />
        {/* contactless waves */}
        <g transform="translate(-86 -46)">
          {CONTACTLESS.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="#F7EFE6" strokeWidth={6} strokeLinecap="round" opacity={0.45 + 0.55 * Math.max(kick, Math.max(0, wave(frame, 45, -i * 0.35)))} />
          ))}
        </g>
        {/* number, name and expiry */}
        <path d="M -186 40 H 74" stroke="#F7EFE6" strokeWidth={11} strokeLinecap="round" strokeDasharray="0 19 0 19 0 19 0 34" opacity={0.85} />
        <text x={108} y={52} fontFamily="Inter" fontWeight={800} fontSize={34} fill="#F7EFE6" letterSpacing={2}>
          4821
        </text>
        <rect x={-186} y={88} width={160} height={14} rx={7} fill="#F7EFE6" opacity={0.45} />
        <rect x={40} y={88} width={64} height={14} rx={7} fill="#F7EFE6" opacity={0.45} />
        <circle cx={176} cy={-96} r={22} fill="url(#h-gold)" />
        <text x={176} y={-85} textAnchor="middle" fontFamily="Inter" fontWeight={800} fontSize={30} fill="#7A4508">
          {RUPEE}
        </text>
      </g>
      <Sparkle x={150} y={-30} s={0.5 * kick} opacity={kick} rot={frame * 3} />
    </g>
  );
};

// ---------- house ----------

const ROOF = "-264,-48 0,-242 264,-48";
const roofHalf = (y: number) => (264 * (y + 242)) / 194;
const ROOF_ROWS = [-92, -136, -180].map((y) => `M ${-roofHalf(y) + 10} ${y} H ${roofHalf(y) - 10}`).join(" ");
const HOUSE_WINDOWS = [-122, 122];

const HouseObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 34);
  const light = 0.78 + 0.22 * wave(frame, 80) + 0.45 * kick;
  return (
    <g>
      <defs>
        <linearGradient id="h-house-wall" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#E9D2AE" />
          <stop offset="100%" stopColor="#B08A60" />
        </linearGradient>
        <linearGradient id="h-house-roof" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#C2502E" />
          <stop offset="100%" stopColor="#702414" />
        </linearGradient>
        <radialGradient id="h-house-window" cx="50%" cy="45%" r="70%">
          <stop offset="0%" stopColor="#FFF8E0" />
          <stop offset="40%" stopColor="#FFD27A" />
          <stop offset="100%" stopColor="#E8901A" />
        </radialGradient>
        <radialGradient id="h-house-smoke">
          <stop offset="0%" stopColor="#EFE8DE" stopOpacity={0.7} />
          <stop offset="55%" stopColor="#D8CFC4" stopOpacity={0.35} />
          <stop offset="100%" stopColor="#D8CFC4" stopOpacity={0} />
        </radialGradient>
        <linearGradient id="h-house-door" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#6A3A1C" />
          <stop offset="100%" stopColor="#3E1E0C" />
        </linearGradient>
      </defs>
      <Glow y={20} r={340} ry={290} opacity={0.36 + 0.2 * kick} />
      <ellipse cx={0} cy={222} rx={286} ry={26} fill="#000" opacity={0.5} />
      {/* chimney and smoke */}
      {[0, 1, 2].map((i) => {
        const t = ((frame + i * 30) % 90) / 90;
        return <circle key={i} cx={128 + t * 26 + Math.sin(t * 5 + i) * 6} cy={-240 - t * 80} r={18 + t * 26} fill="url(#h-house-smoke)" opacity={Math.sin(Math.PI * Math.min(1, t * 1.3))} />;
      })}
      <rect x={104} y={-212} width={52} height={120} fill="#F5B65A" transform="translate(-3 -3)" />
      <rect x={104} y={-212} width={52} height={120} fill="#8A3A20" />
      <path d="M 104 -186 H 156 M 104 -160 H 156 M 130 -212 V -186 M 118 -186 V -160 M 144 -186 V -160" stroke="#5A2010" strokeWidth={3} />
      <rect x={96} y={-226} width={68} height={18} rx={3} fill="#5A2414" />
      {/* walls */}
      <rect x={-204} y={-64} width={408} height={276} fill="#F5B65A" transform="translate(-3 -3)" />
      <rect x={-204} y={-64} width={408} height={276} fill="url(#h-house-wall)" />
      <rect x={-204} y={-64} width={408} height={30} fill="#000" opacity={0.28} />
      {/* windows */}
      {HOUSE_WINDOWS.map((x) => (
        <Glow key={`g${x}`} x={x} y={36} r={120} ry={110} color="gold" opacity={Math.min(1, light * 0.75)} />
      ))}
      {HOUSE_WINDOWS.map((x) => (
        <g key={x}>
          <rect x={x - 56} y={-20} width={112} height={112} rx={8} fill="#5A3A20" />
          <rect x={x - 47} y={-11} width={94} height={94} rx={4} fill="url(#h-house-window)" opacity={Math.min(1, 0.72 + 0.28 * light)} />
          <path d={`M ${x} -11 V 83 M ${x - 47} 36 H ${x + 47}`} stroke="#5A3A20" strokeWidth={8} />
          <rect x={x - 64} y={90} width={128} height={12} rx={4} fill="#7A5232" />
        </g>
      ))}
      {/* door */}
      <path d="M -44 212 V 96 A 44 44 0 0 1 44 96 V 212 Z" fill="#3A1E0C" />
      <path d="M -36 212 V 98 A 36 36 0 0 1 36 98 V 212 Z" fill="url(#h-house-door)" />
      <path d="M -22 96 A 22 22 0 0 1 22 96 Z" fill="url(#h-house-window)" opacity={Math.min(1, 0.6 + 0.4 * light)} />
      <rect x={-24} y={116} width={48} height={36} rx={4} fill="none" stroke="#2A1206" strokeWidth={3} opacity={0.6} />
      <rect x={-24} y={162} width={48} height={36} rx={4} fill="none" stroke="#2A1206" strokeWidth={3} opacity={0.6} />
      <circle cx={22} cy={158} r={5} fill="#FFD27A" />
      <rect x={-62} y={208} width={124} height={12} rx={4} fill="#8C7050" />
      {/* roof */}
      <polygon points={ROOF} fill="#F5B65A" transform="translate(-4 -4)" />
      <polygon points={ROOF} fill="url(#h-house-roof)" />
      <path d={ROOF_ROWS} stroke="#4A1406" strokeWidth={4} opacity={0.45} />
      <path d="M -264 -48 H 264" stroke="#3A140A" strokeWidth={12} strokeLinecap="round" />
      <Neon d="M -264 -48 L 0 -242 L 264 -48" color="#FFD9A0" width={3} opacity={0.85} />
      {/* round attic window */}
      <Glow y={-124} r={70} color="gold" opacity={Math.min(1, light * 0.7)} />
      <circle cy={-124} r={32} fill="#5A3A20" />
      <circle cy={-124} r={25} fill="url(#h-house-window)" opacity={Math.min(1, 0.72 + 0.28 * light)} />
      <path d="M 0 -149 V -99 M -25 -124 H 25" stroke="#5A3A20" strokeWidth={6} />
      <Sparkle x={-150} y={-14} s={0.45 * kick} opacity={kick} rot={frame * 3} />
    </g>
  );
};

export const MONEY_HEROES = {
  "coin-stack": { Draw: CoinStackObject },
  wallet: { Draw: WalletObject },
  bank: { Draw: BankObject },
  "piggy-bank": { Draw: PiggyBankObject },
  "growth-chart": { Draw: GrowthChartObject },
  calculator: { Draw: CalculatorObject },
  "credit-card": { Draw: CreditCardObject },
  house: { Draw: HouseObject },
} satisfies Partial<Record<HeroName, HeroArt>>;
