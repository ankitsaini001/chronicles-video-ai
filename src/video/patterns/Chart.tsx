import type React from "react";
import type { TimelineObject } from "../../contracts";
import { entranceStyle, type SceneClock } from "../anim";
import { Bar, Card, Counter, formatNumber, numberFormatFor, Text, type NumberFormat } from "../primitives";
import { COLORS, FONT_SIZE, STAGE } from "../theme";
import type { PatternProps } from "./types";

/**
 * Chart: an `axis` title plus one of bar rows, a line of `line-point`s, a donut of `pie-slice`s,
 * and/or big `counter`s. Values animate on `grow` / `count-up`; `highlight` tints a value warm.
 * The number format (%, ₹) comes from the axis label.
 */

const TITLE_TOP = STAGE.y + 40;
const BODY_TOP = STAGE.y + 200;

export const Chart: React.FC<PatternProps> = ({ clock }) => {
  const axis = clock.objectsOfKind("axis")[0];
  const bars = clock.objectsOfKind("bar");
  const points = clock.objectsOfKind("line-point");
  const slices = clock.objectsOfKind("pie-slice");
  const counters = clock.objectsOfKind("counter");
  const values = clock.objects.map((o) => o.value ?? 0);
  const format = numberFormatFor(axis?.label ?? "", values);

  // Stack the sections that exist; counters go last.
  const sections: React.ReactNode[] = [];
  if (bars.length) sections.push(<Bars key="bars" clock={clock} bars={bars} format={format} />);
  if (points.length) sections.push(<Line key="line" clock={clock} points={points} format={format} />);
  if (slices.length) sections.push(<Donut key="donut" clock={clock} slices={slices} format={format} />);
  if (counters.length) sections.push(<Counters key="counters" clock={clock} counters={counters} format={format} />);

  return (
    <>
      {axis && (
        <div style={{ position: "absolute", left: STAGE.x, width: STAGE.width, top: TITLE_TOP, ...entranceStyle(clock.reveal(axis.id)) }}>
          <Text size={FONT_SIZE.title} weight={700} align="center" lineHeight={1.12}>
            {axis.label}
          </Text>
        </div>
      )}
      <div style={{ position: "absolute", left: STAGE.x, top: BODY_TOP, width: STAGE.width, height: STAGE.y + STAGE.height - BODY_TOP, display: "flex", flexDirection: "column", justifyContent: "center", gap: 48 }}>
        {sections}
      </div>
    </>
  );
};

/** How far a value has grown: grow/count-up events drive it; otherwise it follows the reveal. */
function growth(clock: SceneClock, id: string): number {
  if (clock.has(id, "grow")) return clock.action(id, "grow");
  if (clock.has(id, "count-up")) return clock.action(id, "count-up");
  return clock.reveal(id);
}

const Bars: React.FC<{ clock: SceneClock; bars: TimelineObject[]; format: NumberFormat }> = ({ clock, bars, format }) => {
  const max = Math.max(...bars.map((b) => Math.abs(b.value ?? 0)), 1);
  const trackWidth = STAGE.width - 40;
  const barHeight = bars.length <= 3 ? 76 : bars.length <= 5 ? 56 : 44;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: bars.length <= 3 ? 56 : 34, padding: "0 20px" }}>
      {bars.map((bar) => {
        const g = growth(clock, bar.id);
        const emphasis = clock.emphasis(bar.id);
        const value = bar.value ?? 0;
        return (
          <div key={bar.id} style={entranceStyle(clock.reveal(bar.id), 20)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <Text size={FONT_SIZE.body} weight={600}>
                {bar.label}
              </Text>
              <Counter value={value} progress={g} format={format} size={FONT_SIZE.title} color={emphasis > 0.2 ? COLORS.warm : COLORS.accent} weight={800} />
            </div>
            <Bar width={trackWidth} height={barHeight} fill={(Math.abs(value) / max) * g} color={emphasis > 0.2 ? COLORS.warm : COLORS.accent} emphasis={emphasis} />
          </div>
        );
      })}
    </div>
  );
};

const Line: React.FC<{ clock: SceneClock; points: TimelineObject[]; format: NumberFormat }> = ({ clock, points, format }) => {
  const width = STAGE.width - 80;
  const height = 420;
  const values = points.map((p) => p.value ?? 0);
  const min = Math.min(0, ...values);
  const max = Math.max(...values, 1);
  const xy = points.map((p, i) => ({
    x: 40 + (points.length === 1 ? width / 2 : (i * width) / (points.length - 1)),
    y: 40 + height - (((p.value ?? 0) - min) / (max - min)) * height * growth(clock, p.id),
  }));
  const visible = xy.filter((_, i) => clock.reveal(points[i]!.id) > 0);
  return (
    <div style={{ position: "relative", height: height + 160 }}>
      <svg width={STAGE.width} height={height + 80} style={{ position: "absolute", left: 0, top: 0 }}>
        <line x1={40} y1={height + 40} x2={STAGE.width - 40} y2={height + 40} stroke={COLORS.line} strokeWidth={4} />
        <polyline points={visible.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={COLORS.accent} strokeWidth={10} strokeLinejoin="round" strokeLinecap="round" />
        {xy.map((p, i) => {
          const id = points[i]!.id;
          const emphasis = clock.emphasis(id);
          return <circle key={id} cx={p.x} cy={p.y} r={16 * clock.reveal(id) + 8 * emphasis} fill={emphasis > 0.2 ? COLORS.warm : COLORS.accent} stroke={COLORS.surface} strokeWidth={5} />;
        })}
      </svg>
      {xy.map((p, i) => {
        const point = points[i]!;
        return (
          <div key={point.id} style={{ position: "absolute", left: p.x - 110, width: 220, top: height + 70, opacity: clock.reveal(point.id) }}>
            <Text size={FONT_SIZE.small} weight={600} align="center" color={COLORS.inkMuted}>
              {point.label}
            </Text>
            <Text size={FONT_SIZE.small + 4} weight={800} align="center" color={COLORS.ink}>
              {formatNumber((point.value ?? 0) * growth(clock, point.id), format)}
            </Text>
          </div>
        );
      })}
    </div>
  );
};

const Donut: React.FC<{ clock: SceneClock; slices: TimelineObject[]; format: NumberFormat }> = ({ clock, slices, format }) => {
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.value ?? 0), 0) || 1;
  const size = 440;
  const r = 160;
  const circumference = 2 * Math.PI * r;
  const palette = [COLORS.accent, COLORS.warm, "#7FA3F2", "#F2B36F", "#A9B4C8", "#C9D5F6"];
  let offset = 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={COLORS.track} strokeWidth={70} />
        {slices.map((slice, i) => {
          const share = Math.max(0, slice.value ?? 0) / total;
          const length = share * circumference * growth(clock, slice.id);
          const element = (
            <circle
              key={slice.id}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={palette[i % palette.length]}
              strokeWidth={70 + 14 * clock.emphasis(slice.id)}
              strokeDasharray={`${length} ${circumference}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
          offset += share * circumference;
          return element;
        })}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {slices.map((slice, i) => (
          <div key={slice.id} style={{ display: "flex", alignItems: "center", gap: 14, ...entranceStyle(clock.reveal(slice.id), 14) }}>
            <div style={{ width: 26, height: 26, borderRadius: 8, background: palette[i % palette.length], flexShrink: 0 }} />
            <Text size={FONT_SIZE.small + 2} weight={600}>
              {slice.label} · {formatNumber((slice.value ?? 0) * growth(clock, slice.id), format)}
            </Text>
          </div>
        ))}
      </div>
    </div>
  );
};

const Counters: React.FC<{ clock: SceneClock; counters: TimelineObject[]; format: NumberFormat }> = ({ clock, counters, format }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 28, justifyContent: "center" }}>
    {counters.map((counter) => {
      const emphasis = clock.emphasis(counter.id);
      return (
        <Card key={counter.id} emphasis={emphasis} style={{ padding: "30px 40px", minWidth: 380, ...entranceStyle(clock.reveal(counter.id), 20) }}>
          <Counter value={counter.value ?? 0} progress={growth(clock, counter.id)} format={format} size={110} weight={800} color={emphasis > 0.2 ? COLORS.warm : COLORS.accent} />
          <Text size={FONT_SIZE.label} weight={600} color={COLORS.inkMuted} style={{ marginTop: 8 }}>
            {counter.label}
          </Text>
        </Card>
      );
    })}
  </div>
);

