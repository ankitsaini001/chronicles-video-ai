import type React from "react";
import type { TimelineObject } from "../../../packages/pipeline/src/contracts";
import { entranceStyle, mix, type SceneClock } from "../anim";
import { Arrow, Card, Circle, Icon, iconFor, Label, Particles, Text } from "../primitives";
import { COLORS, FONT_SIZE, STAGE } from "../../../packages/pipeline/src/theme";
import type { PatternProps } from "./types";

/**
 * Process flow: nodes in a vertical chain joined by arrows (cause -> effect, cycles, pipelines).
 * - Direction is "up" when the scene uses `rise` (and not `fall`), else "down".
 * - `arrow` objects label the connector between the nodes listed around them.
 * - `icon` objects sit in a top strip; `particles` before any node fill that strip, otherwise they
 *   stream along the connector after the node listed before them.
 */

const NODE_WIDTH = 640;
const NODE_X = STAGE.x + (STAGE.width - NODE_WIDTH) / 2;
const STRIP_HEIGHT = 230;
const LINE_X = STAGE.x + STAGE.width / 2;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProcessFlowLayout {
  direction: "up" | "down";
  strip: Box | null;
  nodes: { object: TimelineObject; box: Box }[];
  connectors: { from: number; to: number; y1: number; y2: number; arrow: TimelineObject | null; particles: TimelineObject[] }[];
  icons: TimelineObject[];
  stripParticles: TimelineObject[];
}

export function layoutProcessFlow(objects: readonly TimelineObject[], actions: readonly string[]): ProcessFlowLayout {
  const direction = actions.includes("rise") && !actions.includes("fall") ? "up" : "down";
  const nodes = objects.filter((o) => o.kind === "node");
  const icons = objects.filter((o) => o.kind === "icon");
  const nodeIndexBefore = (index: number) => {
    for (let i = index - 1; i >= 0; i--) if (objects[i]!.kind === "node") return nodes.indexOf(objects[i]!);
    return -1;
  };
  const nodeIndexAfter = (index: number) => {
    for (let i = index + 1; i < objects.length; i++) if (objects[i]!.kind === "node") return nodes.indexOf(objects[i]!);
    return -1;
  };

  const connectorCount = Math.max(0, nodes.length - 1);
  const connectorArrows: (TimelineObject | null)[] = Array.from({ length: connectorCount }, () => null);
  const connectorParticles: TimelineObject[][] = Array.from({ length: connectorCount }, () => []);
  const stripParticles: TimelineObject[] = [];
  const looseArrows: TimelineObject[] = [];

  objects.forEach((object, index) => {
    const before = nodeIndexBefore(index);
    const after = nodeIndexAfter(index);
    if (object.kind === "arrow") {
      if (connectorCount === 0) return looseArrows.push(object);
      let connector = before === -1 ? 0 : after === -1 ? connectorCount - 1 : before;
      // If that connector is taken, use the next free one.
      while (connector < connectorCount - 1 && connectorArrows[connector]) connector++;
      if (connectorArrows[connector]) return looseArrows.push(object);
      connectorArrows[connector] = object;
    } else if (object.kind === "particles") {
      if (before === -1 || connectorCount === 0) stripParticles.push(object);
      else connectorParticles[Math.min(before, connectorCount - 1)]!.push(object);
    }
    return undefined;
  });

  const hasStrip = icons.length > 0 || stripParticles.length > 0;
  const top = STAGE.y + (hasStrip ? STRIP_HEIGHT + 20 : 0);
  const bottom = STAGE.y + STAGE.height;
  const columnHeight = bottom - top;
  const n = nodes.length;
  const nodeHeight = n <= 2 ? 150 : n === 3 ? 136 : n === 4 ? 116 : 100;
  const gap = n > 1 ? (columnHeight - n * nodeHeight) / (n - 1) : 0;

  const slotY = (slot: number) => (n === 1 ? top + (columnHeight - nodeHeight) / 2 : top + slot * (nodeHeight + gap));
  const nodeBoxes = nodes.map((object, i) => {
    const slot = direction === "down" ? i : n - 1 - i;
    return { object, box: { x: NODE_X, y: slotY(slot), width: NODE_WIDTH, height: nodeHeight } };
  });
  const connectors = connectorArrows.map((arrow, i) => {
    const a = nodeBoxes[i]!.box;
    const b = nodeBoxes[i + 1]!.box;
    const y1 = direction === "down" ? a.y + a.height + 14 : a.y - 14;
    const y2 = direction === "down" ? b.y - 14 : b.y + b.height + 14;
    return { from: i, to: i + 1, y1, y2, arrow, particles: connectorParticles[i]! };
  });
  return {
    direction,
    strip: hasStrip ? { x: STAGE.x, y: STAGE.y, width: STAGE.width, height: STRIP_HEIGHT } : null,
    nodes: nodeBoxes,
    connectors,
    icons: [...icons, ...looseArrows],
    stripParticles,
  };
}

export const ProcessFlow: React.FC<PatternProps> = ({ clock }) => {
  const layout = layoutProcessFlow(clock.objects, clock.scene.events.map((e) => e.action));
  return (
    <>
      {layout.strip && <Strip clock={clock} layout={layout} />}
      <svg width={1080} height={1920} style={{ position: "absolute", left: 0, top: 0 }}>
        {layout.connectors.map((c, i) => {
          const target = layout.nodes[c.to]!.object;
          const drawn = c.arrow ? clock.reveal(c.arrow.id) : clock.reveal(target.id);
          const emphasis = c.arrow ? clock.emphasis(c.arrow.id) : 0;
          return (
            <Arrow
              key={i}
              x1={LINE_X}
              y1={c.y1}
              x2={LINE_X}
              y2={c.y2}
              progress={drawn}
              color={emphasis > 0.2 ? COLORS.warm : COLORS.accent}
              width={10}
            />
          );
        })}
      </svg>
      {layout.connectors.map((c, i) =>
        c.particles.map((p) => {
          const box = { x: NODE_X, y: Math.min(c.y1, c.y2), width: LINE_X - NODE_X - 30, height: Math.abs(c.y2 - c.y1) };
          return <FlowParticles key={`${i}-${p.id}`} clock={clock} object={p} box={box} defaultMotion={layout.direction === "up" ? "rise" : "fall"} />;
        }),
      )}
      {layout.connectors.map((c, i) =>
        c.arrow ? (
          <div
            key={`label-${i}`}
            style={{
              position: "absolute",
              left: LINE_X + 34,
              top: (c.y1 + c.y2) / 2 - 36,
              ...entranceStyle(clock.reveal(c.arrow.id), 16),
            }}
          >
            <Label text={c.arrow.label} emphasis={clock.emphasis(c.arrow.id)} maxWidth={STAGE.x + STAGE.width - LINE_X - 34} />
          </div>
        ) : null,
      )}
      {layout.nodes.map(({ object, box }) => (
        <FlowNode key={object.id} clock={clock} object={object} box={box} />
      ))}
    </>
  );
};

const Strip: React.FC<{ clock: SceneClock; layout: ProcessFlowLayout }> = ({ clock, layout }) => {
  const strip = layout.strip!;
  const iconSize = 150;
  const iconsWidth = layout.icons.length * (iconSize + 60);
  return (
    <>
      {layout.stripParticles.map((p) => (
        <FlowParticles
          key={p.id}
          clock={clock}
          object={p}
          box={{ x: strip.x + 40, y: strip.y, width: strip.width - 80 - iconsWidth, height: strip.height }}
          defaultMotion="drift"
          showLabel
        />
      ))}
      {layout.icons.map((icon, i) => {
        const reveal = clock.reveal(icon.id);
        const emphasis = clock.emphasis(icon.id);
        const left = strip.x + strip.width - (i + 1) * (iconSize + 60) + 30;
        const spin = icon.label.toLowerCase().includes("sun") ? clock.frame * 0.4 : 0;
        return (
          <div
            key={icon.id}
            style={{
              position: "absolute",
              left,
              top: strip.y + 10,
              width: iconSize,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              opacity: reveal,
              transform: `scale(${0.6 + 0.4 * reveal + 0.12 * emphasis})`,
            }}
          >
            <Icon name={iconFor(icon)} size={iconSize} style={{ transform: `rotate(${spin}deg)` }} />
            <Text size={FONT_SIZE.small} weight={600} color={COLORS.inkMuted} align="center">
              {icon.label}
            </Text>
          </div>
        );
      })}
    </>
  );
};

const FlowNode: React.FC<{ clock: SceneClock; object: TimelineObject; box: Box }> = ({ clock, object, box }) => {
  const reveal = clock.reveal(object.id);
  const offset = clock.has(object.id, "rise") ? 90 : clock.has(object.id, "fall") ? -90 : 30;
  const emphasis = clock.emphasis(object.id);
  const flow = clock.action(object.id, "flow");
  return (
    <div
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        opacity: reveal,
        transform: `translateY(${(1 - reveal) * offset}px)`,
      }}
    >
      <Card emphasis={Math.max(emphasis, flow > 0 && flow < 1 ? 1 - flow : 0)} style={{ height: "100%", display: "flex", alignItems: "center", gap: 28, padding: "0 32px" }}>
        <Circle size={box.height - 44} color={COLORS.accentSoft}>
          <Icon name={iconFor(object)} size={(box.height - 44) * 0.62} />
        </Circle>
        <Text size={box.height >= 130 ? FONT_SIZE.body + 4 : FONT_SIZE.body} weight={700} lineHeight={1.1}>
          {object.label}
        </Text>
      </Card>
    </div>
  );
};

const FlowParticles: React.FC<{
  clock: SceneClock;
  object: TimelineObject;
  box: Box;
  defaultMotion: "rise" | "fall" | "drift";
  showLabel?: boolean;
}> = ({ clock, object, box, defaultMotion, showLabel = false }) => {
  const reveal = clock.reveal(object.id);
  if (reveal <= 0) return null;
  const event = (action: string) => clock.scene.events.find((e) => e.target === object.id && e.action === action);
  const fall = event("fall");
  const rise = event("rise");
  const speedUp = event("speed-up");
  const gatherEvent = event("gather");

  // Travel is integrated from event start frames so switching motion never makes particles jump.
  let motion: "rise" | "fall" | "drift" = defaultMotion;
  let travelFrames = clock.frame - clock.scene.startFrame;
  if (fall) {
    motion = clock.frame >= fall.startFrame ? "fall" : "drift";
    travelFrames = Math.max(0, clock.frame - fall.startFrame) * 1.6;
  } else if (rise) {
    motion = clock.frame >= rise.startFrame ? "rise" : "drift";
    travelFrames = Math.max(0, clock.frame - rise.startFrame);
  }
  const speedProgress = speedUp ? clock.action(object.id, "speed-up") : 0;
  if (speedUp) travelFrames += Math.max(0, clock.frame - speedUp.startFrame) * 2 * speedProgress;
  const gather = gatherEvent ? clock.action(object.id, "gather") * (fall ? 1 - clock.action(object.id, "fall") : 1) : 0;
  // Rain and drops fall as drop shapes; anything else (particles, vapour) is drawn as dots.
  const isWater = /rain|drop|बारिश|बूंद/i.test(object.label);

  return (
    <>
      <Particles
        seedKey={object.id}
        frame={clock.frame}
        travel={travelFrames}
        box={box}
        motion={motion === "drift" ? "drift" : motion}
        speed={mix(1, 2.6, speedProgress)}
        gather={gather}
        opacity={reveal}
        shape={isWater ? "drop" : "dot"}
        count={showLabel ? 26 : 16}
      />
      {showLabel && (
        <div style={{ position: "absolute", left: box.x, top: box.y + box.height - 50, ...entranceStyle(reveal, 10) }}>
          <Label text={object.label} size={FONT_SIZE.small} emphasis={clock.emphasis(object.id)} />
        </div>
      )}
    </>
  );
};
