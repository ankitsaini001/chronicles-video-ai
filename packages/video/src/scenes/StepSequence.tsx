import { AbsoluteFill } from "remotion";
import { CameraView } from "../camera";
import { HeroLayer } from "../heroes/HeroLayer";
import { clamp01, pop, popIn, pulse, rise } from "../motion";
import { C, FONT, GRADIENTS } from "../theme";
import { Card, fitSize } from "../ui";
import { activations, activeAt, eventsOn, heroCamera, ofKind, TOP, type Pattern } from "./shared";

/**
 * Step sequence (ordered steps, one by one): "STEP 2 OF 4" with a segmented progress bar at the top,
 * the hero in the middle, and the current step in a big card with its number at the bottom. A step
 * whose narration says it is done ("complete") gets a check on its number.
 */

/** "STEP 2 OF 4" in the video's language. */
const stepOf = (language: string, i: number, n: number) => (language === "hi" ? `चरण ${i} / ${n}` : language === "hinglish" ? `STEP ${i} / ${n}` : `STEP ${i} OF ${n}`);

export const StepSequence: Pattern = {
  camera: (ctx) => heroCamera(ctx),
  View: ({ ctx, cam }) => {
    const f = ctx.frame;
    const steps = ofKind(ctx, "step").slice(0, 6);
    const n = steps.length;
    const acts = activations(ctx, steps);
    const now = activeAt(acts, f);
    const index = now ? steps.findIndex((s) => s.id === now.id) : -1;
    const step = index >= 0 ? steps[index]! : null;
    const head = popIn(f, (steps[0]?.revealFrame ?? ctx.scene.startFrame) - 10);
    const segW = Math.min(150, (760 - (n - 1) * 14) / Math.max(1, n));
    const segLeft = 540 - (n * segW + (n - 1) * 14) / 2;
    const complete = step ? eventsOn(ctx, step.id).find((e) => e.action === "complete") : undefined;
    const done = complete ? pop(f, complete.startFrame, 260, 12) : 0;
    const textSize = step ? fitSize(step.label, 600, 3, 56, 42) : 0;
    return (
      <AbsoluteFill>
        <CameraView cam={cam}>
          {n > 0 && (
            <div style={{ position: "absolute", left: 0, width: 1080, top: TOP, display: "flex", flexDirection: "column", alignItems: "center", gap: 22, opacity: clamp01(head * 1.5) }}>
              <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 46, letterSpacing: "0.08em", color: C.amberLight }}>{stepOf(ctx.language, Math.max(1, index + 1), n)}</div>
            </div>
          )}
          {steps.map((s, i) => {
            const fill = i < index ? 1 : i === index ? rise(f, now!.frame, 16) : 0;
            return (
              <div key={s.id} style={{ position: "absolute", left: segLeft + i * (segW + 14), top: TOP + 82, width: segW, height: 14, borderRadius: 7, background: "rgba(245,165,36,0.18)", opacity: clamp01(head * 1.5) }}>
                <div style={{ width: `${fill * 100}%`, height: "100%", borderRadius: 7, background: GRADIENTS.button, boxShadow: i === index ? "0 0 16px rgba(245,165,36,0.8)" : "none" }} />
              </div>
            );
          })}
          <HeroLayer steps={ctx.scene.heroes} cues={ctx.heroCues} frame={f} cx={540} cy={715} size={540} />
          {step && now && (
            <div key={step.id} style={{ position: "absolute", left: 95, width: 845, top: 1010, height: 250 }}>
              <Card t={pop(f, now.frame, 220, 14)} active={0.6 + 0.4 * pulse(f, now.frame, 30)} from={30} style={{ height: "100%", display: "flex", alignItems: "center", gap: 30, padding: "0 34px", boxSizing: "border-box" }}>
                <div style={{ width: 130, height: 130, flex: "none", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: GRADIENTS.button, boxShadow: "0 0 28px rgba(245,165,36,0.55)", fontFamily: FONT, fontWeight: 800, fontSize: 70, color: "#1A1005", position: "relative" }}>
                  {done > 0.05 ? (
                    <svg width={80} height={80} viewBox="-40 -40 80 80">
                      <path d="M -22 2 L -7 17 L 23 -15" fill="none" stroke="#1A1005" strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={`${clamp01(done)} 2`} />
                    </svg>
                  ) : (
                    index + 1
                  )}
                </div>
                <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: textSize, lineHeight: 1.12, color: C.text, textWrap: "balance" }}>{step.label}</span>
              </Card>
            </div>
          )}
        </CameraView>
      </AbsoluteFill>
    );
  },
};
