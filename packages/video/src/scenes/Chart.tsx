import type React from "react";
import type { TimelineObject } from "@bytereel/pipeline/contracts";
import { AbsoluteFill } from "remotion";
import { CameraView } from "../camera";
import { arcPath } from "../geometry";
import { HeroLayer } from "../heroes/HeroLayer";
import { pop, popIn, pulse, rise } from "../motion";
import { C, FONT, GRADIENTS } from "../theme";
import { Card, fitSize, textLines, Title } from "../ui";
import { activations, activeAmount, activeAt, heroCamera, ofKind, TOP, type Ctx, type Pattern } from "./shared";

/**
 * Chart (simple numbers that animate):
 * - pie slices: a ring that grows slice by slice around the hero, and a big count-up card for the
 *   slice being named;
 * - bars or line points: big bars (or a self-drawing line) with their values, a smaller hero above,
 *   and the label of the value being named under the chart;
 * - counters only: the hero and a big count-up card.
 */

export interface NumberFormat {
  prefix: string;
  suffix: string;
  decimals: number;
}

/** How to show values, from the axis label: "Share of Earth's water (%)" -> "97%", "Price (₹)" -> "₹40". */
export function numberFormatFor(label: string, values: readonly number[]): NumberFormat {
  const lower = label.toLowerCase();
  const decimals = values.some((v) => !Number.isInteger(v)) ? 1 : 0;
  if (lower.includes("%") || lower.includes("percent") || lower.includes("प्रतिशत")) return { prefix: "", suffix: "%", decimals };
  if (lower.includes("₹") || lower.includes("rupee") || lower.includes("रुपये")) return { prefix: "₹", suffix: "", decimals };
  return { prefix: "", suffix: "", decimals };
}

export function formatNumber(value: number, format: NumberFormat): string {
  const body = value.toLocaleString("en-IN", { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals });
  return `${format.prefix}${body}${format.suffix}`;
}

const SLICE_COLORS = ["#2F8FD8", "#DDF3FF", "#F5A524", "#4FD1C5", "#B58CFF", "#FF8A5C"];
const VALUE_KINDS = ["pie-slice", "bar", "line-point", "counter"];

function model(ctx: Ctx) {
  const axis = ofKind(ctx, "axis")[0];
  const values = ofKind(ctx, ...VALUE_KINDS);
  const slices = values.filter((v) => v.kind === "pie-slice");
  const series = values.filter((v) => v.kind === "bar" || v.kind === "line-point");
  let format = numberFormatFor(axis?.label ?? "", values.map((v) => v.value ?? 0));
  const sum = slices.reduce((s, v) => s + (v.value ?? 0), 0);
  if (slices.length && !format.suffix && !format.prefix && Math.abs(sum - 100) <= 1) format = { ...format, suffix: "%" };
  const titleSize = axis ? fitSize(axis.label, 900, 2, 76, 56) : 0;
  const titleBottom = axis ? TOP + textLines(axis.label, titleSize) * titleSize * 1.08 : TOP - 40;
  return { axis, values, slices, series, format, titleSize, titleBottom };
}

export const Chart: Pattern = {
  camera: (ctx) => heroCamera(ctx),
  View: ({ ctx, cam }) => {
    const m = model(ctx);
    const kind = m.slices.length ? "pie" : m.series.length >= 2 ? "series" : "counter";
    return (
      <AbsoluteFill>
        <CameraView cam={cam}>
          {m.axis && <Title text={m.axis.label} t={popIn(ctx.frame, m.axis.revealFrame)} top={TOP} size={m.titleSize} />}
          {kind === "pie" && <Pie ctx={ctx} m={m} />}
          {kind === "series" && <Series ctx={ctx} m={m} />}
          {kind === "counter" && (
            <>
              <HeroLayer steps={ctx.scene.heroes} cues={ctx.heroCues} frame={ctx.frame} cx={540} cy={Math.max(720, m.titleBottom + 300)} size={540} />
              <ValueCard ctx={ctx} m={m} list={m.values} />
            </>
          )}
        </CameraView>
      </AbsoluteFill>
    );
  },
};

type Model = ReturnType<typeof model>;

const grow = (frame: number, o: TimelineObject) => rise(frame, o.revealFrame, 26);
const colorOf = (m: Model, o: TimelineObject) => (o.kind === "pie-slice" ? SLICE_COLORS[m.slices.indexOf(o) % SLICE_COLORS.length]! : C.amber);

/** The big count-up card for the value being named. */
const ValueCard: React.FC<{ ctx: Ctx; m: Model; list: TimelineObject[] }> = ({ ctx, m, list }) => {
  const f = ctx.frame;
  const acts = activations(ctx, list);
  const now = activeAt(acts, f);
  const o = now ? list.find((v) => v.id === now.id) ?? null : null;
  if (!o || !now) return null;
  const maxAbs = Math.max(1, ...list.map((v) => Math.abs(v.value ?? 0)));
  const text = formatNumber(Math.round((o.value ?? 0) * grow(f, o) * 10 ** m.format.decimals) / 10 ** m.format.decimals, m.format);
  const numberSize = Math.min(140, Math.floor(420 / Math.max(3, text.length) / 0.6));
  return (
    <div key={o.id} style={{ position: "absolute", left: 100, width: 840, top: 1050, height: 200 }}>
      <Card t={pop(f, now.frame, 220, 14)} active={0.6 + 0.4 * pulse(f, now.frame, 30)} from={30} style={{ height: "100%", display: "flex", alignItems: "center", gap: 28, padding: "0 36px", boxSizing: "border-box", position: "relative", overflow: "hidden" }}>
        {o.kind !== "pie-slice" && <div style={{ position: "absolute", left: 0, bottom: 0, height: 8, width: `${(Math.abs(o.value ?? 0) / maxAbs) * 100 * grow(f, o)}%`, background: GRADIENTS.button }} />}
        <div style={{ width: 16, height: 120, borderRadius: 8, background: colorOf(m, o), flex: "none" }} />
        <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: numberSize, lineHeight: 1, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums", backgroundImage: GRADIENTS.headline, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", flex: "none" }}>{text}</span>
        <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: fitSize(o.label, 380, 3, 54, 40), lineHeight: 1.08, color: C.text, textWrap: "balance" }}>{o.label}</span>
      </Card>
    </div>
  );
};

const Pie: React.FC<{ ctx: Ctx; m: Model }> = ({ ctx, m }) => {
  const f = ctx.frame;
  const R = 262;
  const W = 62;
  const cy = Math.max(705, m.titleBottom + 40 + R + W / 2);
  const acts = activations(ctx, m.slices);
  const now = activeAt(acts, f);
  const total = m.slices.reduce((s, v) => s + Math.abs(v.value ?? 0), 0) || 1;
  let angle = 0;
  const arcs = m.slices.map((s, i) => {
    const from = angle;
    angle += (Math.abs(s.value ?? 0) / total) * 360;
    return { s, from, to: angle, color: SLICE_COLORS[i % SLICE_COLORS.length]! };
  });
  return (
    <>
      <svg width={1080} height={1920} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <circle cx={540} cy={cy} r={R} fill="none" stroke="#F5A524" strokeWidth={W} opacity={0.12 * rise(f, ctx.scene.startFrame - 10, 12)} />
        {arcs.map(({ s, from, to, color }) => {
          const g = grow(f, s);
          if (g <= 0.001) return null;
          const d = arcPath(540, cy, R, from, Math.max(from + 0.4, from + (to - from) * g));
          const act = activeAmount(acts, s.id, f);
          return (
            <g key={s.id} opacity={now && now.id !== s.id ? 0.5 : 1}>
              {act > 0 && <path d={d} fill="none" stroke={color} strokeWidth={W * 1.8} opacity={0.22 * act} />}
              <path d={d} fill="none" stroke={color} strokeWidth={W * (1 + 0.18 * act)} />
            </g>
          );
        })}
        {arcs.length > 1 &&
          arcs.map(({ s, from }) => {
            const a = ((from - 90) * Math.PI) / 180;
            const r1 = R - W * 0.62;
            const r2 = R + W * 0.62;
            return f >= s.revealFrame ? <line key={s.id} x1={540 + Math.cos(a) * r1} y1={cy + Math.sin(a) * r1} x2={540 + Math.cos(a) * r2} y2={cy + Math.sin(a) * r2} stroke="#0B0806" strokeWidth={4} /> : null;
          })}
      </svg>
      <HeroLayer steps={ctx.scene.heroes} cues={ctx.heroCues} frame={f} cx={540} cy={cy} size={410} />
      <ValueCard ctx={ctx} m={m} list={m.slices.length ? m.slices : m.values} />
    </>
  );
};

/** Bars (or a line through points) growing from a baseline, with their values on top. */
const Series: React.FC<{ ctx: Ctx; m: Model }> = ({ ctx, m }) => {
  const f = ctx.frame;
  const list = m.series.slice(0, 6);
  const line = list.every((o) => o.kind === "line-point");
  const acts = activations(ctx, list);
  const now = activeAt(acts, f);
  const nowObj = now ? list.find((o) => o.id === now.id) ?? null : null;
  const maxAbs = Math.max(1, ...list.map((o) => Math.abs(o.value ?? 0)));
  const base = 1150;
  const height = 300;
  const left = 130;
  const right = 920;
  const step = (right - left) / list.length;
  const barW = Math.min(150, step * 0.62);
  const heroY = Math.max(600, m.titleBottom + 200);
  const xs = list.map((_, i) => left + step * (i + 0.5));
  const ys = list.map((o) => base - (Math.abs(o.value ?? 0) / maxAbs) * height * grow(f, o));
  const shown = list.filter((o) => f >= o.revealFrame).length;
  const valueSize = Math.min(54, Math.floor(step / 3.2));
  return (
    <>
      <HeroLayer steps={ctx.scene.heroes} cues={ctx.heroCues} frame={f} cx={540} cy={heroY} size={340} />
      <svg width={1080} height={1920} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <line x1={left - 20} y1={base} x2={right + 10} y2={base} stroke="#F5A524" strokeWidth={4} opacity={0.5 * rise(f, ctx.scene.startFrame - 6, 12)} />
        {!line &&
          list.map((o, i) => {
            const act = activeAmount(acts, o.id, f);
            const h = base - ys[i]!;
            if (h <= 0.5) return null;
            return (
              <g key={o.id} opacity={now && now.id !== o.id ? 0.6 : 1}>
                {act > 0 && <rect x={xs[i]! - barW / 2 - 12} y={ys[i]! - 12} width={barW + 24} height={h + 12} rx={20} fill="#F5A524" opacity={0.2 * act} />}
                <rect x={xs[i]! - barW / 2} y={ys[i]!} width={barW} height={h} rx={14} fill="url(#bar-fill)" />
              </g>
            );
          })}
        {line && shown >= 2 && (
          <>
            <polyline points={list.slice(0, shown).map((_, i) => `${xs[i]},${ys[i]}`).join(" ")} fill="none" stroke="#F5A524" strokeWidth={26} strokeOpacity={0.18} strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={list.slice(0, shown).map((_, i) => `${xs[i]},${ys[i]}`).join(" ")} fill="none" stroke="#F5A524" strokeWidth={9} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {line &&
          list.map((o, i) =>
            f >= o.revealFrame ? <circle key={o.id} cx={xs[i]} cy={ys[i]} r={16 + 8 * activeAmount(acts, o.id, f)} fill="#FFE2A8" stroke="#F5A524" strokeWidth={5} /> : null,
          )}
        <defs>
          <linearGradient id="bar-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFD27A" />
            <stop offset="100%" stopColor="#E8901A" />
          </linearGradient>
        </defs>
      </svg>
      {list.map((o, i) =>
        f >= o.revealFrame ? (
          <div key={o.id} style={{ position: "absolute", left: xs[i]! - step / 2, width: step, top: ys[i]! - valueSize * 1.25 - 8, textAlign: "center", fontFamily: FONT, fontWeight: 800, fontSize: valueSize, lineHeight: 1.2, color: now?.id === o.id ? C.gold : C.amberLight, fontVariantNumeric: "tabular-nums" }}>
            {formatNumber(Math.round((o.value ?? 0) * grow(f, o) * 10 ** m.format.decimals) / 10 ** m.format.decimals, m.format)}
          </div>
        ) : null,
      )}
      {nowObj && (
        <div key={nowObj.id} style={{ position: "absolute", left: 90, width: 860, top: base + 24, textAlign: "center", fontFamily: FONT, fontWeight: 800, fontSize: fitSize(nowObj.label, 860, 1, 50, 40), color: C.text, opacity: Math.min(1, popIn(f, now!.frame) * 1.5) }}>
          {nowObj.label}
        </div>
      )}
    </>
  );
};
