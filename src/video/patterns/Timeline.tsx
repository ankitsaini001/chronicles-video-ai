import type React from "react";
import { entranceStyle, mix } from "../anim";
import { Card, Text } from "../primitives";
import { COLORS, FONT_SIZE, STAGE } from "../../../packages/pipeline/src/theme";
import type { PatternProps } from "./types";

/**
 * Timeline: an `axis` title and a vertical track with `milestone`s in order.
 * The track fills up to the latest milestone that has appeared or was `advance`d to;
 * `highlight` lifts a milestone card.
 */

const TRACK_X = STAGE.x + 70;
const TRACK_TOP = STAGE.y + 190;
const TRACK_BOTTOM = STAGE.y + STAGE.height - 40;

export const TimelinePattern: React.FC<PatternProps> = ({ clock }) => {
  const axis = clock.objectsOfKind("axis")[0];
  const milestones = clock.objectsOfKind("milestone");
  const n = milestones.length;
  const step = n > 1 ? (TRACK_BOTTOM - TRACK_TOP - 120) / (n - 1) : 0;
  const yOf = (i: number) => TRACK_TOP + 60 + i * step;

  // Track progress: interpolate towards the furthest milestone reached so far.
  let fill = TRACK_TOP;
  milestones.forEach((m, i) => {
    const reached = Math.max(clock.reveal(m.id), clock.action(m.id, "advance"));
    if (reached > 0) fill = mix(i === 0 ? TRACK_TOP : yOf(i - 1), yOf(i), reached);
  });

  return (
    <>
      {axis && (
        <div style={{ position: "absolute", left: STAGE.x, width: STAGE.width, top: STAGE.y + 30, ...entranceStyle(clock.reveal(axis.id)) }}>
          <Text size={FONT_SIZE.title} weight={700} lineHeight={1.12}>
            {axis.label}
          </Text>
        </div>
      )}
      <svg width={1080} height={1920} style={{ position: "absolute", left: 0, top: 0 }}>
        <line x1={TRACK_X} y1={TRACK_TOP} x2={TRACK_X} y2={TRACK_BOTTOM} stroke={COLORS.track} strokeWidth={14} strokeLinecap="round" />
        <line x1={TRACK_X} y1={TRACK_TOP} x2={TRACK_X} y2={fill} stroke={COLORS.accent} strokeWidth={14} strokeLinecap="round" />
        {milestones.map((m, i) => {
          const reveal = clock.reveal(m.id);
          const emphasis = clock.emphasis(m.id);
          return (
            <circle key={m.id} cx={TRACK_X} cy={yOf(i)} r={(18 + 8 * emphasis) * reveal} fill={emphasis > 0.2 ? COLORS.warm : COLORS.accent} stroke={COLORS.surface} strokeWidth={6} />
          );
        })}
      </svg>
      {milestones.map((m, i) => {
        const emphasis = clock.emphasis(m.id);
        return (
          <div key={m.id} style={{ position: "absolute", left: TRACK_X + 60, top: yOf(i) - 50, width: STAGE.x + STAGE.width - TRACK_X - 60, ...entranceStyle(clock.reveal(m.id), 24) }}>
            <Card emphasis={emphasis} style={{ padding: "22px 30px", minHeight: 100, display: "flex", alignItems: "center" }}>
              <Text size={FONT_SIZE.body} weight={600} lineHeight={1.15}>
                {m.label}
              </Text>
            </Card>
          </div>
        );
      })}
    </>
  );
};
