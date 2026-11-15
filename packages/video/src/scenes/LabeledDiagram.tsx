import type React from "react";
import type { TimelineObject } from "@bytereel/pipeline/contracts";
import { AbsoluteFill } from "remotion";
import { CameraView } from "../camera";
import { HeroLayer } from "../heroes/HeroLayer";
import { COLUMNS, LONE_PART, partRowHeight, partTextBox } from "../layout";
import { clamp01, popIn, rise, wave } from "../motion";
import { C } from "../theme";
import { BoxText, Card, fitSize, textLines, Title } from "../ui";
import { activations, activeAmount, heroCamera, ofKind, TOP, type Activation, type Ctx, type Pattern } from "./shared";

/**
 * Labeled diagram (the parts of a thing): the thing's name as the title, the thing itself as the
 * hero inside a glowing ring, and its parts as big label cards below that appear in sync with the
 * narration (the part being talked about glows). The hero is a generic picture of the whole thing,
 * so no line points at a spot on it: that could show a part in the wrong place. Without a planner
 * pick the hero stays the diagram's own object (the compiler's hero track).
 */

const GRID_TOP = 870;

export const LabeledDiagram: Pattern = {
  camera: (ctx) => heroCamera(ctx),
  View: ({ ctx, cam }) => {
    const f = ctx.frame;
    const diagram = ofKind(ctx, "diagram")[0];
    const parts = ofKind(ctx, "part", "arrow").slice(0, 6);
    const titleSize = diagram ? fitSize(diagram.label, 900, 2, 78, 58) : 0;
    const titleBottom = diagram ? TOP + textLines(diagram.label, titleSize) * titleSize * 1.08 : TOP - 30;
    const rows = Math.ceil(parts.length / 2);
    const rowH = partRowHeight(rows);
    const gridTop = parts.length ? Math.max(GRID_TOP, 1265 - rows * (rowH + 16)) : 1300;
    const heroSpace = gridTop - 30 - (titleBottom + 30);
    const heroSize = Math.max(340, Math.min(parts.length ? 520 : 600, heroSpace));
    const heroY = titleBottom + 30 + heroSpace / 2;
    const acts = activations(ctx, parts);
    const ring = rise(f, (parts[0]?.revealFrame ?? ctx.scene.startFrame) - 6, 18);
    return (
      <AbsoluteFill>
        <CameraView cam={cam}>
          {diagram && <Title text={diagram.label} t={popIn(f, diagram.revealFrame)} top={TOP} size={titleSize} />}
          <svg width={1080} height={1920} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            <circle cx={540} cy={heroY} r={heroSize * 0.47} fill="none" stroke="#F5A524" strokeWidth={22} strokeOpacity={0.12 * ring} />
            <circle cx={540} cy={heroY} r={heroSize * 0.47} fill="none" stroke="#F5A524" strokeWidth={4} opacity={0.55 * ring} pathLength={1} strokeDasharray={`${ring} 1`} transform={`rotate(${-90 + wave(f, 400) * 8} 540 ${heroY})`} />
          </svg>
          <HeroLayer steps={ctx.scene.heroes} cues={ctx.heroCues} frame={f} cx={540} cy={heroY} size={heroSize * 0.86} />
          {parts.map((p, i) => {
            const row = Math.floor(i / 2);
            const lone = i === parts.length - 1 && parts.length % 2 === 1;
            // two equal columns inside the safe zone (the right one ends left of the Reels buttons)
            const col = lone ? LONE_PART : COLUMNS[i % 2]!;
            return <PartCard key={p.id} ctx={ctx} part={p} acts={acts} left={col.x} top={gridTop + row * (rowH + 16)} width={col.width} height={rowH} />;
          })}
        </CameraView>
      </AbsoluteFill>
    );
  },
};

/** A part's card: an amber dot and the label, big (no icon tile: the label is what matters here). */
const PartCard: React.FC<{ ctx: Ctx; part: TimelineObject; acts: Activation[]; left: number; top: number; width: number; height: number }> = ({ ctx, part, acts, left, top, width, height }) => {
  const f = ctx.frame;
  const t = popIn(f, part.revealFrame);
  if (t <= 0.001) return null;
  const act = activeAmount(acts, part.id, f);
  return (
    <div style={{ position: "absolute", left, top, width, height }}>
      <Card t={t} active={act} from={30} style={{ height: "100%", display: "flex", alignItems: "center", gap: 16, padding: "0 22px", boxSizing: "border-box" }}>
        <div style={{ width: 18, height: 18, flex: "none", borderRadius: "50%", background: "#F5A524", boxShadow: `0 0 ${Math.round(8 + 14 * act)}px rgba(245,165,36,0.8)` }} />
        <BoxText text={part.label} {...partTextBox(width, height)} style={{ color: act > 0.5 ? C.gold : C.text, opacity: clamp01(0.75 + act) }} />
      </Card>
    </div>
  );
};
