import type React from "react";
import type { TimelineObject } from "../../contracts";
import { entranceStyle } from "../anim";
import { Card, Circle, Icon, iconFor, Text } from "../primitives";
import { COLORS, FONT_SIZE, RADIUS, STAGE } from "../theme";
import type { PatternProps } from "./types";

/**
 * Comparison: two `column`s side by side (A in blue, B in amber). Each `point` belongs to the
 * column listed before it; if both columns come first, points alternate A, B, A, B.
 * `check` / `cross` stamp a mark on a point; `highlight` lifts it. `icon`s sit in the headers in order.
 */

const GAP = 32;
const COLUMN_WIDTH = (STAGE.width - GAP) / 2;

export function assignPoints(objects: readonly TimelineObject[]): [TimelineObject[], TimelineObject[]] {
  const columns = objects.filter((o) => o.kind === "column");
  const result: [TimelineObject[], TimelineObject[]] = [[], []];
  const columnsFirst = objects.findIndex((o) => o.kind === "point") > objects.indexOf(columns[1]!);
  let current = 0;
  let alternate = 0;
  for (const object of objects) {
    if (object.kind === "column") current = columns.indexOf(object);
    if (object.kind !== "point") continue;
    if (columnsFirst) {
      result[alternate % 2 as 0 | 1].push(object);
      alternate++;
    } else {
      result[current === 1 ? 1 : 0].push(object);
    }
  }
  return result;
}

export const Comparison: React.FC<PatternProps> = ({ clock }) => {
  const columns = clock.objectsOfKind("column").slice(0, 2);
  const icons = clock.objectsOfKind("icon");
  const points = assignPoints(clock.objects);
  const colors = [COLORS.accent, COLORS.warm] as const;
  const softColors = [COLORS.accentSoft, COLORS.warmSoft] as const;

  return (
    <>
      {columns.map((column, c) => {
        const left = STAGE.x + c * (COLUMN_WIDTH + GAP);
        const icon = icons[c];
        const emphasis = clock.emphasis(column.id);
        return (
          <div key={column.id} style={{ position: "absolute", left, top: STAGE.y + 20, width: COLUMN_WIDTH, display: "flex", flexDirection: "column", gap: 22 }}>
            <div
              style={{
                background: colors[c as 0 | 1],
                borderRadius: RADIUS.m,
                padding: "28px 24px",
                minHeight: icons.length ? 290 : 176,
                justifyContent: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 14,
                boxShadow: `0 0 0 ${10 * emphasis}px ${softColors[c as 0 | 1]}`,
                ...entranceStyle(clock.reveal(column.id), 30),
              }}
            >
              {icon && (
                <Circle size={110} color={COLORS.surface} style={{ opacity: clock.reveal(icon.id) }}>
                  <Icon name={iconFor(icon)} size={70} />
                </Circle>
              )}
              <Text size={FONT_SIZE.title - 4} weight={800} color={COLORS.surface} align="center" lineHeight={1.08}>
                {column.label}
              </Text>
            </div>
            {points[c as 0 | 1].map((point) => {
              const check = clock.action(point.id, "check");
              const cross = clock.action(point.id, "cross");
              const mark = check > 0 ? "check" : cross > 0 ? "cross" : null;
              return (
                <div key={point.id} style={entranceStyle(clock.reveal(point.id), 24)}>
                  <Card emphasis={clock.emphasis(point.id)} accent={colors[c as 0 | 1]} style={{ padding: "24px 22px", display: "flex", gap: 16, alignItems: "flex-start" }}>
                    {mark && (
                      <div style={{ transform: `scale(${Math.max(check, cross)})`, flexShrink: 0 }}>
                        <Icon name={mark} size={48} />
                      </div>
                    )}
                    <Text size={FONT_SIZE.small + 4} weight={600} lineHeight={1.2}>
                      {point.label}
                    </Text>
                  </Card>
                </div>
              );
            })}
          </div>
        );
      })}
      {columns.length === 2 && (
        <div style={{ position: "absolute", left: STAGE.x + COLUMN_WIDTH + GAP / 2 - 44, top: STAGE.y + 70, opacity: clock.reveal(columns[1]!.id) }}>
          <Circle size={88} color={COLORS.ink}>
            <Text size={34} weight={800} color={COLORS.surface}>
              vs
            </Text>
          </Circle>
        </div>
      )}
    </>
  );
};
