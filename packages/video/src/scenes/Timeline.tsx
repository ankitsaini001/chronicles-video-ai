import { AbsoluteFill } from "remotion";
import { CameraView } from "../camera";
import { HeroLayer } from "../heroes/HeroLayer";
import { TIMELINE } from "../layout";
import { clamp01, popIn, rise } from "../motion";
import { C, FONT, LAYOUT } from "../theme";
import { fitSize, textLines, Title } from "../ui";
import { activations, activeAmount, activeAt, heroCamera, ofKind, TOP, type Pattern } from "./shared";

/**
 * Timeline (events in order): the title, the hero for the event being told, and a time line at
 * the bottom that draws itself from milestone to milestone with a travelling light. The milestone
 * being talked about glows and its name is written big under the line. The line ends left of the
 * Reels buttons (layout.ts TIMELINE).
 */

const LINE_Y = TIMELINE.lineY;

export const Timeline: Pattern = {
  camera: (ctx) => heroCamera(ctx),
  View: ({ ctx, cam }) => {
    const f = ctx.frame;
    const axis = ofKind(ctx, "axis")[0];
    const milestones = ofKind(ctx, "milestone").slice(0, 7);
    const n = milestones.length;
    const { left, right } = TIMELINE;
    const xs = milestones.map((_, i) => (n === 1 ? 540 : left + (i * (right - left)) / (n - 1)));
    const acts = activations(ctx, milestones);
    const now = activeAt(acts, f);
    const nowIndex = now ? milestones.findIndex((m) => m.id === now.id) : -1;
    const nowObj = nowIndex >= 0 ? milestones[nowIndex]! : null;
    const titleSize = axis ? fitSize(axis.label, 900, 2, 76, 56) : 0;
    const titleBottom = axis ? TOP + textLines(axis.label, titleSize) * titleSize * 1.08 : TOP - 30;
    const heroSize = Math.min(520, LINE_Y - 70 - (titleBottom + 30));
    const heroY = titleBottom + 30 + heroSize / 2;
    const revealed = milestones.filter((m) => f >= m.revealFrame).length;
    const reach = n <= 1 ? 0 : revealed <= 1 ? 0 : (revealed - 2 + rise(f, milestones[revealed - 1]!.revealFrame - 8, 18)) / (n - 1);
    const lineEnd = left + (right - left) * reach;
    const lastReveal = n ? milestones[n - 1]!.revealFrame : 0;
    const dotX = reach > 0.02 ? (f >= lastReveal + 20 ? left + (right - left) * (((f - lastReveal - 20) / 70) % 1) : lineEnd) : null;
    const half = TIMELINE.labelWidth / 2;
    const labelSize = nowObj ? fitSize(nowObj.label, TIMELINE.labelWidth, 2, 54, 42) : 0;
    const labelX = nowIndex >= 0 ? Math.max(90 + half, Math.min(LAYOUT.safeRight - half, xs[nowIndex]!)) : 540;
    return (
      <AbsoluteFill>
        <CameraView cam={cam}>
          {axis && <Title text={axis.label} t={popIn(f, axis.revealFrame)} top={TOP} size={titleSize} />}
          <HeroLayer steps={ctx.scene.heroes} cues={ctx.heroCues} frame={f} cx={540} cy={heroY} size={heroSize} />
          <svg width={1080} height={1920} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            <defs>
              <radialGradient id="tl-dot">
                <stop offset="0%" stopColor="#FFFFFF" />
                <stop offset="30%" stopColor="#FFE2A8" />
                <stop offset="60%" stopColor="#F5A524" stopOpacity={0.6} />
                <stop offset="100%" stopColor="#F5A524" stopOpacity={0} />
              </radialGradient>
            </defs>
            <line x1={left - 40} y1={LINE_Y} x2={right + 20} y2={LINE_Y} stroke="#F5A524" strokeWidth={4} strokeOpacity={0.22 * rise(f, ctx.scene.startFrame - 6, 12)} />
            {reach > 0 && (
              <>
                <line x1={left} y1={LINE_Y} x2={lineEnd} y2={LINE_Y} stroke="#F5A524" strokeWidth={24} strokeOpacity={0.18} strokeLinecap="round" />
                <line x1={left} y1={LINE_Y} x2={lineEnd} y2={LINE_Y} stroke="#F5A524" strokeWidth={8} strokeLinecap="round" />
              </>
            )}
            {dotX !== null && (
              <g transform={`translate(${dotX} ${LINE_Y})`}>
                <circle r={30} fill="url(#tl-dot)" />
                <circle r={7} fill="#FFFFFF" />
              </g>
            )}
            {milestones.map((m, i) => {
              const t = popIn(f, m.revealFrame);
              if (t <= 0.001) return null;
              const act = activeAmount(acts, m.id, f);
              const past = nowIndex > i;
              return (
                <g key={m.id} transform={`translate(${xs[i]} ${LINE_Y}) scale(${Math.min(1.08, t) * (1 + 0.3 * act)})`}>
                  <circle r={34} fill="#F5A524" opacity={0.25 * act} />
                  <circle r={20} fill={past || act > 0.5 ? "#F5A524" : "#1A120A"} stroke="#F5A524" strokeWidth={6} />
                  {act > 0.5 && <circle r={7} fill="#FFFFFF" />}
                </g>
              );
            })}
          </svg>
          {nowObj && (
            <div key={nowObj.id} style={{ position: "absolute", left: labelX - half, width: TIMELINE.labelWidth, top: LINE_Y + 46, textAlign: "center", fontFamily: FONT, fontWeight: 800, fontSize: labelSize, lineHeight: 1.08, color: C.gold, textWrap: "balance", opacity: clamp01(popIn(f, now!.frame) * 1.5), transform: `translateY(${(1 - Math.min(1, popIn(f, now!.frame))) * 20}px)` }}>
              {nowObj.label}
            </div>
          )}
        </CameraView>
      </AbsoluteFill>
    );
  },
};
