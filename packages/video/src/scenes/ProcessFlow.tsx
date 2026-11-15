import type React from "react";
import type { TimelineObject } from "@bytereel/pipeline/contracts";
import { AbsoluteFill } from "remotion";
import { CameraView } from "../camera";
import { spline } from "../geometry";
import { HeroLayer } from "../heroes/HeroLayer";
import { clamp01, popIn, rise } from "../motion";
import { C, FONT } from "../theme";
import { activations, activeAmount, activeAt, BigCard, heroCamera, TOP, type Ctx, type Pattern } from "./shared";

/**
 * Process flow (cause -> effect, cycles, pipelines): the current step in a big card at the top,
 * the hero in the middle, and a numbered step rail at the bottom whose arrows draw themselves with
 * a travelling light. The rail has no small labels or icons: the big card names the step (labels
 * at rail size were too small to read, and a small icon next to the big hero showed it twice).
 */

/** Nodes in plan order and the arrow object (if any) on each connector between them. */
export function processChain(objects: readonly TimelineObject[]): { nodes: TimelineObject[]; arrows: (TimelineObject | null)[] } {
  const nodes = objects.filter((o) => o.kind === "node");
  const arrows: (TimelineObject | null)[] = Array.from({ length: Math.max(0, nodes.length - 1) }, () => null);
  objects.forEach((object, index) => {
    if (object.kind !== "arrow" || arrows.length === 0) return;
    let before = -1;
    for (let i = index - 1; i >= 0; i--) if (objects[i]!.kind === "node") { before = nodes.indexOf(objects[i]!); break; }
    let slot = before === -1 ? 0 : Math.min(before, arrows.length - 1);
    while (slot < arrows.length - 1 && arrows[slot]) slot++;
    if (!arrows[slot]) arrows[slot] = object;
  });
  return { nodes, arrows };
}

const RAIL_Y = 1130;

export const ProcessFlow: Pattern = {
  camera: (ctx) => heroCamera(ctx),
  View: ({ ctx, cam }) => {
    const f = ctx.frame;
    const { nodes, arrows } = processChain(ctx.scene.objects);
    const talked = [...nodes, ...arrows.filter((a): a is TimelineObject => !!a), ...ctx.scene.objects.filter((o) => o.kind === "icon" || o.kind === "particles")];
    const acts = activations(ctx, talked);
    const now = activeAt(acts, f);
    const nowObj = now ? ctx.scene.objects.find((o) => o.id === now.id) ?? null : null;
    return (
      <AbsoluteFill>
        <CameraView cam={cam}>
          <HeroLayer steps={ctx.scene.heroes} cues={ctx.heroCues} frame={f} cx={540} cy={740} size={560} />
          {nowObj && (
            <div key={nowObj.id} style={{ position: "absolute", left: 0, width: 1080, top: TOP, display: "flex", justifyContent: "center" }}>
              <BigCard ctx={ctx} object={nowObj} at={now!.frame} size={66} />
            </div>
          )}
          {nodes.length > 0 && <StepRail ctx={ctx} nodes={nodes} arrows={arrows} y={RAIL_Y} activeIds={acts} />}
        </CameraView>
      </AbsoluteFill>
    );
  },
};

/** Numbered nodes on a rail with self-drawing arrows and a light that travels along the drawn part. */
const StepRail: React.FC<{ ctx: Ctx; nodes: TimelineObject[]; arrows: (TimelineObject | null)[]; y: number; activeIds: ReturnType<typeof activations> }> = ({ ctx, nodes, arrows, y, activeIds }) => {
  const f = ctx.frame;
  const n = nodes.length;
  const size = n <= 4 ? 108 : 92;
  const left = 190;
  const right = 890;
  const xs = nodes.map((_, i) => (n === 1 ? 540 : left + (i * (right - left)) / (n - 1)));
  const revealed = nodes.filter((o) => f >= o.revealFrame).length;
  const lastReveal = nodes[n - 1]!.revealFrame;
  return (
    <>
      <svg width={1080} height={1920} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {arrows.map((arrow, i) => {
          const at = arrow ? Math.min(arrow.revealFrame, nodes[i + 1]!.revealFrame - 6) : nodes[i + 1]!.revealFrame - 6;
          const draw = rise(f, at, 18);
          if (draw <= 0.001) return null;
          const x1 = xs[i]! + size / 2 + 12;
          const x2 = xs[i + 1]! - size / 2 - 22;
          const head = x1 + (x2 - x1) * draw;
          const line = spline([{ x: x1, y }, { x: x2, y }]);
          // the light runs along the connector that was drawn last, then loops over the whole rail
          const dotT = f >= lastReveal + 20 ? ((f - lastReveal - 20) / 45) % 1 : i === revealed - 2 ? draw : null;
          const dot = dotT === null ? null : line.at(dotT);
          return (
            <g key={i}>
              <line x1={x1} y1={y} x2={head} y2={y} stroke="#F5A524" strokeWidth={26} strokeOpacity={0.18} strokeLinecap="round" />
              <line x1={x1} y1={y} x2={head} y2={y} stroke="#F5A524" strokeWidth={9} strokeLinecap="round" />
              {draw > 0.15 && <polygon points={`${head + 24},${y} ${head - 8},${y - 18} ${head},${y} ${head - 8},${y + 18}`} fill="#F5A524" opacity={clamp01((draw - 0.15) * 5)} />}
              {dot && (
                <g transform={`translate(${dot.x} ${dot.y})`}>
                  <circle r={30} fill="url(#rail-dot)" />
                  <circle r={7} fill="#FFFFFF" />
                </g>
              )}
            </g>
          );
        })}
        <defs>
          <radialGradient id="rail-dot">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="30%" stopColor="#FFE2A8" />
            <stop offset="60%" stopColor="#F5A524" stopOpacity={0.6} />
            <stop offset="100%" stopColor="#F5A524" stopOpacity={0} />
          </radialGradient>
        </defs>
      </svg>
      {nodes.map((o, i) => {
        const t = popIn(f, o.revealFrame);
        if (t <= 0.001) return null;
        const act = activeAmount(activeIds, o.id, f);
        // passed steps are filled amber; the newest step glows
        const done = i < revealed - 1;
        return (
          <div
            key={o.id}
            style={{
              position: "absolute",
              left: xs[i]! - size / 2,
              top: y - size / 2,
              width: size,
              height: size,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: done ? "linear-gradient(180deg, #F7B44A, #E8901A)" : "radial-gradient(circle at 35% 30%, #2A1D10, #120C07 75%)",
              border: `4px solid rgba(245,165,36,${0.45 + 0.55 * act})`,
              boxShadow: `0 0 ${Math.round(14 + 30 * act)}px rgba(245,165,36,${(0.25 + 0.45 * act).toFixed(2)})`,
              opacity: clamp01(t * 1.6),
              transform: `scale(${(Math.min(1.05, t) * (1 + 0.12 * act)).toFixed(3)})`,
              fontFamily: FONT,
              fontWeight: 800,
              fontSize: size * 0.46,
              color: done ? "#1A1005" : act > 0.5 ? C.gold : C.text,
            }}
          >
            {i + 1}
          </div>
        );
      })}
    </>
  );
};
