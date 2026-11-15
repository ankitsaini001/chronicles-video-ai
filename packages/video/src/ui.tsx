import type React from "react";
import { fitBox, type TextBox } from "./layout";
import { clamp01, glide, pop } from "./motion";
import { C, FONT, GRADIENTS, LAYOUT } from "./theme";

/**
 * Shared screen pieces of video style v4: dark cards with an amber edge when active, icon tiles,
 * chips, gold titles, the hook's slam words, the progress bar and the light-wipe transition.
 */

/** A dark card. `active` 0..1 lights the amber edge; `t` is its entrance (pop) value. */
export const Card: React.FC<{ t: number; active: number; from?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({ t, active, from = 40, style, children }) => (
  <div
    style={{
      opacity: clamp01(t * 1.6),
      transform: `translateY(${(1 - Math.min(1, t)) * from}px) scale(${(0.94 + 0.06 * Math.min(1.04, t)) * (1 + 0.025 * active)})`,
      background: GRADIENTS.card,
      border: `2px solid rgba(245,165,36,${0.16 + 0.64 * active})`,
      borderRadius: 30,
      boxShadow: `0 18px 40px rgba(0,0,0,0.55), 0 0 ${Math.round(30 * active)}px rgba(245,165,36,${(0.35 * active).toFixed(3)})`,
      ...style,
    }}
  >
    {children}
  </div>
);

export const IconTile: React.FC<{ size: number; active: number; children: React.ReactNode; round?: boolean }> = ({ size, active, children, round = false }) => (
  <div
    style={{
      width: size,
      height: size,
      flex: "none",
      borderRadius: round ? "50%" : size * 0.26,
      background: GRADIENTS.tile,
      border: `2px solid rgba(245,165,36,${0.25 + 0.55 * active})`,
      boxShadow: `0 0 ${Math.round(10 + 26 * active)}px rgba(245,165,36,${(0.12 + 0.3 * active).toFixed(3)})`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    {children}
  </div>
);

/** A label chip (arrow labels, "A vs B" headers). */
export const Chip: React.FC<{ t: number; active: number; size?: number; children: React.ReactNode }> = ({ t, active, size = 40, children }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 14,
      padding: `${Math.round(size * 0.25)}px ${Math.round(size * 0.7)}px`,
      borderRadius: 999,
      background: C.surface2,
      border: `2px solid rgba(245,165,36,${0.35 + 0.6 * active})`,
      boxShadow: `0 0 ${Math.round(12 + 24 * active)}px rgba(245,165,36,${(0.2 + 0.35 * active).toFixed(3)})`,
      opacity: clamp01(t * 1.6),
      transform: `scale(${Math.min(1.1, t) * (1 + 0.05 * active)})`,
      fontFamily: FONT,
      fontWeight: 800,
      fontSize: size,
      lineHeight: 1.1,
      color: active > 0.5 ? C.gold : C.amberLight,
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </div>
);

/** Rough line count for text (Inter ExtraBold is about 0.58 em per character). */
export const textLines = (text: string, size: number, width = 900) => Math.max(1, Math.ceil((text.length * size * 0.58) / width));

/** Font size so `text` fits in `maxLines` lines of `width` px, between `min` and `max`. */
export function fitSize(text: string, width: number, maxLines: number, max: number, min: number): number {
  for (let size = max; size > min; size -= 2) if (textLines(text, size, width) <= maxLines) return size;
  return min;
}

/**
 * Card text that must stay inside its card (comparison points, takeaway rows, diagram parts): as big
 * as fits the box (layout.ts fitBox), down to `min`; anything that still does not fit is cut off at
 * the box's last line instead of spilling out.
 */
export const BoxText: React.FC<TextBox & { text: string; style?: React.CSSProperties }> = ({ text, style, ...box }) => {
  const fit = fitBox(text, box);
  return (
    <span
      style={{
        fontFamily: FONT,
        fontWeight: 800,
        fontSize: fit.size,
        lineHeight: box.lineHeight,
        textWrap: "balance",
        // Only reached at the smallest size (fitBox steps down first): a word wider than the card
        // breaks over lines instead of being cut off mid-word.
        overflowWrap: "anywhere",
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: fit.maxLines,
        overflow: "hidden",
        maxHeight: box.height,
        ...style,
      }}
    >
      {text}
    </span>
  );
};

/** Gold title at the top of a scene. Width-balanced, never wider than the stage. */
export const Title: React.FC<{ text: string; t: number; top: number; size: number; width?: number }> = ({ text, t, top, size, width = 900 }) =>
  t <= 0.001 ? null : (
    <div style={{ position: "absolute", left: 540 - width / 2, width, top, textAlign: "center", textWrap: "balance", opacity: clamp01(t * 1.5), transform: `translateY(${(1 - Math.min(1, t)) * 30}px)` }}>
      <span
        style={{
          fontFamily: FONT,
          fontWeight: 800,
          fontSize: size,
          lineHeight: 1.08,
          letterSpacing: "-0.02em",
          backgroundImage: GRADIENTS.headline,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        {text}
      </span>
    </div>
  );

/** A word that slams in (the hook): scale from big, overshoot, flash of glow. */
export const SlamWord: React.FC<{ text: string; frame: number; at: number; size: number; color?: string | undefined }> = ({ text, frame, at, size, color }) => {
  const t = pop(frame, at, 260, 14);
  if (t <= 0.001) return null;
  const scale = 2.4 - 1.4 * t;
  const glow = Math.max(0, 1 - (frame - at) / 14);
  return (
    <span
      style={{
        display: "inline-block",
        margin: "0 18px",
        fontFamily: FONT,
        fontWeight: 800,
        fontSize: size,
        lineHeight: 1.02,
        letterSpacing: "-0.03em",
        color: color ?? C.text,
        opacity: clamp01(t * 5),
        transform: `scale(${scale}) rotate(${(1 - Math.min(1, t)) * -6}deg)`,
        textShadow: `0 0 ${Math.round(20 + glow * 40)}px rgba(245,165,36,${(0.45 + glow * 0.5).toFixed(2)}), 0 6px 18px rgba(0,0,0,0.9)`,
      }}
    >
      {text}
    </span>
  );
};

/** Whole-screen light flash (the hook's first frames). */
export const Flash: React.FC<{ amount: number }> = ({ amount }) =>
  amount > 0.001 ? <div style={{ position: "absolute", inset: 0, background: `radial-gradient(70% 50% at 50% 45%, rgba(255,226,168,${amount}), rgba(255,226,168,${amount * 0.35}) 60%, rgba(255,226,168,${amount * 0.15}))` }} /> : null;

/** Thin progress bar at the very top, with a tick at each scene start. */
export const ProgressBar: React.FC<{ frame: number; total: number; ticks: readonly number[] }> = ({ frame, total, ticks }) => {
  const p = Math.min(1, (frame + 1) / total);
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: LAYOUT.width, height: 9, background: "rgba(255,255,255,0.08)" }}>
      <div style={{ width: `${p * 100}%`, height: "100%", background: "linear-gradient(90deg, #E8901A, #FFD27A)", boxShadow: "0 0 14px rgba(245,165,36,0.9)" }} />
      {ticks.map((t) => (
        <div key={t} style={{ position: "absolute", top: 0, left: (t / total) * LAYOUT.width - 1.5, width: 3, height: 9, background: frame >= t ? "rgba(26,16,5,0.7)" : "rgba(255,255,255,0.25)" }} />
      ))}
    </div>
  );
};

/** A diagonal band of warm light sweeping across the frame at a scene change (`at`). */
export const LightWipe: React.FC<{ frame: number; at: number }> = ({ frame, at }) => {
  if (frame < at - 16 || frame > at + 16) return null;
  const t = glide(frame, at - 12, 24);
  return (
    <div
      style={{
        position: "absolute",
        top: -400,
        left: -1350 + t * 2880,
        width: 900,
        height: 2720,
        transform: "rotate(14deg)",
        background: "linear-gradient(90deg, rgba(255,226,168,0) 0%, rgba(255,226,168,0.4) 42%, rgba(255,246,225,0.85) 50%, rgba(255,226,168,0.4) 58%, rgba(255,226,168,0) 100%)",
      }}
    />
  );
};
