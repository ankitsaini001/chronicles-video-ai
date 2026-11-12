import type React from "react";
import { entranceStyle } from "../anim";
import { Circle, Icon, iconFor, Text, type IconName } from "../primitives";
import { COLORS, FONT_SIZE, STAGE } from "@bytereel/pipeline/theme";
import type { PatternProps } from "./types";

/** Title / hook: an opening question (subtitle), a hero icon and a bold headline. */
export const TitleHook: React.FC<PatternProps> = ({ clock }) => {
  const headline = clock.objectsOfKind("headline")[0];
  const subtitle = clock.objectsOfKind("subtitle")[0];
  const icon = clock.objectsOfKind("icon")[0];
  const cx = STAGE.x + STAGE.width / 2;

  const iconCenterY = subtitle ? 760 : 640;
  const headlineTop = icon ? 1010 : 640;

  return (
    <>
      {subtitle && (
        <div style={{ position: "absolute", left: STAGE.x, width: STAGE.width, top: 380, ...entranceStyle(clock.reveal(subtitle.id)) }}>
          <Text size={FONT_SIZE.title} weight={600} color={COLORS.accent} align="center" lineHeight={1.15}>
            {subtitle.label}
          </Text>
        </div>
      )}
      {icon && <HeroIcon clock={clock} id={icon.id} icon={iconFor(icon)} cx={cx} cy={iconCenterY} />}
      {headline && (
        <div style={{ position: "absolute", left: STAGE.x, width: STAGE.width, top: headlineTop, ...entranceStyle(clock.reveal(headline.id), 50) }}>
          <Text size={FONT_SIZE.display} weight={800} align="center" lineHeight={1.05}>
            {headline.label}
          </Text>
          <div
            style={{
              margin: "28px auto 0",
              height: 12,
              borderRadius: 6,
              background: COLORS.warm,
              width: 220 * Math.max(clock.reveal(headline.id), clock.emphasis(headline.id)),
            }}
          />
        </div>
      )}
    </>
  );
};

const HeroIcon: React.FC<{ clock: PatternProps["clock"]; id: string; icon: IconName; cx: number; cy: number }> = ({ clock, id, icon, cx, cy }) => {
  const reveal = clock.reveal(id);
  const pulse = clock.pulse(id);
  const highlight = clock.highlight(id);
  const bob = Math.sin(clock.frame / 22) * 8;
  const size = 420;
  return (
    <div
      style={{
        position: "absolute",
        left: cx - size / 2,
        top: cy - size / 2 + bob,
        opacity: reveal,
        transform: `scale(${0.7 + 0.3 * reveal + 0.1 * pulse})`,
      }}
    >
      <Circle size={size} color={COLORS.accentSoft} style={{ boxShadow: `0 0 0 ${18 * Math.max(pulse, highlight)}px ${COLORS.warmSoft}` }}>
        <Icon name={icon} size={230} />
      </Circle>
    </div>
  );
};
