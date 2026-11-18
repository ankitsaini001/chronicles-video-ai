import type React from "react";
import type { HeroName } from "@bytereel/pipeline/planning/hero-catalog";
import { arcPath, spline } from "../geometry";
import { glide, kickOf, pulse, rise, wave } from "../motion";
import { Glow, Neon, Sparkle, type HeroArt, type HeroProps } from "./kit";

/**
 * Time and places heroes: wall clock, desk calendar, map pin, mountain, factory, delivery truck.
 * Same recipe as the nature objects: dark rich bodies, a warm amber rim light, soft gradient glows.
 */

/** The most recent cue at or before `frame` (null before the first cue). */
const lastCue = (frame: number, cues: readonly number[]): number | null => {
  let best: number | null = null;
  for (const c of cues) if (c <= frame && (best === null || c > best)) best = c;
  return best;
};

/** Rim light: a faint wide amber copy and a bright copy offset up-left, under the body. */
const rimmed = (shape: (fill: string) => React.ReactNode, body: string, glow = 1, rim = "#F5B65A") => (
  <>
    <g transform="translate(-7 -7)" opacity={0.28 * glow}>
      {shape("#F5A524")}
    </g>
    <g transform="translate(-3.5 -3.5)">{shape(rim)}</g>
    {shape(body)}
  </>
);

const pts = (p: [number, number][]) => p.map(([x, y]) => `${x},${y}`).join(" ");

// ---------- clock (a wall clock; the hands advance, and spin once on cue) ----------

const HOUR_HAND = "M -11 24 L 11 24 L 7 -106 L 0 -118 L -7 -106 Z";
const MIN_HAND = "M -8 28 L 8 28 L 4.5 -164 L 0 -176 L -4.5 -164 Z";
const bezelShape = (fill: string) => <circle r={242} fill={fill} />;
const CLOCK_NUMBERS: [string, number, number][] = [
  ["12", 0, -140],
  ["3", 142, 0],
  ["6", 0, 142],
  ["9", -142, 0],
];

const ClockObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 36);
  let spin = 0;
  for (const c of cues) spin += 360 * glide(frame, c, 36);
  const minute = 50 + frame * 0.15 + spin;
  const hour = 300 + (frame * 0.15 + spin) / 12;
  const second = frame * 2.4;
  return (
    <g>
      <defs>
        <radialGradient id="h-clock-face" cx="42%" cy="38%" r="70%">
          <stop offset="0%" stopColor="#FFFBF2" />
          <stop offset="70%" stopColor="#F3E3C8" />
          <stop offset="100%" stopColor="#D2B68C" />
        </radialGradient>
        <linearGradient id="h-clock-bezel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6A4428" />
          <stop offset="100%" stopColor="#1E140C" />
        </linearGradient>
      </defs>
      <Glow r={340} opacity={0.5 + 0.3 * kick} />
      {rimmed(bezelShape, "url(#h-clock-bezel)", 1 + kick)}
      <circle r={216} fill="none" stroke="url(#h-gold)" strokeWidth={9} />
      <circle r={210} fill="url(#h-clock-face)" />
      <circle r={196} fill="none" stroke="#8A7258" strokeWidth={10} pathLength={60} strokeDasharray="0.14 0.86" strokeDashoffset={0.07} />
      <circle r={190} fill="none" stroke="#2A1D12" strokeWidth={24} pathLength={12} strokeDasharray="0.07 0.93" strokeDashoffset={0.035} />
      {CLOCK_NUMBERS.map(([n, x, y]) => (
        <text key={n} x={x} y={y} dy={20} textAnchor="middle" fontFamily="Inter" fontWeight={800} fontSize={56} fill="#2A1D12">
          {n}
        </text>
      ))}
      {/* hands with a soft drop shadow */}
      <g opacity={0.22} transform="translate(5 8)">
        <path d={HOUR_HAND} fill="#000" transform={`rotate(${hour})`} />
        <path d={MIN_HAND} fill="#000" transform={`rotate(${minute})`} />
      </g>
      <path d={HOUR_HAND} fill="#2A1D12" transform={`rotate(${hour})`} />
      <path d={MIN_HAND} fill="#2A1D12" transform={`rotate(${minute})`} />
      <g transform={`rotate(${second})`}>
        <path d="M 0 42 L 0 -180" stroke="#E2552F" strokeWidth={5} strokeLinecap="round" />
        <circle cy={34} r={9} fill="#E2552F" />
      </g>
      <circle r={16} fill="url(#h-gold)" />
      <circle r={6} fill="#2A1D12" />
      {/* glass glare */}
      <path d={arcPath(0, 0, 186, 288, 345)} fill="none" stroke="#FFFFFF" strokeWidth={14} strokeLinecap="round" opacity={0.4} />
      <Sparkle x={-120} y={-150} s={0.3 + 0.6 * kick} opacity={kick} rot={frame * 3} />
    </g>
  );
};

// ---------- calendar (a desk calendar page; the page flips over the rings on cue) ----------

const FLIP = 24;
const PAGE_TOP = -190;
const pageShape = (fill: string) => <rect x={-200} y={PAGE_TOP} width={400} height={415} rx={28} fill={fill} />;
const HEADER = "M -200 -162 A 28 28 0 0 1 -172 -190 L 172 -190 A 28 28 0 0 1 200 -162 L 200 -78 L -200 -78 Z";
const RINGS = [-115, 115];

const CalendarPage: React.FC<{ day: number; frame: number }> = ({ day, frame }) => {
  const today = day % 7;
  return (
    <g>
      <rect x={-200} y={PAGE_TOP} width={400} height={415} rx={28} fill="url(#h-calendar-paper)" />
      <path d={HEADER} fill="url(#h-calendar-head)" />
      <path d="M -200 -80 L 200 -80" stroke="#7A3410" strokeWidth={4} opacity={0.5} />
      <rect x={-62} y={-126} width={124} height={16} rx={8} fill="#FFE2A8" opacity={0.9} />
      <text x={0} y={112} textAnchor="middle" fontFamily="Inter" fontWeight={800} fontSize={190} fill="#2A1D12">
        {day}
      </text>
      {[0, 1, 2, 3, 4, 5, 6].map((i) =>
        i === today ? (
          <g key={i}>
            <Glow x={-135 + i * 45} y={176} r={34} color="amber" opacity={0.6 + 0.3 * wave(frame, 50)} />
            <circle cx={-135 + i * 45} cy={176} r={13} fill="#F5A524" />
          </g>
        ) : (
          <circle key={i} cx={-135 + i * 45} cy={176} r={9} fill="#C9B18C" />
        ),
      )}
    </g>
  );
};

const CalendarObject: React.FC<HeroProps> = ({ frame, cues }) => {
  let day = 14;
  let flipT: number | null = null;
  for (const c of cues) {
    if (frame >= c + FLIP) day++;
    else if (frame >= c) flipT = (frame - c) / FLIP;
  }
  const kick = kickOf(frame, cues, 30);
  const eased = flipT === null ? 0 : glide(flipT * FLIP, 0, FLIP);
  const sy = Math.cos(Math.PI * eased);
  return (
    <g transform="translate(0 6)">
      <defs>
        <linearGradient id="h-calendar-paper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFF8EC" />
          <stop offset="100%" stopColor="#E9D7BA" />
        </linearGradient>
        <linearGradient id="h-calendar-head" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F5A524" />
          <stop offset="100%" stopColor="#C8561A" />
        </linearGradient>
      </defs>
      <Glow y={20} r={330} ry={320} opacity={0.5 + 0.25 * kick} />
      {/* the paper stack under the page */}
      <rect x={-188} y={PAGE_TOP + 22} width={376} height={415} rx={28} fill="#8E7656" />
      <rect x={-194} y={PAGE_TOP + 11} width={388} height={415} rx={28} fill="#BFA782" />
      {rimmed(pageShape, "#E9D7BA", 1 + kick)}
      <CalendarPage day={flipT === null ? day : day + 1} frame={frame} />
      {/* the flipping page turns over its top edge */}
      {flipT !== null && (
        <g transform={`translate(0 ${PAGE_TOP}) scale(1 ${sy.toFixed(4)}) translate(0 ${-PAGE_TOP})`} opacity={sy > 0 ? 1 : 1 - rise(eased, 0.55, 0.45)}>
          {sy > 0 ? (
            <CalendarPage day={day} frame={frame} />
          ) : (
            <>
              <rect x={-200} y={PAGE_TOP} width={400} height={415} rx={28} fill="#E2CFAE" />
              <path d={HEADER} fill="#B8641A" />
            </>
          )}
          <rect x={-200} y={PAGE_TOP} width={400} height={415} rx={28} fill="#000" opacity={(1 - Math.abs(sy)) * 0.35} />
        </g>
      )}
      {/* ring binding */}
      {RINGS.map((x) => (
        <g key={x}>
          <ellipse cx={x} cy={-158} rx={14} ry={10} fill="#3A1E08" />
          <path d={`M ${x} -160 L ${x} -226`} stroke="#2A1D12" strokeWidth={22} strokeLinecap="round" />
          <path d={`M ${x} -160 L ${x} -226`} stroke="#9AA6B8" strokeWidth={15} strokeLinecap="round" />
          <path d={`M ${x + 3} -162 L ${x + 3} -224`} stroke="#4E5868" strokeWidth={5} strokeLinecap="round" />
          <path d={`M ${x - 3} -168 L ${x - 3} -220`} stroke="#F4F7FB" strokeWidth={4} strokeLinecap="round" />
        </g>
      ))}
    </g>
  );
};

// ---------- map pin (a pin standing on a folded map; it hops and lands with a ripple on cue) ----------

const PIN = "M 0 150 C -36 86 -118 22 -118 -100 A 118 118 0 1 1 118 -100 C 118 22 36 86 0 150 Z";
const pinShape = (fill: string) => <path d={PIN} fill={fill} />;
const MAP_TOP: [number, number][] = [[-215, 118], [-108, 104], [0, 118], [108, 104], [215, 118]];
const MAP_BOT: [number, number][] = [[-275, 234], [-138, 216], [0, 234], [138, 216], [275, 234]];
const MAP_PANELS = [0, 1, 2, 3].map((i) => pts([MAP_TOP[i]!, MAP_TOP[i + 1]!, MAP_BOT[i + 1]!, MAP_BOT[i]!]));
const MAP_OUTLINE = pts([...MAP_TOP, ...[...MAP_BOT].reverse()]);
const MAP_RIVER = spline([
  { x: -245, y: 206 },
  { x: -150, y: 170 },
  { x: -40, y: 196 },
  { x: 80, y: 150 },
  { x: 200, y: 168 },
  { x: 240, y: 160 },
]).d;
const MAP_ROUTE = spline([
  { x: -205, y: 222 },
  { x: -110, y: 205 },
  { x: -40, y: 166 },
  { x: 0, y: 152 },
]).d;

const MapPinObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const cue = lastCue(frame, cues);
  const age = cue === null ? Infinity : frame - cue;
  const hop = age < 18 ? Math.sin((Math.PI * age) / 18) * 80 : age < 30 ? Math.sin((Math.PI * (age - 18)) / 12) * 18 : 0;
  const squash = age >= 17 && age < 26 ? pulse(frame, (cue ?? 0) + 17, 9) * 0.1 : 0;
  const land = age >= 18 && age < 58 ? (age - 18) / 40 : -1;
  const idle = (frame % 70) / 70;
  return (
    <g>
      <defs>
        <linearGradient id="h-map-pin-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FF9A6A" />
          <stop offset="50%" stopColor="#E8452A" />
          <stop offset="100%" stopColor="#8E2412" />
        </linearGradient>
      </defs>
      <Glow y={-20} r={320} ry={330} opacity={0.45} />
      {/* folded map */}
      <polygon points={MAP_OUTLINE} fill="#F5B65A" transform="translate(-3 -3)" />
      {MAP_PANELS.map((p, i) => (
        <polygon key={i} points={p} fill={i % 2 === 0 ? "#EFE3CC" : "#C9B48F"} />
      ))}
      <ellipse cx={-160} cy={142} rx={36} ry={12} fill="#7FA86A" />
      <ellipse cx={150} cy={204} rx={44} ry={13} fill="#7FA86A" />
      <path d={MAP_RIVER} fill="none" stroke="#5DB8F0" strokeWidth={10} strokeLinecap="round" />
      <path d={MAP_ROUTE} fill="none" stroke="#C8561A" strokeWidth={6} strokeLinecap="round" strokeDasharray="14 10" strokeDashoffset={-frame * 0.8} />
      {/* ripples where the pin stands */}
      <ellipse cx={0} cy={152} rx={40 + idle * 150} ry={(40 + idle * 150) * 0.24} fill="none" stroke="#FFD27A" strokeWidth={4} opacity={0.5 * (1 - idle)} />
      {land >= 0 &&
        [0, 0.25].map((d) => {
          const t = land - d;
          return t > 0 && t < 1 ? <ellipse key={d} cx={0} cy={152} rx={50 + t * 200} ry={(50 + t * 200) * 0.24} fill="none" stroke="#FFE2A8" strokeWidth={6} opacity={0.9 * (1 - t)} /> : null;
        })}
      <ellipse cx={0} cy={153} rx={58 * (1 - hop / 200)} ry={14 * (1 - hop / 200)} fill="#2A1D12" opacity={0.5} />
      {/* the pin */}
      <g transform={`translate(0 ${-hop}) translate(0 150) scale(${1 + squash * 0.6} ${1 - squash}) translate(0 -150)`}>
        {rimmed(pinShape, "url(#h-map-pin-body)")}
        <circle cx={0} cy={-100} r={50} fill="#7A1E0E" opacity={0.35} transform="translate(3 4)" />
        <circle cx={0} cy={-100} r={48} fill="#FFF3E6" />
        <ellipse cx={-62} cy={-150} rx={18} ry={40} fill="#FFFFFF" opacity={0.3} transform="rotate(32 -62 -150)" />
      </g>
    </g>
  );
};

// ---------- mountain (three snow-capped peaks, warm rim light; a sparkle on the summit on cue) ----------

type Poly = [number, number][];
const PEAKS: { lit: Poly; warm: Poly; shade: Poly; snowLit: Poly; snowShade: Poly; rim: string; litFill: string; shadeFill: string }[] = [
  {
    lit: [[-295, 205], [-150, -62], [-120, 205]],
    warm: [[-295, 205], [-150, -62], [-230, 205]],
    shade: [[-150, -62], [-5, 205], [-120, 205]],
    snowLit: [[-150, -62], [-179, -9], [-167, -16], [-157, -2], [-143, -3]],
    snowShade: [[-150, -62], [-143, -3], [-132, -15], [-121, -9]],
    rim: "M -295 205 L -150 -62",
    litFill: "#4A5068",
    shadeFill: "#262A38",
  },
  {
    lit: [[5, 205], [150, -112], [175, 205]],
    warm: [[5, 205], [150, -112], [70, 205]],
    shade: [[150, -112], [295, 205], [175, 205]],
    snowLit: [[150, -112], [121, -49], [133, -57], [143, -42], [155, -42]],
    snowShade: [[150, -112], [155, -42], [166, -56], [179, -49]],
    rim: "M 5 205 L 150 -112",
    litFill: "#4A5068",
    shadeFill: "#262A38",
  },
  {
    lit: [[-210, 205], [-5, -238], [35, 205]],
    warm: [[-210, 205], [-5, -238], [-120, 205]],
    shade: [[-5, -238], [225, 205], [35, 205]],
    snowLit: [[-5, -238], [-54, -132], [-38, -122], [-26, -138], [-12, -114], [6, -114]],
    snowShade: [[-5, -238], [6, -114], [18, -128], [30, -120], [46, -141]],
    rim: "M -210 205 L -5 -238",
    litFill: "url(#h-mountain-lit)",
    shadeFill: "#2B2F3E",
  },
];
const PINES: [number, number, number][] = [
  [-262, 205, 58],
  [-232, 205, 74],
  [-204, 205, 50],
  [196, 205, 54],
  [226, 205, 72],
  [256, 205, 48],
];

const MountainObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 36);
  const drift = wave(frame, 220) * 26;
  return (
    <g>
      <defs>
        <linearGradient id="h-mountain-lit" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7A8098" />
          <stop offset="100%" stopColor="#454A5E" />
        </linearGradient>
      </defs>
      <Glow x={-60} y={-80} r={340} ry={300} color="gold" opacity={0.45 + 0.2 * kick} />
      {PEAKS.map((p, i) => (
        <g key={i}>
          <polygon points={pts(p.lit)} fill={p.litFill} />
          <polygon points={pts(p.warm)} fill="#F5A524" opacity={0.16} />
          <polygon points={pts(p.shade)} fill={p.shadeFill} />
          <polygon points={pts(p.snowLit)} fill="#F4F8FF" />
          <polygon points={pts(p.snowShade)} fill="#B4C4DC" />
          <Neon d={p.rim} color="#F5B65A" width={i === 2 ? 5 : 4} opacity={i === 2 ? 0.95 : 0.7} />
        </g>
      ))}
      {/* mist and ground */}
      <ellipse cx={drift} cy={186} rx={230} ry={28} fill="url(#h-glow-white)" opacity={0.35} />
      <ellipse cx={-drift * 0.7 + 60} cy={150} rx={160} ry={18} fill="url(#h-glow-white)" opacity={0.22} />
      <rect x={-300} y={203} width={600} height={14} rx={7} fill="#120C07" />
      {PINES.map(([x, y, h], i) => (
        <g key={i}>
          <polygon points={`${x},${y - h} ${x - h * 0.3},${y} ${x + h * 0.3},${y}`} fill="#2F5A2C" />
          <path d={`M ${x} ${y - h} L ${x - h * 0.3} ${y}`} stroke="#F5B65A" strokeWidth={2.5} opacity={0.55} />
        </g>
      ))}
      <Sparkle x={-5} y={-238} s={0.45 + 0.8 * kick} opacity={0.35 + 0.65 * kick} rot={frame * 2} />
      <Sparkle x={-40} y={-140} s={0.25 + 0.4 * kick} opacity={0.25 + 0.6 * kick * (0.5 + 0.5 * wave(frame, 20))} rot={-frame * 2} />
      <Sparkle x={150} y={-112} s={0.25 + 0.4 * kick} opacity={0.2 + 0.2 * wave(frame, 60) + 0.5 * kick} rot={frame * 2} />
    </g>
  );
};

// ---------- factory (saw-tooth roof, lit windows, chimneys with rising smoke) ----------

const ROOF = "M -240 2 L -240 -80 L -120 2 L -120 -80 L 0 2 L 0 -80 L 120 2 L 120 -80 L 240 2 Z";
const ROOF_RIM = "M -240 -80 L -120 2 M -120 -80 L 0 2 M 0 -80 L 120 2 M 120 -80 L 240 2";
const roofShape = (fill: string) => <path d={ROOF} fill={fill} />;
const wallShape = (fill: string) => <rect x={-240} y={0} width={480} height={205} fill={fill} />;
const CHIMNEYS: { x: number; w: number; top: number; phase: number }[] = [
  { x: -178, w: 48, top: -205, phase: 0 },
  { x: -96, w: 40, top: -158, phase: 37 },
];
const WINDOWS = [-208, -128, 68, 148];
const SMOKE_PERIOD = 96;

const FactoryObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 40);
  const lit = 0.85 + 0.1 * wave(frame, 40) + 0.15 * kick;
  return (
    <g transform="translate(0 30)">
      <defs>
        <linearGradient id="h-factory-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5A3E2C" />
          <stop offset="100%" stopColor="#2A1D14" />
        </linearGradient>
        <linearGradient id="h-factory-chimney" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#3A2618" />
          <stop offset="40%" stopColor="#8A5A3A" />
          <stop offset="100%" stopColor="#2A1A10" />
        </linearGradient>
      </defs>
      <Glow y={60} r={330} ry={260} opacity={0.45 + 0.25 * kick} />
      {/* smoke */}
      {CHIMNEYS.map((c, ci) =>
        [0, 1, 2, 3, 4].map((i) => {
          const t = ((frame + c.phase + (i * SMOKE_PERIOD) / 5) % SMOKE_PERIOD) / SMOKE_PERIOD;
          const r = (15 + t * 30) * (1 + 0.3 * kick);
          const op = Math.min(1, t * 6) * (1 - t);
          const x = c.x + c.w / 2 + t * 130 + Math.sin(t * 5 + i + ci) * 8;
          const y = c.top - 14 - t * 105;
          return (
            <g key={`${ci}-${i}`}>
              <circle cx={x} cy={y} r={r * 1.7} fill="url(#h-glow-white)" opacity={0.55 * op} />
              <circle cx={x} cy={y} r={r} fill="#D9D1C6" opacity={0.75 * op} />
            </g>
          );
        }),
      )}
      {/* chimneys (behind the roof) */}
      {CHIMNEYS.map((c, i) => (
        <g key={i}>
          <rect x={c.x - 3} y={c.top - 3} width={c.w} height={-c.top + 3} fill="#F5B65A" />
          <rect x={c.x} y={c.top} width={c.w} height={-c.top} fill="url(#h-factory-chimney)" />
          <rect x={c.x} y={c.top + 26} width={c.w} height={14} fill="#F5A524" opacity={0.9} />
          <rect x={c.x - 6} y={c.top - 8} width={c.w + 12} height={14} rx={3} fill="#2A1D14" stroke="#F5B65A" strokeWidth={2.5} />
        </g>
      ))}
      {rimmed(roofShape, "#3A2C22")}
      <Neon d={ROOF_RIM} color="#F5B65A" width={3} opacity={0.8} />
      {rimmed(wallShape, "url(#h-factory-wall)")}
      {/* glazing under each roof tooth */}
      <path d="M -232 -8 L -232 -62 M -112 -8 L -112 -62 M 8 -8 L 8 -62 M 128 -8 L 128 -62" stroke="#FFD27A" strokeWidth={10} opacity={0.75 * lit} />
      {/* lit windows */}
      <Glow y={68} r={300} ry={70} color="gold" opacity={0.4 * lit} />
      {WINDOWS.map((x) => (
        <g key={x}>
          <rect x={x} y={40} width={60} height={54} rx={4} fill="#FFD27A" opacity={lit} />
          <path d={`M ${x + 30} 40 L ${x + 30} 94 M ${x} 67 L ${x + 60} 67`} stroke="#5A3E2C" strokeWidth={5} />
        </g>
      ))}
      {/* roll-up door */}
      <rect x={-50} y={88} width={100} height={117} fill="url(#h-steel)" />
      <path d="M -50 100 L 50 100 M -50 116 L 50 116 M -50 132 L 50 132 M -50 148 L 50 148 M -50 164 L 50 164 M -50 180 L 50 180 M -50 196 L 50 196" stroke="#5A6474" strokeWidth={3} />
      <rect x={-58} y={82} width={116} height={10} rx={3} fill="#2A1D14" />
      <rect x={-270} y={203} width={540} height={12} rx={6} fill="#120C07" />
    </g>
  );
};

// ---------- truck (a delivery truck driving: wheels turn, road dashes move; it speeds up on cue) ----------

const TRUCK_V = 9;
const BOOST = 16;
const BOOST_LEN = 30;
const boxShape = (fill: string) => <rect x={-270} y={-168} width={340} height={260} rx={14} fill={fill} />;
const CAB = "M 80 92 L 80 -96 Q 80 -108 92 -108 L 178 -108 Q 194 -108 202 -94 L 246 -16 Q 256 0 256 18 L 256 92 Z";
const cabShape = (fill: string) => <path d={CAB} fill={fill} />;
const WHEELS = [-190, -96, 170];
const SPOKES = [0, 72, 144, 216, 288].map((a) => {
  const r = (a * Math.PI) / 180;
  return `M ${(Math.cos(r) * 9).toFixed(1)} ${(Math.sin(r) * 9).toFixed(1)} L ${(Math.cos(r) * 23).toFixed(1)} ${(Math.sin(r) * 23).toFixed(1)}`;
}).join(" ");

const TruckObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, BOOST_LEN);
  let dist = TRUCK_V * frame;
  for (const c of cues) {
    const tau = Math.max(0, Math.min(1, (frame - c) / BOOST_LEN));
    if (frame >= c) dist += BOOST * (BOOST_LEN / 2) * (1 - (1 - tau) * (1 - tau));
  }
  const wheelAngle = ((dist / 46) * 180) / Math.PI;
  const bounce = wave(frame, 9) * 1.6 * (1 + kick);
  return (
    <g transform="translate(0 -10)">
      <defs>
        <linearGradient id="h-truck-box" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFC45A" />
          <stop offset="55%" stopColor="#E8901A" />
          <stop offset="100%" stopColor="#B8600F" />
        </linearGradient>
        <linearGradient id="h-truck-cab" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFF8EC" />
          <stop offset="100%" stopColor="#C9B593" />
        </linearGradient>
        <linearGradient id="h-truck-road" gradientUnits="userSpaceOnUse" x1="-300" y1="0" x2="300" y2="0">
          <stop offset="0%" stopColor="#FFD27A" stopOpacity={0} />
          <stop offset="20%" stopColor="#FFD27A" stopOpacity={0.9} />
          <stop offset="80%" stopColor="#FFD27A" stopOpacity={0.9} />
          <stop offset="100%" stopColor="#FFD27A" stopOpacity={0} />
        </linearGradient>
      </defs>
      <Glow y={20} r={330} ry={240} opacity={0.4 + 0.2 * kick} />
      {/* road */}
      <ellipse cx={0} cy={168} rx={310} ry={20} fill="#1E1812" />
      <path d="M -300 170 L 300 170" stroke="url(#h-truck-road)" strokeWidth={6} strokeDasharray="38 26" strokeDashoffset={dist} />
      {/* speed lines on cue */}
      {kick > 0.01 &&
        [-110, -30, 50].map((y, i) => (
          <Neon key={y} d={`M ${-300 - i * 10} ${y} L ${-300 + 70 * kick - i * 10} ${y}`} color="#FFE2A8" width={5} opacity={kick} />
        ))}
      <g transform={`translate(0 ${bounce})`}>
        <rect x={-262} y={86} width={512} height={20} rx={6} fill="#1A140F" />
        {rimmed(boxShape, "url(#h-truck-box)", 1, "#FFE2A8")}
        <path d="M -246 -38 L 54 -38" stroke="#7A3E10" strokeWidth={232} strokeDasharray="4 40" opacity={0.18} />
        <path d="M -262 -160 L 62 -160" stroke="#FFF3D6" strokeWidth={4} strokeLinecap="round" opacity={0.7} />
        {/* parcel symbol */}
        <rect x={-150} y={-86} width={104} height={88} rx={8} fill="#7A3E10" opacity={0.85} />
        <rect x={-106} y={-86} width={16} height={88} fill="#FFD27A" opacity={0.9} />
        <path d="M -150 -64 L -46 -64" stroke="#5A2C0E" strokeWidth={4} />
        {rimmed(cabShape, "url(#h-truck-cab)")}
        <polygon points="100,-90 176,-90 214,-22 100,-22" fill="url(#h-screen)" />
        <path d="M 138 -84 L 112 -40 M 160 -84 L 140 -50" fill="none" stroke="#FFFFFF" strokeWidth={5} opacity={0.3} strokeLinecap="round" />
        <path d="M 92 -10 L 92 80" stroke="#9A8668" strokeWidth={3} />
        <rect x={108} y={4} width={26} height={7} rx={3.5} fill="#7A6A54" />
        <Glow x={262} y={34} r={70} color="gold" opacity={0.8 + 0.2 * kick} />
        <rect x={244} y={22} width={14} height={22} rx={4} fill="#FFE2A8" />
        <rect x={236} y={72} width={30} height={20} rx={6} fill="url(#h-steel)" />
      </g>
      {/* wheels */}
      {WHEELS.map((x) => (
        <g key={x} transform={`translate(${x} 122)`}>
          <circle r={56} fill="#0B0806" />
          <circle r={46} fill="#1A1410" stroke="#F5B65A" strokeWidth={2} strokeOpacity={0.5} />
          <circle r={27} fill="url(#h-steel)" />
          <path d={SPOKES} stroke="#4E5868" strokeWidth={5} strokeLinecap="round" transform={`rotate(${wheelAngle.toFixed(2)})`} />
          <circle r={9} fill="#4E5868" />
        </g>
      ))}
    </g>
  );
};

export const PLACES_HEROES = {
  clock: { Draw: ClockObject },
  calendar: { Draw: CalendarObject },
  "map-pin": { Draw: MapPinObject },
  mountain: { Draw: MountainObject },
  factory: { Draw: FactoryObject },
  truck: { Draw: TruckObject },
} satisfies Partial<Record<HeroName, HeroArt>>;
