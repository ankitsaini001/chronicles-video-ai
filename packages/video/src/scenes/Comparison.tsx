import type React from "react";
import type { HeroStep, TimelineObject } from "@bytereel/pipeline/contracts";
import { heroForText } from "@bytereel/pipeline/planning/hero-catalog";
import { AbsoluteFill } from "remotion";
import { CameraView } from "../camera";
import { HeroLayer } from "../heroes/HeroLayer";
import { clamp01, pop, popIn, pulse } from "../motion";
import { C, FONT } from "../theme";
import { Card, fitSize } from "../ui";
import { activations, activeAmount, eventsOn, firstCue, heroCamera, iconOf, TOP, type Activation, type Ctx, type Pattern } from "./shared";

/**
 * Comparison (A vs B): two columns, each with its own hero object and name, a "VS" badge between
 * them, and the points under each column with a check or a cross when the narration says so. The
 * column being talked about glows; the other dims a little.
 */

/** Each point belongs to the column listed before it; if both columns come first, points alternate A, B, A, B. */
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
      result[(alternate % 2) as 0 | 1].push(object);
      alternate++;
    } else {
      result[current === 1 ? 1 : 0].push(object);
    }
  }
  return result;
}

/**
 * The hero of a column: the planner's pick for the narration where the column is first named, else
 * a hero its label names, else the hero on screen at that moment, else its icon in a medallion (also
 * when the planner said "none" for that narration). Two columns never show the same hero.
 */
export function columnHeroes(ctx: Ctx, columns: readonly TimelineObject[]): HeroStep[] {
  const used = new Set<string>();
  return columns.map((column) => {
    const at = firstCue(ctx, column);
    let step: HeroStep | undefined;
    for (const s of ctx.scene.heroes) if (s.startFrame <= Math.max(at, ctx.scene.startFrame)) step = s;
    if (step?.source === "plan" && step.hero === null) return { startFrame: ctx.scene.startFrame, hero: null, icon: iconOf(column), source: "plan" };
    const picks = [step?.source === "plan" ? step.hero : null, heroForText(column.label), step?.hero ?? null];
    const hero = picks.find((h): h is NonNullable<typeof h> => !!h && !used.has(h)) ?? null;
    if (hero) used.add(hero);
    return { startFrame: ctx.scene.startFrame, hero, icon: iconOf(column), source: hero ? "keyword" : "icon" };
  });
}

/** Two equal columns inside the safe zone (the right one ends left of the Reels buttons at x 940). */
const COLS = [
  { x: 75, width: 415 },
  { x: 525, width: 415 },
] as const;

export const Comparison: Pattern = {
  camera: (ctx) => heroCamera(ctx),
  View: ({ ctx, cam }) => {
    const f = ctx.frame;
    const columns = ctx.scene.objects.filter((o) => o.kind === "column").slice(0, 2);
    const points = assignPoints(ctx.scene.objects);
    const heroes = columnHeroes(ctx, columns);
    const all = [...columns, ...points[0], ...points[1]];
    const acts = activations(ctx, all);
    const activeColumn = (() => {
      let col = -1;
      for (const a of acts) {
        if (a.frame > f) break;
        const c = columns.findIndex((o) => o.id === a.id);
        col = c >= 0 ? c : points[0].some((p) => p.id === a.id) ? 0 : points[1].some((p) => p.id === a.id) ? 1 : col;
      }
      return col;
    })();
    const heroY = TOP + 190;
    const vs = popIn(f, Math.max(...columns.map((c) => c.revealFrame)));
    return (
      <AbsoluteFill>
        <CameraView cam={cam}>
          {columns.map((column, i) => {
            const t = popIn(f, column.revealFrame);
            const lit = activeColumn === i ? 1 : activeColumn === -1 ? 0.5 : 0;
            const col = COLS[i]!;
            const cx = col.x + col.width / 2;
            const titleSize = fitSize(column.label, col.width, 2, 54, 42);
            return (
              <div key={column.id} style={{ opacity: clamp01(t * 1.5) * (0.55 + 0.45 * Math.max(lit, activeColumn === -1 ? 1 : 0)) }}>
                <HeroLayer steps={[heroes[i]!]} cues={ctx.heroCues} frame={f} cx={cx} cy={heroY} size={340} />
                <div style={{ position: "absolute", left: col.x - 10, width: col.width + 20, top: heroY + 172, textAlign: "center", fontFamily: FONT, fontWeight: 800, fontSize: titleSize, lineHeight: 1.08, color: lit > 0.5 ? C.gold : C.text, textWrap: "balance" }}>
                  {column.label}
                </div>
              </div>
            );
          })}
          {columns.length === 2 && vs > 0.001 && (
            <div style={{ position: "absolute", left: 507 - 52, top: heroY - 52, width: 104, height: 104, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(180deg, #F7B44A, #E8901A)", boxShadow: "0 0 30px rgba(245,165,36,0.6)", fontFamily: FONT, fontWeight: 800, fontSize: 44, color: "#1A1005", transform: `scale(${Math.min(1.1, vs)})` }}>
              VS
            </div>
          )}
          {points.map((list, i) => (
            <PointList key={i} ctx={ctx} list={list.slice(0, 3)} col={COLS[i]!} top={heroY + 318} acts={acts} />
          ))}
        </CameraView>
      </AbsoluteFill>
    );
  },
};

const PointList: React.FC<{ ctx: Ctx; list: TimelineObject[]; col: (typeof COLS)[number]; top: number; acts: Activation[] }> = ({ ctx, list, col, top, acts }) => {
  const f = ctx.frame;
  const space = 1270 - top;
  const rowH = Math.min(160, (space - (list.length - 1) * 14) / Math.max(1, list.length));
  return (
    <>
      {list.map((p, i) => {
        const t = popIn(f, p.revealFrame);
        if (t <= 0.001) return null;
        const act = activeAmount(acts, p.id, f);
        const mark = eventsOn(ctx, p.id).find((e) => e.action === "check" || e.action === "cross");
        const marked = mark ? pop(f, mark.startFrame, 260, 12) : 0;
        const size = fitSize(p.label, col.width - 100, rowH >= 140 ? 3 : 2, 46, 38);
        return (
          <div key={p.id} style={{ position: "absolute", left: col.x, width: col.width, top: top + i * (rowH + 14), height: rowH }}>
            <Card t={t} active={Math.max(act, 0.6 * pulse(f, mark?.startFrame ?? -99, 30))} from={24} style={{ height: "100%", display: "flex", alignItems: "center", gap: 14, padding: "0 16px", boxSizing: "border-box" }}>
              <svg width={56} height={56} viewBox="-31 -31 62 62" style={{ flex: "none" }}>
                {mark ? (
                  <>
                    <circle r={27} fill={mark.action === "check" ? "#4FD1A0" : "#FF6B6B"} transform={`scale(${0.6 + 0.4 * Math.min(1.1, marked)})`} opacity={marked > 0.02 ? 1 : 0.25} />
                    {marked > 0.02 &&
                      (mark.action === "check" ? (
                        <path d="M -12 1 L -3 10 L 13 -8" fill="none" stroke="#0B0806" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
                      ) : (
                        <path d="M -9 -9 L 9 9 M 9 -9 L -9 9" fill="none" stroke="#0B0806" strokeWidth={6} strokeLinecap="round" />
                      ))}
                  </>
                ) : (
                  <circle r={10} fill="#F5A524" />
                )}
              </svg>
              <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 1.1, color: act > 0.5 ? C.gold : C.text, textWrap: "balance" }}>{p.label}</span>
            </Card>
          </div>
        );
      })}
    </>
  );
};
