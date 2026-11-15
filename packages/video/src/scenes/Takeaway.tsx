import type React from "react";
import type { TimelineObject } from "@bytereel/pipeline/contracts";
import { AbsoluteFill } from "remotion";
import { CameraView } from "../camera";
import { HeroLayer } from "../heroes/HeroLayer";
import { clamp01, pop, popIn, pulse, rise } from "../motion";
import { C, FONT } from "../theme";
import { Card, fitSize, textLines, Title } from "../ui";
import { eventsOn, heroCamera, lastWordEnd, ofKind, TOP, type Ctx, type Pattern } from "./shared";

/**
 * Takeaway (and the end card): the key idea as a gold title, the hero with an endless loop of light
 * around it, and big checklist rows that tick as they are said. The end card shows only the
 * takeaway: no "Follow for more" button.
 */

const checkAt = (ctx: Ctx, b: TimelineObject) => {
  const ev = eventsOn(ctx, b.id);
  return ev.length ? Math.min(...ev.map((e) => e.startFrame)) : b.revealFrame + 20;
};

export const Takeaway: Pattern = {
  camera: (ctx) => heroCamera(ctx),
  View: ({ ctx, cam }) => {
    const f = ctx.frame;
    const headline = ofKind(ctx, "headline")[0];
    const bullets = ofKind(ctx, "bullet").slice(0, 4);
    const titleSize = headline ? fitSize(headline.label, 900, 2, 88, 62) : 0;
    const titleBottom = headline ? TOP + textLines(headline.label, titleSize) * titleSize * 1.08 : TOP - 40;
    const rowH = bullets.length >= 3 ? 112 : 136;
    const font = bullets.length >= 3 ? 46 : 52;
    const listTop = 1250 - bullets.length * (rowH + 18) + 18;
    const space = (bullets.length ? listTop - 30 : 1250) - (titleBottom + 30);
    const heroSize = Math.max(320, Math.min(bullets.length ? 440 : 600, space));
    const orbit = { cx: 540, cy: titleBottom + 30 + space / 2, rx: heroSize * 0.75, ry: heroSize * 0.23, tilt: -12 };
    const endAt = lastWordEnd(ctx);
    const lastCheck = Math.max(ctx.scene.startFrame, ...bullets.map((b) => checkAt(ctx, b)));
    const speed = 1 + 1.4 * rise(f, lastCheck - 70, 20);
    const phase = ((f - ctx.scene.startFrame) * 0.011 * speed) % 1;
    const point = (t: number) => {
      const a = t * Math.PI * 2;
      const x = Math.cos(a) * orbit.rx;
      const y = Math.sin(a) * orbit.ry;
      const r = (orbit.tilt * Math.PI) / 180;
      return { x: orbit.cx + x * Math.cos(r) - y * Math.sin(r), y: orbit.cy + x * Math.sin(r) + y * Math.cos(r), front: Math.sin(a) > 0 };
    };
    const dots = [0, 0.5].map((o) => point((phase + o) % 1));
    const draw = rise(f, ctx.scene.startFrame + 4, 30);
    const flare = pulse(f, endAt - 24, 40);
    const ring = (front: boolean) => (
      <>
        <ellipse cx={orbit.cx} cy={orbit.cy} rx={orbit.rx} ry={orbit.ry} transform={`rotate(${orbit.tilt} ${orbit.cx} ${orbit.cy})`} fill="none" stroke="#F5A524" strokeOpacity={0.18} strokeWidth={front ? 28 : 18} pathLength={1} strokeDasharray={front ? `${0.5 * draw} 1` : `0 0.5 ${0.5 * draw} 1`} />
        <ellipse cx={orbit.cx} cy={orbit.cy} rx={orbit.rx} ry={orbit.ry} transform={`rotate(${orbit.tilt} ${orbit.cx} ${orbit.cy})`} fill="none" stroke="#F5A524" strokeWidth={front ? 9 + 5 * flare : 6} pathLength={1} strokeDasharray={front ? `${0.5 * draw} 1` : `0 0.5 ${0.5 * draw} 1`} opacity={front ? 1 : 0.5} />
      </>
    );
    const dot = (d: { x: number; y: number }, i: number) => (
      <g key={i}>
        <circle cx={d.x} cy={d.y} r={32} fill="url(#take-dot)" />
        <circle cx={d.x} cy={d.y} r={7} fill="#FFFFFF" />
      </g>
    );
    const defs = (
      <defs>
        <radialGradient id="take-dot">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="30%" stopColor="#FFE2A8" />
          <stop offset="60%" stopColor="#F5A524" stopOpacity={0.6} />
          <stop offset="100%" stopColor="#F5A524" stopOpacity={0} />
        </radialGradient>
      </defs>
    );
    return (
      <AbsoluteFill>
        <CameraView cam={cam}>
          {headline && <Title text={headline.label} t={pop(f, headline.revealFrame, 240, 12)} top={TOP} size={titleSize} />}
          <svg width={1080} height={1920} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            {defs}
            {ring(false)}
            {dots.filter((d) => !d.front).map(dot)}
          </svg>
          <HeroLayer steps={ctx.scene.heroes} cues={ctx.heroCues} frame={f} cx={orbit.cx} cy={orbit.cy} size={heroSize} />
          <svg width={1080} height={1920} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            {defs}
            {ring(true)}
            {dots.filter((d) => d.front).map(dot)}
          </svg>
          {bullets.map((b, i) => (
            <Bullet key={b.id} ctx={ctx} b={b} top={listTop + i * (rowH + 18)} height={rowH} font={font} />
          ))}
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", boxShadow: `inset 0 0 ${Math.round(120 * flare)}px rgba(245,165,36,${(0.25 * flare).toFixed(3)})` }} />
        </CameraView>
      </AbsoluteFill>
    );
  },
};

const Bullet: React.FC<{ ctx: Ctx; b: TimelineObject; top: number; height: number; font: number }> = ({ ctx, b, top, height, font }) => {
  const f = ctx.frame;
  const done = pop(f, checkAt(ctx, b), 260, 12);
  const glow = pulse(f, checkAt(ctx, b), 30);
  const size = fitSize(b.label, 660, 2, font, 38);
  return (
    <div style={{ position: "absolute", left: 95, width: 845, top, height }}>
      <Card t={popIn(f, b.revealFrame)} active={Math.max(glow, 0.35 * clamp01(done))} from={30} style={{ height: "100%", display: "flex", alignItems: "center", gap: 28, padding: "0 32px", boxSizing: "border-box" }}>
        <svg width={84} height={84} viewBox="-42 -42 84 84" style={{ flex: "none" }}>
          <circle r={37} fill={done > 0.05 ? "#F5A524" : "transparent"} stroke="#F5A524" strokeWidth={5} transform={`scale(${done > 0.05 ? 0.75 + 0.25 * Math.min(1.15, done) : 1})`} />
          {done > 0.05 && <path d="M -16 2 L -5 13 L 17 -11" transform="scale(1.5)" fill="none" stroke="#1A1005" strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={`${clamp01(done)} 2`} />}
        </svg>
        <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 1.1, color: done > 0.5 ? C.text : "#D9CBB8", textWrap: "balance" }}>{b.label}</span>
      </Card>
    </div>
  );
};
