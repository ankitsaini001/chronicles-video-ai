import type React from "react";
import { entranceStyle } from "../anim";
import { Card, Circle, Icon, iconFor, Text } from "../primitives";
import { COLORS, FONT_SIZE, STAGE } from "../theme";
import type { PatternProps } from "./types";

/**
 * Step sequence: numbered step cards revealed one by one. `complete` turns the number into a check
 * and tints the card; `highlight` lifts the current step. An optional `icon` sits above the steps.
 */
export const StepSequence: React.FC<PatternProps> = ({ clock }) => {
  const steps = clock.objectsOfKind("step");
  const icon = clock.objectsOfKind("icon")[0];
  const compact = steps.length >= 5;

  return (
    <div style={{ position: "absolute", left: STAGE.x, top: STAGE.y + 20, width: STAGE.width, height: STAGE.height - 20, display: "flex", flexDirection: "column", justifyContent: "center", gap: compact ? 20 : 30 }}>
      {icon && (
        <div style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 10, ...entranceStyle(clock.reveal(icon.id)) }}>
          <Circle size={120} color={COLORS.accentSoft} style={{ transform: `scale(${1 + 0.12 * clock.emphasis(icon.id)})` }}>
            <Icon name={iconFor(icon)} size={76} />
          </Circle>
          <Text size={FONT_SIZE.label} weight={700} color={COLORS.inkMuted}>
            {icon.label}
          </Text>
        </div>
      )}
      {steps.map((step, i) => {
        const done = clock.action(step.id, "complete");
        const emphasis = clock.emphasis(step.id);
        return (
          <div key={step.id} style={entranceStyle(clock.reveal(step.id), 30)}>
            <Card
              emphasis={emphasis}
              accent={COLORS.accent}
              style={{ display: "flex", alignItems: "center", gap: 26, padding: compact ? "20px 28px" : "28px 32px", background: done > 0 ? COLORS.accentSoft : COLORS.surface }}
            >
              <div style={{ position: "relative", width: 76, height: 76, flexShrink: 0 }}>
                <Circle size={76} color={COLORS.ink} style={{ position: "absolute", opacity: 1 - done }}>
                  <Text size={36} weight={800} color={COLORS.surface}>
                    {i + 1}
                  </Text>
                </Circle>
                <div style={{ position: "absolute", opacity: done, transform: `scale(${0.5 + 0.5 * done})` }}>
                  <Icon name="check" size={76} />
                </div>
              </div>
              <Text size={compact ? FONT_SIZE.small + 6 : FONT_SIZE.body - 2} weight={600} lineHeight={1.18}>
                {step.label}
              </Text>
            </Card>
          </div>
        );
      })}
    </div>
  );
};
