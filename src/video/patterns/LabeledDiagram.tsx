import type React from "react";
import { entranceStyle, mix } from "../anim";
import { Arrow, Circle, Icon, iconFor, Label, Text, type IconName } from "../primitives";
import { COLORS, FONT_SIZE, STAGE } from "../theme";
import type { PatternProps } from "./types";

/**
 * Labeled diagram: one central illustration (`diagram`) with `part` labels joined to it by leader
 * lines, an optional `arrow` callout pointing at it from below, and small `icon` accents.
 * Labels appear in sync with their events; `point-to` draws the arrow, `highlight` glows.
 */

const CENTER = { x: 540, y: 690 };
const RADIUS = 200;
/** The diagram name sits just below the circle; the callout arrow points at it from below. */
const NAME_TOP = CENTER.y + RADIUS + 14;
const PILL_MAX = 400;

/** Fixed label slots around the diagram: pill anchor side, pill y (top), and the point on the diagram. */
const SLOTS = [
  { side: "left", y: 340, angle: 225 },
  { side: "right", y: 1000, angle: 40 },
  { side: "right", y: 340, angle: 315 },
  { side: "left", y: 1000, angle: 140 },
  { side: "left", y: 650, angle: 180 },
  { side: "right", y: 650, angle: 0 },
] as const;

export const LabeledDiagram: React.FC<PatternProps> = ({ clock }) => {
  const diagram = clock.objectsOfKind("diagram")[0];
  const parts = clock.objectsOfKind("part");
  const arrows = clock.objectsOfKind("arrow");
  const icons = clock.objectsOfKind("icon");

  const diagramReveal = diagram ? clock.reveal(diagram.id) : 1;
  const diagramEmphasis = diagram ? clock.emphasis(diagram.id) : 0;
  const breathe = 1 + Math.sin(clock.frame / 30) * 0.012;

  // Callouts: the first arrow goes below the diagram; extra arrows take free label slots.
  const callout = arrows[0];
  const slotted = [...parts, ...arrows.slice(1)];

  return (
    <>
      {diagram && (
        <div
          style={{
            position: "absolute",
            left: CENTER.x - RADIUS,
            top: CENTER.y - RADIUS,
            opacity: diagramReveal,
            transform: `scale(${(0.85 + 0.15 * diagramReveal + 0.05 * diagramEmphasis) * breathe})`,
          }}
        >
          <Circle size={RADIUS * 2} color={COLORS.accentSoft} style={{ boxShadow: `0 0 0 ${20 * diagramEmphasis}px ${COLORS.warmSoft}` }}>
            <Icon name={iconFor(diagram)} size={RADIUS * 1.35} />
          </Circle>
          <div style={{ position: "absolute", left: -100, width: RADIUS * 2 + 200, top: NAME_TOP - (CENTER.y - RADIUS), display: "flex", justifyContent: "center" }}>
            <Label text={diagram.label} emphasis={diagramEmphasis} size={FONT_SIZE.body} />
          </div>
        </div>
      )}

      <svg width={1080} height={1920} style={{ position: "absolute", left: 0, top: 0 }}>
        {slotted.slice(0, SLOTS.length).map((part, i) => {
          const slot = SLOTS[i]!;
          const reveal = clock.reveal(part.id);
          const rad = (slot.angle * Math.PI) / 180;
          const px = CENTER.x + Math.cos(rad) * RADIUS * 0.82;
          const py = CENTER.y + Math.sin(rad) * RADIUS * 0.82;
          const lx = slot.side === "left" ? STAGE.x + 200 : STAGE.x + STAGE.width - 200;
          const ly = slot.y + 36;
          const highlight = clock.emphasis(part.id);
          const color = highlight > 0.2 ? COLORS.warm : COLORS.ink;
          return (
            <g key={part.id} opacity={reveal}>
              <line x1={lx} y1={ly} x2={mix(lx, px, reveal)} y2={mix(ly, py, reveal)} stroke={color} strokeWidth={4} />
              <circle cx={px} cy={py} r={12 * reveal} fill={COLORS.surface} stroke={color} strokeWidth={5} />
            </g>
          );
        })}
        {callout && (
          <Arrow
            x1={CENTER.x}
            y1={1170}
            x2={CENTER.x}
            y2={NAME_TOP + 84}
            progress={Math.max(clock.action(callout.id, "point-to"), clock.has(callout.id, "point-to") ? 0 : clock.reveal(callout.id))}
            color={clock.emphasis(callout.id) > 0.2 ? COLORS.warm : COLORS.accent}
            width={12}
          />
        )}
      </svg>

      {slotted.slice(0, SLOTS.length).map((part, i) => {
        const slot = SLOTS[i]!;
        const align = slot.side === "left" ? { left: STAGE.x } : { right: 1080 - STAGE.x - STAGE.width };
        return (
          <div
            key={part.id}
            style={{
              position: "absolute",
              top: slot.y,
              ...align,
              width: PILL_MAX,
              display: "flex",
              justifyContent: slot.side === "left" ? "flex-start" : "flex-end",
              ...entranceStyle(clock.reveal(part.id), 20),
            }}
          >
            <PartLabel text={part.label} icon={iconFor(part, null)} emphasis={clock.emphasis(part.id)} />
          </div>
        );
      })}

      {callout && (
        <div style={{ position: "absolute", left: STAGE.x, width: STAGE.width, top: 1166, display: "flex", justifyContent: "center", ...entranceStyle(clock.reveal(callout.id), 20) }}>
          <Label text={callout.label} emphasis={clock.emphasis(callout.id)} size={FONT_SIZE.body} />
        </div>
      )}

      {icons.slice(0, 2).map((icon, i) => (
        <div
          key={icon.id}
          style={{ position: "absolute", left: i === 0 ? STAGE.x + 10 : STAGE.x + STAGE.width - 130, top: 560, opacity: clock.reveal(icon.id), transform: `scale(${1 + 0.15 * clock.emphasis(icon.id)})` }}
        >
          <Icon name={iconFor(icon)} size={120} />
          <Text size={FONT_SIZE.small} weight={600} color={COLORS.inkMuted} align="center" style={{ width: 120 }}>
            {icon.label}
          </Text>
        </div>
      ))}
    </>
  );
};

/** A part label pill, with a small icon only when the label matches one. */
const PartLabel: React.FC<{ text: string; icon: IconName | null; emphasis: number }> = ({ text, icon, emphasis }) => {
  return <Label text={text} emphasis={emphasis} maxWidth={PILL_MAX} {...(icon ? { icon: <Icon name={icon} size={46} /> } : {})} />;
};
