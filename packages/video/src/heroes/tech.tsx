import type React from "react";
import type { HeroName } from "@bytereel/pipeline/planning/hero-catalog";
import { arcPath } from "../geometry";
import { kickOf, pop, pulse, rise, seeded, wave } from "../motion";
import { Glow, Neon, Sparkle, type HeroArt, type HeroProps } from "./kit";

/**
 * Technology heroes: smartphone, laptop, server rack, Wi-Fi signal, shield with a padlock, microchip.
 * Same recipe as the nature objects: dark rich bodies, a warm amber rim light, soft gradient glows.
 */

/** The most recent cue at or before `frame` (null before the first cue). */
const lastCue = (frame: number, cues: readonly number[]): number | null => {
  let best: number | null = null;
  for (const c of cues) if (c <= frame && (best === null || c > best)) best = c;
  return best;
};

/** Rim light: a faint wide amber copy and a bright copy offset up-left, under the body. */
const rimmed = (shape: (fill: string) => React.ReactNode, body: string, glow = 1) => (
  <>
    <g transform="translate(-7 -7)" opacity={0.28 * glow}>
      {shape("#F5A524")}
    </g>
    <g transform="translate(-3.5 -3.5)">{shape("#F5B65A")}</g>
    {shape(body)}
  </>
);

// ---------- smartphone (a chat app on screen; a notification pops on cue) ----------

const phoneBody = (fill: string) => <rect x={-128} y={-245} width={256} height={490} rx={46} fill={fill} />;

const BUBBLES: { x: number; y: number; w: number; h: number; out: boolean; bars: number[] }[] = [
  { x: -98, y: -128, w: 152, h: 50, out: false, bars: [120, 78] },
  { x: -36, y: -64, w: 134, h: 38, out: true, bars: [104] },
  { x: -98, y: -12, w: 172, h: 50, out: false, bars: [140, 96] },
  { x: -20, y: 52, w: 118, h: 38, out: true, bars: [86] },
];

const SmartphoneObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 30);
  const cue = lastCue(frame, cues);
  const age = cue === null ? Infinity : frame - cue;
  const note = cue !== null && age < 75 ? Math.min(1.08, pop(frame, cue, 210, 13)) * (1 - rise(frame, cue + 58, 16)) : 0;
  const buzz = age < 14 ? Math.sin(age * 2.6) * 2.4 * (1 - age / 14) : 0;
  return (
    <g transform={`rotate(${buzz})`}>
      <Glow r={300} ry={330} opacity={0.45 + 0.25 * kick} />
      {rimmed(phoneBody, "url(#h-dark)", 1 + 0.5 * kick)}
      <rect x={-128} y={-245} width={256} height={490} rx={46} fill="none" stroke="url(#h-steel)" strokeWidth={5} opacity={0.7} />
      {/* side buttons */}
      <rect x={127} y={-130} width={7} height={70} rx={3} fill="url(#h-steel)" />
      <rect x={-134} y={-160} width={7} height={42} rx={3} fill="url(#h-steel)" />
      <rect x={-134} y={-104} width={7} height={42} rx={3} fill="url(#h-steel)" />
      {/* screen */}
      <rect x={-112} y={-229} width={224} height={458} rx={32} fill="url(#h-screen)" />
      <ellipse cx={0} cy={0} rx={105} ry={210} fill="url(#h-glow-blue)" opacity={0.45 + 0.12 * wave(frame, 80) + 0.3 * kick} />
      <rect x={-34} y={-220} width={68} height={20} rx={10} fill="#05080D" />
      {/* chat header */}
      <circle cx={-80} cy={-170} r={17} fill="#F5A524" />
      <circle cx={-80} cy={-175} r={6} fill="#FFE2A8" />
      <path d="M -91 -160 A 11 9 0 0 1 -69 -160 Z" fill="#FFE2A8" />
      <rect x={-54} y={-178} width={84} height={10} rx={5} fill="#DCE8F4" />
      <rect x={-54} y={-163} width={50} height={7} rx={3.5} fill="#78C86E" />
      <line x1={-112} y1={-144} x2={112} y2={-144} stroke="#2B4A6B" strokeWidth={2} />
      {/* bubbles */}
      {BUBBLES.map((b, i) => (
        <g key={i}>
          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={18} fill={b.out ? "#F5A524" : "#2B4A6B"} />
          {b.bars.map((w, j) => (
            <rect key={j} x={b.x + 15} y={b.y + 14 + j * 15} width={w} height={8} rx={4} fill={b.out ? "#5A2C0E" : "#BFD6EA"} opacity={0.85} />
          ))}
        </g>
      ))}
      {/* typing dots */}
      <rect x={-98} y={104} width={86} height={40} rx={20} fill="#2B4A6B" />
      {[0, 1, 2].map((i) => (
        <circle key={i} cx={-77 + i * 22} cy={124 - 6 * Math.max(0, Math.sin(frame * 0.22 - i * 0.9))} r={6} fill="#DCE8F4" />
      ))}
      {/* input bar */}
      <rect x={-98} y={160} width={160} height={34} rx={17} fill="#0E1E30" stroke="#2B4A6B" strokeWidth={2} />
      <circle cx={82} cy={177} r={17} fill="#F5A524" />
      <path d="M 75 170 L 91 177 L 75 184 Z" fill="#2A1D12" />
      <rect x={-45} y={209} width={90} height={6} rx={3} fill="#8FA6BF" opacity={0.7} />
      {/* screen glare */}
      <path d="M -112 -60 L 40 -229 L 100 -229 L -112 10 Z" fill="#FFFFFF" opacity={0.05} />
      {/* notification */}
      {note > 0.01 && (
        <g transform={`translate(0 ${-178 - 34 * (1 - note)}) scale(${0.82 + 0.18 * note})`} opacity={Math.min(1, note * 1.6)}>
          <Glow r={170} ry={90} color="gold" opacity={0.7} />
          <rect x={-110} y={-36} width={220} height={72} rx={22} fill="#F7EFE6" />
          <rect x={-96} y={-21} width={42} height={42} rx={12} fill="#F5A524" />
          <path d="M -86 -9 Q -86 -14 -81 -14 L -67 -14 Q -62 -14 -62 -9 L -62 1 Q -62 6 -67 6 L -76 6 L -83 12 L -82 6 Q -86 6 -86 1 Z" fill="#FFFFFF" />
          <rect x={-42} y={-17} width={112} height={11} rx={5.5} fill="#2A1D12" />
          <rect x={-42} y={3} width={80} height={9} rx={4.5} fill="#9A8A78" />
          <circle cx={96} cy={-32} r={13} fill="#E8503A" stroke="#F7EFE6" strokeWidth={4} />
        </g>
      )}
    </g>
  );
};

// ---------- laptop (code on screen; the cursor blinks, a line types in on cue) ----------

type Token = [x: number, w: number, color: string];
const CODE: Token[][] = [
  [[0, 70, "#F5A524"], [84, 118, "#8FD6FF"], [216, 46, "#F7EFE6"]],
  [[32, 92, "#FFD27A"], [138, 150, "#5DB8F0"]],
  [[32, 60, "#78C86E"], [106, 112, "#F7EFE6"]],
  [[64, 130, "#8FD6FF"], [208, 70, "#F5A524"]],
  [[32, 44, "#FFD27A"]],
  [[0, 30, "#F5A524"]],
];
const TYPED: Token[] = [[0, 90, "#78C86E"], [104, 150, "#FFD27A"]];
const TYPED_W = 254;
const CODE_X = -176;
const CODE_Y = -160;
const CODE_STEP = 31;

const lidShape = (fill: string) => <rect x={-232} y={-212} width={464} height={294} rx={22} fill={fill} />;
const baseShape = (fill: string) => <path d="M -252 82 L 252 82 L 294 116 Q 298 130 282 130 L -282 130 Q -298 130 -294 116 Z" fill={fill} />;

const LaptopObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 30);
  const cue = lastCue(frame, cues);
  const typed = cue === null ? 1 : rise(frame, cue + 2, 26);
  const v = typed * TYPED_W;
  const typing = typed > 0 && typed < 1;
  const cursorOn = typing || Math.floor(frame / 15) % 2 === 0;
  const lineY = CODE_Y + CODE.length * CODE_STEP;
  return (
    <g transform="translate(0 40)">
      <Glow y={-60} r={330} ry={250} color="blue" opacity={0.35 + 0.2 * kick} />
      <Glow y={110} r={320} ry={60} opacity={0.5} />
      {rimmed(lidShape, "url(#h-dark)", 1 + 0.5 * kick)}
      <rect x={-212} y={-192} width={424} height={256} rx={10} fill="url(#h-screen)" />
      <ellipse cx={0} cy={-64} rx={200} ry={120} fill="url(#h-glow-blue)" opacity={0.3 + 0.08 * wave(frame, 90) + 0.25 * kick} />
      <circle cx={0} cy={-202} r={4} fill="#3A4A5A" />
      {/* line numbers */}
      <path d={`M -196 ${CODE_Y} L -196 ${lineY + 12}`} stroke="#3E5F82" strokeWidth={10} strokeDasharray={`12 ${CODE_STEP - 12}`} />
      {CODE.map((line, i) =>
        line.map(([x, w, color], j) => <rect key={`${i}-${j}`} x={CODE_X + x} y={CODE_Y + i * CODE_STEP} width={w} height={12} rx={6} fill={color} opacity={0.92} />),
      )}
      {TYPED.map(([x, w, color], j) => {
        const shown = Math.max(0, Math.min(w, v - x));
        return shown > 0.5 ? <rect key={j} x={CODE_X + x} y={lineY} width={shown} height={12} rx={6} fill={color} /> : null;
      })}
      {cursorOn && <rect x={CODE_X + v + 6} y={lineY - 4} width={12} height={20} rx={2} fill="#FFE2A8" />}
      <path d="M -212 -20 L -60 -192 L 10 -192 L -212 60 Z" fill="#FFFFFF" opacity={0.04} />
      {/* base */}
      {rimmed(baseShape, "url(#h-steel)")}
      <rect x={-46} y={82} width={92} height={11} rx={5} fill="#4E5868" />
      <path d="M -250 86 L 250 86" stroke="#FFFFFF" strokeWidth={2.5} opacity={0.6} />
      <path d="M -282 128 L 282 128" stroke="#2A2F38" strokeWidth={3} opacity={0.6} />
    </g>
  );
};

// ---------- server rack (blinking LEDs; a data pulse runs down the units on cue) ----------

const UNITS = [0, 1, 2, 3, 4].map((i) => -226 + i * 86);
const LEDS = (() => {
  const rnd = seeded(77);
  return UNITS.map(() => [0, 1].map(() => ({ period: 12 + Math.floor(rnd() * 30), phase: rnd(), duty: 0.3 + rnd() * 0.5 })));
})();
const LED_COLORS = ["#78C86E", "#F5A524"] as const;
const cabinetShape = (fill: string) => <rect x={-178} y={-252} width={356} height={472} rx={20} fill={fill} />;

const ServerObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 40);
  const cue = lastCue(frame, cues);
  return (
    <g transform="translate(0 10)">
      <defs>
        <linearGradient id="h-server-unit" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4C4036" />
          <stop offset="100%" stopColor="#261D16" />
        </linearGradient>
      </defs>
      <Glow r={330} ry={340} opacity={0.4 + 0.25 * kick} />
      <rect x={-150} y={220} width={36} height={18} rx={4} fill="#1A130D" />
      <rect x={114} y={220} width={36} height={18} rx={4} fill="#1A130D" />
      {rimmed(cabinetShape, "url(#h-dark)", 1 + 0.6 * kick)}
      <rect x={-160} y={-234} width={320} height={436} rx={10} fill="#0A0705" />
      {UNITS.map((y, i) => {
        const hl = cue !== null ? pulse(frame, cue + 4 + i * 6, 18) : 0;
        return (
          <g key={i} transform={`translate(0 ${y})`}>
            <rect x={-152} y={0} width={304} height={76} rx={9} fill="url(#h-server-unit)" />
            <path d="M -144 3 L 144 3" stroke="#F5B65A" strokeWidth={2.5} opacity={0.55 + 0.45 * hl} />
            {(LEDS[i] ?? []).map((l, j) => {
              const on = ((frame / l.period + l.phase) % 1) < l.duty || hl > 0.3;
              const color = LED_COLORS[j] ?? "#78C86E";
              return (
                <g key={j}>
                  {on && <circle cx={-124} cy={26 + j * 24} r={17} fill={`url(#h-glow-${j === 0 ? "green" : "amber"})`} />}
                  <circle cx={-124} cy={26 + j * 24} r={7} fill={color} opacity={on ? 1 : 0.22} />
                </g>
              );
            })}
            <path d="M -92 38 L 76 38" stroke="#0E0A07" strokeWidth={46} strokeDasharray="16 8" />
            {hl > 0.01 && <path d="M -92 38 L 76 38" stroke="#FFD27A" strokeWidth={46} strokeDasharray="16 8" opacity={0.85 * hl} />}
            <rect x={100} y={16} width={22} height={44} rx={6} fill="url(#h-steel)" />
            <circle cx={139} cy={38} r={5} fill="#3A3029" />
          </g>
        );
      })}
      {cue !== null && frame - cue < 46 && (
        <Neon d="M -178 -232 L -178 200" color="#FFD27A" width={5} dash="60 600" dashOffset={-((frame - cue) / 46) * 520 + 60} opacity={1 - rise(frame, cue + 34, 12)} />
      )}
    </g>
  );
};

// ---------- wifi (arcs and a dot; pulses emanate, the arcs light up one by one on cue) ----------

const WIFI_C = 135;
const WIFI_R = [108, 196, 284];
const WIFI_A = 47;
const WIFI_ARCS = WIFI_R.map((r) => arcPath(0, WIFI_C, r, -WIFI_A, WIFI_A));

const WifiObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const cue = lastCue(frame, cues);
  const kick = kickOf(frame, cues, 40);
  return (
    <g>
      <defs>
        <linearGradient id="h-wifi-gold" gradientUnits="userSpaceOnUse" x1="0" y1="-170" x2="0" y2="175">
          <stop offset="0%" stopColor="#FFE7A6" />
          <stop offset="50%" stopColor="#F5A524" />
          <stop offset="100%" stopColor="#C2680F" />
        </linearGradient>
      </defs>
      <Glow y={WIFI_C - 60} r={330} ry={260} opacity={0.45 + 0.3 * kick} />
      {[0, 1].map((k) => {
        const t = ((frame + k * 45) % 90) / 90;
        return <Neon key={k} d={arcPath(0, WIFI_C, 50 + t * 300, -WIFI_A, WIFI_A)} color="#FFD27A" width={5} opacity={0.65 * (1 - t) * Math.min(1, t * 6)} />;
      })}
      {WIFI_ARCS.map((d, i) => {
        const idle = 0.35 * Math.max(0, wave(frame, 100, -i * 0.3));
        const lit = Math.max(idle, cue !== null ? pulse(frame, cue + i * 7, 22) : 0);
        return (
          <g key={i} fill="none" strokeLinecap="round">
            {lit > 0.01 && <path d={d} stroke="#FFC24A" strokeWidth={80} strokeOpacity={0.3 * lit} />}
            <path d={d} stroke="#6A3410" strokeWidth={42} transform="translate(4 7)" />
            <path d={d} stroke="#FFE2A8" strokeWidth={42} transform="translate(-3 -3)" />
            <path d={d} stroke="url(#h-wifi-gold)" strokeWidth={42} />
            {lit > 0.01 && <path d={d} stroke="#FFF1C9" strokeWidth={42} opacity={0.5 * lit} />}
            <path d={d} stroke="#FFF6DD" strokeWidth={12} opacity={0.3 + 0.7 * lit} transform="translate(-2 -4)" />
          </g>
        );
      })}
      <Glow y={WIFI_C} r={120} color="gold" opacity={0.8 + 0.2 * kick} />
      <circle cx={4} cy={WIFI_C + 7} r={38} fill="#6A3410" />
      <circle cx={-3} cy={WIFI_C - 3} r={38} fill="#FFE2A8" />
      <circle cx={0} cy={WIFI_C} r={38} fill="url(#h-sun-core)" />
      <circle cx={-12} cy={WIFI_C - 14} r={10} fill="#FFFFFF" opacity={0.6} />
    </g>
  );
};

// ---------- shield-lock (a shield with a padlock; the shackle clicks shut on cue) ----------

const SHIELD = "M 0 -240 C 60 -205 140 -192 212 -198 L 212 -40 C 212 98 128 190 0 250 C -128 190 -212 98 -212 -40 L -212 -198 C -140 -192 -60 -205 0 -240 Z";
const SHIELD_LEFT = "M 0 -240 C -60 -205 -140 -192 -212 -198 L -212 -40 C -212 98 -128 190 0 250 Z";
const shieldShape = (fill: string) => <path d={SHIELD} fill={fill} />;
const SHACKLE = "M -54 -6 L -54 -62 A 54 54 0 0 1 54 -62 L 54 -6";
const lockBody = (fill: string) => <rect x={-88} y={-14} width={176} height={130} rx={22} fill={fill} />;

const ShieldLockObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const cue = lastCue(frame, cues);
  const age = cue === null ? Infinity : frame - cue;
  // the shackle pops up, then snaps shut 12 frames after the cue
  const lift = age < 12 ? rise(frame, cue ?? 0, 5) : age < 18 ? 1 - rise(frame, (cue ?? 0) + 12, 4) : 0;
  const click = age >= 15 && age < 60 ? (age - 15) / 45 : 0;
  const flash = age >= 15 ? pulse(frame, (cue ?? 0) + 15, 24) : 0;
  const check = age >= 15 && age < 80 ? Math.min(1, pop(frame, (cue ?? 0) + 15, 220, 12)) * (1 - rise(frame, (cue ?? 0) + 66, 14)) : 0;
  return (
    <g>
      <defs>
        <linearGradient id="h-shield-lock-field" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#24456B" />
          <stop offset="100%" stopColor="#0A1626" />
        </linearGradient>
      </defs>
      <Glow r={330} ry={340} opacity={0.45 + 0.35 * flash} />
      {click > 0 && (
        <path d={SHIELD} fill="none" stroke="#FFD27A" strokeWidth={6} opacity={0.8 * (1 - click)} transform={`scale(${1 + 0.22 * click})`} />
      )}
      {rimmed(shieldShape, "url(#h-gold)", 1 + flash)}
      <g transform="scale(0.85)">
        <path d={SHIELD} fill="url(#h-shield-lock-field)" />
        <path d={SHIELD_LEFT} fill="#FFFFFF" opacity={0.06} />
        <path d={SHIELD} fill="none" stroke="#7A4A12" strokeWidth={5} />
      </g>
      <Neon d={SHIELD} color="#FFE2A8" width={3} opacity={0.35 + 0.15 * wave(frame, 90) + 0.5 * flash} />
      {/* padlock */}
      <g transform="translate(0 6)">
        <g transform={`translate(0 ${-30 * lift})`} fill="none" strokeLinecap="round">
          <path d={SHACKLE} stroke="#F5B65A" strokeWidth={26} transform="translate(-3 -3)" />
          <path d={SHACKLE} stroke="url(#h-steel)" strokeWidth={26} />
          <path d="M -44 -62 A 44 44 0 0 1 -10 -105" stroke="#FFFFFF" strokeWidth={5} opacity={0.5} />
        </g>
        {rimmed(lockBody, "url(#h-gold)", 1 + flash)}
        <rect x={-74} y={-2} width={148} height={10} rx={5} fill="#FFF3D0" opacity={0.45} />
        <Glow y={44} r={46} color="gold" opacity={0.5 + 0.2 * wave(frame, 60) + 0.5 * flash} />
        <circle cx={0} cy={38} r={17} fill="#4A2A08" />
        <path d="M -8 44 L 8 44 L 12 84 L -12 84 Z" fill="#4A2A08" />
      </g>
      {check > 0.01 && (
        <g transform={`translate(118 150) scale(${check})`}>
          <Glow r={70} color="green" opacity={0.8} />
          <circle r={36} fill="#4FB35F" stroke="#0B0806" strokeWidth={5} />
          <path d="M -16 1 L -5 13 L 17 -11" fill="none" stroke="#FFFFFF" strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </g>
  );
};

// ---------- chip (a microchip; light pulses run out along the circuit traces) ----------

const rot = ([x, y]: [number, number], k: number): [number, number] => {
  let p: [number, number] = [x, y];
  for (let i = 0; i < k; i++) p = [-p[1], p[0]];
  return p;
};
const TRACE_TOP: [number, number][][] = [
  [[-96, -162], [-96, -186], [-138, -228], [-138, -248]],
  [[-64, -162], [-64, -238]],
  [[0, -162], [0, -200], [26, -226], [26, -252]],
  [[64, -162], [64, -196], [104, -236], [104, -248]],
  [[96, -162], [96, -176], [150, -230]],
];
const TRACES = [0, 1, 2, 3].flatMap((k) => TRACE_TOP.map((t) => t.map((p) => rot(p, k))));
const TRACE_D = TRACES.map((t) => t.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x} ${y}`).join(" ")).join(" ");
const VIA_D = TRACES.map((t) => {
  const end = t[t.length - 1] ?? [0, 0];
  return `M ${end[0] - 9} ${end[1]} a 9 9 0 1 0 18 0 a 9 9 0 1 0 -18 0`;
}).join(" ");
const PIN_X = [-96, -64, -32, 0, 32, 64, 96];
const PIN_D = [0, 1, 2, 3]
  .flatMap((k) =>
    PIN_X.map((x) => {
      const pts = ([[x - 7, -164], [x + 7, -164], [x + 7, -124], [x - 7, -124]] as [number, number][]).map((p) => rot(p, k));
      return `M ${pts.map(([px, py]) => `${px} ${py}`).join(" L ")} Z`;
    }),
  )
  .join(" ");
const pinsShape = (fill: string) => <path d={PIN_D} fill={fill} />;
const packageShape = (fill: string) => <rect x={-130} y={-130} width={260} height={260} rx={20} fill={fill} />;

const ChipObject: React.FC<HeroProps> = ({ frame, cues }) => {
  const kick = kickOf(frame, cues, 36);
  const breathe = 0.5 + 0.5 * wave(frame, 70);
  return (
    <g>
      <defs>
        <linearGradient id="h-chip-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3A2E24" />
          <stop offset="100%" stopColor="#120D08" />
        </linearGradient>
      </defs>
      <Glow r={330} opacity={0.4 + 0.3 * kick} />
      {/* traces: copper base, travelling light pulses, vias */}
      <path d={TRACE_D} fill="none" stroke="#F5A524" strokeWidth={16} strokeOpacity={0.08 + 0.15 * kick} strokeLinecap="round" strokeLinejoin="round" />
      <path d={TRACE_D} fill="none" stroke="#B9741C" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" opacity={0.75 + 0.25 * kick} />
      <Neon d={TRACE_D} color="#FFF3D0" width={8} dash="28 110" dashOffset={-frame * 2.6} />
      {kick > 0.01 && <path d={TRACE_D} fill="none" stroke="#FFE2A8" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" opacity={kick} />}
      <path d={VIA_D} fill="#1A120A" stroke="#F5B65A" strokeWidth={4} />
      {/* pins and package */}
      {rimmed(pinsShape, "url(#h-gold)")}
      {rimmed(packageShape, "url(#h-chip-body)", 1 + kick)}
      <circle cx={-106} cy={-106} r={7} fill="#F5B65A" opacity={0.8} />
      {/* die: gold lid, dark window, glowing core */}
      <rect x={-86} y={-86} width={172} height={172} rx={14} fill="url(#h-gold)" />
      <rect x={-70} y={-70} width={140} height={140} rx={8} fill="#1A120A" />
      <path d="M -34 -20 L -70 -20 M -34 20 L -70 20 M 34 -20 L 70 -20 M 34 20 L 70 20 M -20 -34 L -20 -70 M 20 -34 L 20 -70 M -20 34 L -20 70 M 20 34 L 20 70" stroke="#8A5A1A" strokeWidth={4} />
      <Glow r={90} color="gold" opacity={0.55 + 0.25 * breathe + 0.4 * kick} />
      <rect x={-34} y={-34} width={68} height={68} rx={8} fill="#F5A524" />
      <rect x={-22} y={-22} width={44} height={44} rx={5} fill="#FFE2A8" opacity={0.55 + 0.35 * breathe + 0.3 * kick} />
      <path d="M -130 -80 L -80 -130" stroke="#FFFFFF" strokeWidth={4} opacity={0.12} />
      <Sparkle x={60} y={-60} s={0.4 + 0.5 * kick} opacity={kick} rot={frame * 3} />
    </g>
  );
};

export const TECH_HEROES = {
  smartphone: { Draw: SmartphoneObject },
  laptop: { Draw: LaptopObject },
  server: { Draw: ServerObject },
  wifi: { Draw: WifiObject },
  "shield-lock": { Draw: ShieldLockObject },
  chip: { Draw: ChipObject },
} satisfies Partial<Record<HeroName, HeroArt>>;
