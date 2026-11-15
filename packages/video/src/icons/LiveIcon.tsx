import type React from "react";
import type { IconName } from "@bytereel/pipeline/planning/icon-catalog";
import { Icon } from "./Icon";
import { pulse, rise, wave } from "../motion";

/**
 * Small animated icons for the dark theme. Every catalog icon works: twelve have their own subtle
 * motion (sun pulses, drops fall, vapour wisps rise, cloud drifts, waves flow, flame flickers, ...),
 * the rest reuse the original engine's icon art with a gentle pulse. `cues` are the frames where the
 * narration names the object; the icon "acts" for a moment after each cue.
 */

export interface LiveIconProps {
  name: IconName;
  size: number;
  frame: number;
  cues: number[];
  /** label hint: rising vapour, cooling, gathering */
  mode?: { rising?: boolean; cooling?: boolean };
  /** 0..1 how "on" the icon is (dims before reveal) */
  on?: number;
}

const DROP = "M 0 -14 C 4 -7 10 0 10 6 A 10 10 0 0 1 -10 6 C -10 0 -4 -7 0 -14 Z";

/** Strength of the most recent cue (1 right after a cue, fading over `len` frames). */
const cueAmount = (frame: number, cues: number[], len: number) => {
  let v = 0;
  for (const c of cues) if (frame >= c && frame < c + len) v = Math.max(v, 1 - (frame - c) / len);
  return v;
};
const sinceCue = (frame: number, cues: number[]) => {
  let last = -Infinity;
  for (const c of cues) if (c <= frame) last = c;
  return frame - last;
};
const anyCue = (frame: number, cues: number[]) => cues.some((c) => c <= frame);

export const LiveIcon: React.FC<LiveIconProps> = ({ name, size, frame, cues, mode = {}, on = 1 }) => {
  const kick = cueAmount(frame, cues, 22);
  const since = sinceCue(frame, cues);
  const body = drawIcon(name, frame, cues, kick, since, mode);
  if (body === null) {
    // other catalog icons: the original art, with a gentle float and a pulse on each cue
    const bump = pulse(frame, cues.find((c) => frame >= c && frame < c + 20) ?? -99, 20);
    return (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.35 + 0.65 * on }}>
        <div style={{ transform: `scale(${1 + 0.18 * bump}) translateY(${wave(frame, 90) * 2}px)` }}>
          <Icon name={name} size={size * 0.84} />
        </div>
      </div>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ overflow: "visible", opacity: 0.35 + 0.65 * on }}>
      {body}
    </svg>
  );
};

function drawIcon(name: IconName, f: number, cues: number[], kick: number, since: number, mode: { rising?: boolean; cooling?: boolean }): React.ReactNode | null {
  switch (name) {
    case "sun": {
      const s = 1 + 0.22 * kick;
      return (
        <g transform="translate(50 50)">
          <circle r={34 + 18 * kick} fill="#F5A524" opacity={0.18 + 0.25 * kick} />
          <g transform={`rotate(${f * 0.8}) scale(${s})`}>
            {Array.from({ length: 8 }, (_, i) => (
              <rect key={i} x={-3} y={-40} width={6} height={13} rx={3} fill="#FFC24A" transform={`rotate(${i * 45})`} />
            ))}
          </g>
          <circle r={19 * s} fill="#FFD27A" stroke="#F5A524" strokeWidth={4} />
        </g>
      );
    }
    case "raindrop": {
      const raining = since < 60;
      return (
        <g>
          <path d={DROP} fill="#5DB8F0" transform={`translate(50 ${50 + wave(f, 60) * 2}) scale(2.4)`} />
          {raining &&
            [0, 1, 2, 3].map((i) => {
              const t = ((since + i * 6) % 18) / 18;
              return <line key={i} x1={18 + i * 20} y1={-4 + t * 96} x2={16 + i * 20} y2={8 + t * 96} stroke="#BFE9FF" strokeWidth={4} strokeLinecap="round" opacity={(1 - t) * Math.min(1, (60 - since) / 15)} />;
            })}
        </g>
      );
    }
    case "droplets": {
      if (mode.rising) {
        const amount = anyCue(f, cues) ? 1 : 0.4;
        return (
          <g>
            <path d="M 14 86 Q 50 78 86 86" stroke="#5DB8F0" strokeWidth={6} fill="none" strokeLinecap="round" />
            {[0, 1, 2].map((i) => {
              const x = 28 + i * 22;
              const d = `M ${x} 78 C ${x - 10} 62 ${x + 10} 48 ${x} 32 C ${x - 8} 22 ${x + 6} 14 ${x} 6`;
              return (
                <path key={i} d={d} fill="none" stroke={i === 1 ? "#FFE2A8" : "#CFEFFF"} strokeWidth={5} strokeLinecap="round" pathLength={1} strokeDasharray="0.3 0.2" strokeDashoffset={f * (0.02 + 0.03 * kick) + i * 0.17} opacity={amount} />
              );
            })}
          </g>
        );
      }
      return (
        <g>
          <path d={DROP} fill="#5DB8F0" transform={`translate(36 ${46 + wave(f, 50) * 3}) scale(1.8)`} />
          <path d={DROP} fill="#8FD6FF" transform={`translate(66 ${60 + wave(f, 50, 1) * 3}) scale(1.4)`} />
        </g>
      );
    }
    case "cloud": {
      const drift = wave(f, 120) * 5;
      const gather = rise(f, cues[cues.length - 1] ?? Infinity, 18);
      const cloud = (dx: number, s: number, fill: string) => (
        <path d="M -22 14 H 22 A 13 13 0 0 0 24 -12 A 18 18 0 0 0 -10 -18 A 16 16 0 0 0 -22 14 Z" fill={fill} transform={`translate(${50 + dx} 52) scale(${s})`} />
      );
      return (
        <g>
          {cloud(-26 + 16 * gather + drift * 0.5, 0.8, "#A9B3C4")}
          {cloud(26 - 16 * gather - drift * 0.5, 0.8, "#A9B3C4")}
          {cloud(drift, 1.25 + 0.12 * kick, "#F4F1EC")}
        </g>
      );
    }
    case "waves": {
      const speed = 0.08 + 0.12 * kick;
      return (
        <g>
          {[34, 54, 74].map((y, i) => {
            const pts: string[] = [];
            for (let x = 8; x <= 92; x += 4) pts.push(`${x},${(y + Math.sin(x / 9 + f * speed + i) * (4 + 3 * kick)).toFixed(1)}`);
            return <polyline key={y} points={pts.join(" ")} fill="none" stroke={i === 0 ? "#8FD6FF" : "#2F8FD8"} strokeWidth={6} strokeLinecap="round" opacity={1 - i * 0.2} />;
          })}
        </g>
      );
    }
    case "snowflake":
      return (
        <g transform={`translate(50 50) rotate(${f * 0.6}) scale(${1 + 0.15 * kick})`} stroke="#DDF3FF" strokeWidth={6} strokeLinecap="round">
          {[0, 60, 120].map((r) => (
            <g key={r} transform={`rotate(${r})`}>
              <line x1={0} y1={-34} x2={0} y2={34} />
              <line x1={0} y1={-22} x2={-8} y2={-30} />
              <line x1={0} y1={-22} x2={8} y2={-30} />
            </g>
          ))}
        </g>
      );
    case "glass": {
      const level = 58 + wave(f, 45) * 2;
      const drop = since < 24 ? since / 24 : null;
      return (
        <g>
          <path d="M 26 16 H 74 L 67 86 A 6 6 0 0 1 61 91 H 39 A 6 6 0 0 1 33 86 Z" fill="none" stroke="#F7EFE6" strokeWidth={4} strokeLinejoin="round" />
          <path d={`M ${29 + (level - 16) * 0.1} ${level} Q 50 ${level + wave(f, 30) * 3} ${71 - (level - 16) * 0.1} ${level} L 67 86 A 6 6 0 0 1 61 91 H 39 A 6 6 0 0 1 33 86 Z`} fill="#2F8FD8" opacity={0.85} />
          {drop !== null && <path d={DROP} fill="#8FD6FF" transform={`translate(50 ${-6 + drop * 60}) scale(0.9)`} />}
        </g>
      );
    }
    case "layers": {
      const seeping = anyCue(f, cues);
      return (
        <g>
          <rect x={10} y={22} width={80} height={14} rx={5} fill="#5C8A4A" />
          <rect x={10} y={40} width={80} height={20} rx={5} fill="#6B4A2C" />
          <rect x={10} y={64} width={80} height={22} rx={5} fill="#2F8FD8" opacity={0.85} />
          {seeping &&
            [0, 1, 2].map((i) => {
              const t = ((since + i * 9) % 27) / 27;
              return <path key={i} d={DROP} fill="#8FD6FF" transform={`translate(${28 + i * 22} ${30 + t * 40}) scale(0.5)`} opacity={1 - t * 0.5} />;
            })}
        </g>
      );
    }
    case "thermometer": {
      const target = mode.cooling ? 0.2 : 0.85;
      const level = 0.55 + (target - 0.55) * rise(f, cues[0] ?? Infinity, 24);
      const color = level < 0.45 ? "#7CC4FF" : "#FF8A3D";
      return (
        <g>
          <rect x={41} y={10} width={18} height={62} rx={9} fill="none" stroke="#F7EFE6" strokeWidth={4} />
          <circle cx={50} cy={78} r={13} fill={color} stroke="#F7EFE6" strokeWidth={4} />
          <rect x={46} y={70 - 56 * level} width={8} height={56 * level + 4} rx={4} fill={color} />
        </g>
      );
    }
    case "flame": {
      const flick = 1 + 0.06 * Math.sin(f * 0.5) + 0.25 * kick;
      return (
        <g transform={`translate(50 88) scale(${1 + 0.03 * Math.sin(f * 0.7)} ${flick}) translate(-50 -88)`}>
          <path d="M50 8 C58 30 78 40 74 66 a24 24 0 0 1 -48 0 C24 50 36 44 40 30 C46 42 52 40 50 8 Z" fill="#F5A524" />
          <path d="M50 40 C55 52 64 58 62 70 a12 12 0 0 1 -24 0 C38 60 46 56 50 40 Z" fill="#FFE2A8" />
        </g>
      );
    }
    case "wind":
      return (
        <g fill="none" stroke="#CFEFFF" strokeWidth={6} strokeLinecap="round">
          {[30, 50, 70].map((y, i) => (
            <path key={y} d={`M 10 ${y} C 35 ${y - 12} 55 ${y + 10} 90 ${y - 4}`} pathLength={1} strokeDasharray="0.55 0.45" strokeDashoffset={-f * (0.02 + 0.03 * kick) - i * 0.2} />
          ))}
        </g>
      );
    case "globe": {
      const off = ((f * 0.4) % 80) - 40;
      return (
        <g>
          <defs>
            <clipPath id="li-globe">
              <circle cx={50} cy={50} r={38} />
            </clipPath>
          </defs>
          <circle cx={50} cy={50} r={38} fill="#1A6AA8" />
          <g clipPath="url(#li-globe)" fill="#5C8A4A">
            {[off, off + 80, off - 80].map((x, i) => (
              <g key={i} transform={`translate(${x} 0)`}>
                <path d="M 40 22 C 56 18 62 34 52 44 C 46 52 54 62 46 70 C 38 62 30 50 36 38 Z" />
                <path d="M 70 56 C 80 54 84 64 76 70 C 70 72 66 64 70 56 Z" />
              </g>
            ))}
          </g>
          <circle cx={50} cy={50} r={38} fill="none" stroke="#8FD6FF" strokeWidth={3 + 3 * kick} />
        </g>
      );
    }
    default:
      return null;
  }
}
