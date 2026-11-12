import type React from "react";
import { mix, seededRandom, hashString } from "../anim";
import { COLORS, FONT_FAMILY, FONT_SIZE, RADIUS } from "../../../packages/pipeline/src/theme";

export { Icon, iconFor, iconForLabel, ICON_NAMES, type IconName } from "./Icon";

/**
 * Reusable primitives (PIPELINE_DESIGN.md §7): text, label, card, shape, arrow, counter, bar, particles.
 * All are dumb: they draw what their props say. Timing lives in the pattern components.
 */

// ---------- text ----------

export const Text: React.FC<{
  size?: number;
  weight?: number;
  color?: string;
  align?: React.CSSProperties["textAlign"];
  lineHeight?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ size = FONT_SIZE.body, weight = 500, color = COLORS.ink, align = "left", lineHeight = 1.2, style, children }) => (
  <div
    style={{
      fontFamily: FONT_FAMILY,
      fontSize: size,
      fontWeight: weight,
      color,
      textAlign: align,
      lineHeight,
      letterSpacing: size >= 70 ? "-0.02em" : "-0.005em",
      overflowWrap: "break-word",
      ...style,
    }}
  >
    {children}
  </div>
);

// ---------- label / card ----------

/** A rounded label pill. `emphasis` (0..1) tints it with the warm accent. */
export const Label: React.FC<{
  text: string;
  emphasis?: number;
  size?: number;
  maxWidth?: number;
  icon?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ text, emphasis = 0, size = FONT_SIZE.label, maxWidth = 420, icon, style }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 14,
      maxWidth,
      padding: `${Math.round(size * 0.36)}px ${Math.round(size * 0.6)}px`,
      borderRadius: RADIUS.pill,
      background: emphasis > 0 ? blend(COLORS.surface, COLORS.warmSoft, emphasis) : COLORS.surface,
      border: `3px solid ${emphasis > 0 ? blend(COLORS.line, COLORS.warm, emphasis) : COLORS.line}`,
      boxShadow: "0 6px 18px rgba(23,33,59,0.08)",
      ...style,
    }}
  >
    {icon}
    <Text size={size} weight={600} lineHeight={1.15}>
      {text}
    </Text>
  </div>
);

/** A white card with a soft shadow. `emphasis` (0..1) draws a warm border and lifts it slightly. */
export const Card: React.FC<{
  emphasis?: number;
  accent?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ emphasis = 0, accent = COLORS.warm, style, children }) => (
  <div
    style={{
      background: COLORS.surface,
      borderRadius: RADIUS.m,
      border: `4px solid ${emphasis > 0 ? blend(COLORS.line, accent, emphasis) : COLORS.line}`,
      boxShadow: `0 ${8 + emphasis * 10}px ${24 + emphasis * 20}px rgba(23,33,59,${0.08 + emphasis * 0.08})`,
      transform: `scale(${1 + emphasis * 0.03})`,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Circle: React.FC<{ size: number; color: string; style?: React.CSSProperties; children?: React.ReactNode }> = ({
  size,
  color,
  style,
  children,
}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: "50%",
      background: color,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      ...style,
    }}
  >
    {children}
  </div>
);

// ---------- arrow ----------

/**
 * Straight arrow from (x1,y1) to (x2,y2), drawn progressively (`progress` 0..1).
 * Render inside an absolutely positioned full-canvas <svg>.
 */
export const Arrow: React.FC<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  progress: number;
  color?: string;
  width?: number;
  dashed?: boolean;
}> = ({ x1, y1, x2, y2, progress, color = COLORS.inkMuted, width = 8, dashed = false }) => {
  if (progress <= 0) return null;
  const length = Math.hypot(x2 - x1, y2 - y1);
  const head = Math.min(30, length * 0.35);
  const ex = mix(x1, x2, progress);
  const ey = mix(y1, y2, progress);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const shaftEndX = ex - Math.cos(angle) * head * 0.6;
  const shaftEndY = ey - Math.sin(angle) * head * 0.6;
  const left = angle + Math.PI * 0.82;
  const right = angle - Math.PI * 0.82;
  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={shaftEndX}
        y2={shaftEndY}
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={dashed ? `${width * 2} ${width * 1.6}` : undefined}
      />
      <path
        d={`M ${ex} ${ey} L ${ex + Math.cos(left) * head} ${ey + Math.sin(left) * head} L ${ex + Math.cos(right) * head} ${ey + Math.sin(right) * head} Z`}
        fill={color}
        strokeLinejoin="round"
        stroke={color}
        strokeWidth={3}
      />
    </g>
  );
};

// ---------- counter ----------

export interface NumberFormat {
  prefix: string;
  suffix: string;
  decimals: number;
}

/** Infer how to show values from a label, e.g. "Share of Earth's water (%)" -> "97%". */
export function numberFormatFor(label: string, values: readonly number[]): NumberFormat {
  const lower = label.toLowerCase();
  const decimals = values.some((v) => !Number.isInteger(v)) ? 1 : 0;
  if (lower.includes("%") || lower.includes("percent") || lower.includes("प्रतिशत")) return { prefix: "", suffix: "%", decimals };
  if (lower.includes("₹") || lower.includes("rupee") || lower.includes("रुपये")) return { prefix: "₹", suffix: "", decimals };
  return { prefix: "", suffix: "", decimals };
}

export function formatNumber(value: number, format: NumberFormat): string {
  const text = value.toLocaleString("en-IN", { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals });
  return `${format.prefix}${text}${format.suffix}`;
}

export const Counter: React.FC<{ value: number; progress: number; format: NumberFormat; size?: number; color?: string; weight?: number }> = ({
  value,
  progress,
  format,
  size = FONT_SIZE.title,
  color = COLORS.ink,
  weight = 700,
}) => (
  <Text size={size} weight={weight} color={color} style={{ fontVariantNumeric: "tabular-nums" }}>
    {formatNumber(value * progress, format)}
  </Text>
);

// ---------- bar ----------

/** Horizontal bar with a light track. `fill` is 0..1 of the track width. */
export const Bar: React.FC<{ width: number; height: number; fill: number; color: string; emphasis?: number }> = ({
  width,
  height,
  fill,
  color,
  emphasis = 0,
}) => (
  <div style={{ position: "relative", width, height, borderRadius: height / 2, background: COLORS.track }}>
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        height,
        width: Math.max(fill > 0 ? height * 0.5 : 0, width * fill),
        borderRadius: height / 2,
        background: color,
        boxShadow: emphasis > 0 ? `0 0 0 ${6 * emphasis}px ${COLORS.warmSoft}` : undefined,
      }}
    />
  </div>
);

// ---------- particles ----------

export type ParticleMotion = "drift" | "rise" | "fall" | "gather";

/**
 * Seeded particle field inside a box. Positions come from the object's ID (never Math.random),
 * motion from the frame. `speed` scales drift speed; `gather` (0..1) pulls particles together.
 */
export const Particles: React.FC<{
  seedKey: string;
  /** Absolute frame (drives the gentle sideways wobble). */
  frame: number;
  /** Frames of travel in the motion direction (defaults to `frame`). */
  travel?: number;
  box: { x: number; y: number; width: number; height: number };
  count?: number;
  motion: ParticleMotion;
  speed?: number;
  gather?: number;
  opacity?: number;
  color?: string;
  shape?: "dot" | "drop";
}> = ({ seedKey, frame, travel = frame, box, count = 22, motion, speed = 1, gather = 0, opacity = 1, color = COLORS.accent, shape = "dot" }) => {
  const random = seededRandom(hashString(seedKey));
  const dots = Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    r: 7 + random() * 9,
    phase: random() * Math.PI * 2,
    v: 0.6 + random() * 0.8,
  }));
  const direction = motion === "rise" ? -1 : motion === "fall" ? 1 : 0;
  return (
    <svg
      width={box.width}
      height={box.height}
      style={{ position: "absolute", left: box.x, top: box.y, overflow: "hidden", opacity }}
    >
      {dots.map((d, i) => {
        const moved = direction * travel * 2.2 * d.v;
        let y = (((d.y * box.height + moved) % box.height) + box.height) % box.height;
        const pad = 16 + 10 * speed; // keep whole particles (and their wobble) inside the box
        y = pad + (y / box.height) * (box.height - 2 * pad);
        let x = pad + d.x * (box.width - 2 * pad) + Math.sin(frame * 0.05 * speed * d.v + d.phase) * 10 * speed;
        if (gather > 0) {
          x = mix(x, box.width / 2 + (d.x - 0.5) * box.width * 0.25, gather);
          y = mix(y, box.height * 0.45 + (d.y - 0.5) * box.height * 0.25, gather);
        }
        return shape === "drop" ? (
          <path
            key={i}
            d={`M ${x} ${y - d.r * 1.6} C ${x} ${y - d.r * 1.6} ${x - d.r} ${y - d.r * 0.2} ${x - d.r} ${y + d.r * 0.4} a ${d.r} ${d.r} 0 0 0 ${2 * d.r} 0 C ${x + d.r} ${y - d.r * 0.2} ${x} ${y - d.r * 1.6} ${x} ${y - d.r * 1.6} Z`}
            fill={color}
            opacity={0.55 + 0.45 * ((i % 3) / 2)}
          />
        ) : (
          <circle key={i} cx={x} cy={y} r={d.r * 0.8} fill={color} opacity={0.35 + 0.5 * ((i % 4) / 3)} />
        );
      })}
    </svg>
  );
};

// ---------- colour helper ----------

/** Blend two #rrggbb colours (t = 0 -> a, 1 -> b). */
export function blend(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const channel = (shift: number) => Math.round(mix((pa >> shift) & 255, (pb >> shift) & 255, Math.max(0, Math.min(1, t))));
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}
