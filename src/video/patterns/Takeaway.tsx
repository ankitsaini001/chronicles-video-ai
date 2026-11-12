import type React from "react";
import { entranceStyle } from "../anim";
import { Card, Circle, Icon, iconFor, Text } from "../primitives";
import { COLORS, FONT_SIZE, STAGE } from "../theme";
import type { PatternProps } from "./types";

/** Takeaway: a headline, up to three bullet cards with check marks, and an optional closing icon. */
export const Takeaway: React.FC<PatternProps> = ({ clock }) => {
  const headline = clock.objectsOfKind("headline")[0];
  const bullets = clock.objectsOfKind("bullet");
  const icon = clock.objectsOfKind("icon")[0];

  return (
    <div style={{ position: "absolute", left: STAGE.x, top: STAGE.y + 30, width: STAGE.width, height: STAGE.height - 30, display: "flex", flexDirection: "column", gap: 40 }}>
      {headline && (
        <div style={entranceStyle(clock.reveal(headline.id), 40)}>
          <Text size={FONT_SIZE.headline} weight={800} lineHeight={1.08}>
            {headline.label}
          </Text>
          <div
            style={{
              marginTop: 22,
              height: 12,
              borderRadius: 6,
              background: COLORS.warm,
              width: 200 * clock.reveal(headline.id) * (1 + 0.3 * clock.emphasis(headline.id)),
            }}
          />
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
        {bullets.map((bullet, i) => {
          const reveal = clock.reveal(bullet.id);
          return (
            <div key={bullet.id} style={entranceStyle(reveal, 30)}>
              <Card emphasis={clock.emphasis(bullet.id)} accent={COLORS.accent} style={{ display: "flex", alignItems: "center", gap: 28, padding: "30px 34px" }}>
                <div style={{ transform: `scale(${0.6 + 0.4 * reveal})`, flexShrink: 0 }}>
                  <Circle size={74} color={i % 2 === 0 ? COLORS.accent : COLORS.warm}>
                    <Text size={38} weight={800} color={COLORS.surface}>
                      {i + 1}
                    </Text>
                  </Circle>
                </div>
                <Text size={FONT_SIZE.body} weight={600} lineHeight={1.18}>
                  {bullet.label}
                </Text>
              </Card>
            </div>
          );
        })}
      </div>
      {icon && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 36, ...entranceStyle(clock.reveal(icon.id), 30) }}>
          <div style={{ transform: `scale(${1 + 0.14 * clock.pulse(icon.id)}) rotate(${clock.pulse(icon.id) * -6}deg)` }}>
            <Circle size={250} color={COLORS.accentSoft} style={{ boxShadow: `0 0 0 ${16 * clock.emphasis(icon.id)}px ${COLORS.warmSoft}` }}>
              <Icon name={iconFor(icon)} size={150} />
            </Circle>
          </div>
          <Text size={FONT_SIZE.label} weight={600} color={COLORS.inkMuted} style={{ maxWidth: 380 }}>
            {icon.label}
          </Text>
        </div>
      )}
    </div>
  );
};
