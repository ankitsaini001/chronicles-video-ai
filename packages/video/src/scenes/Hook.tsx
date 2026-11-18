import type { CaptionTrackWord } from "@bytereel/pipeline/contracts";
import { AbsoluteFill } from "remotion";
import { CameraView } from "../camera";
import { HeroLayer } from "../heroes/HeroLayer";
import { hookSlam } from "../hook-words";
import { HOOK_SUBTITLE_WIDTH } from "../layout";
import { clamp01, fall, glide, popIn, rise } from "../motion";
import { C, FONT, GRADIENTS } from "../theme";
import { fitSize, Flash, SlamWord, textLines, Title } from "../ui";
import { heroCamera, ofKind, TOP, type Pattern } from "./shared";

/**
 * Title / hook: the picture and the question from frame 1. When the narration opens with a natural
 * short unit (up to 3 words: "Did you know…", "Ever wondered why?"), those words slam in big over the
 * hero within the first few frames, then the headline (gold title) and the subtitle pill take over.
 * Otherwise (no cut-off fragments such as "Should your monthly…") the title is there from frame 1.
 * The slam rule: hook-words.ts.
 */

/** Slam font size: big, but the longest word must fit the safe width on its own line. */
const slamSize = (slam: CaptionTrackWord[]) => Math.min(132, Math.floor(900 / (0.62 * Math.max(4, ...slam.map((w) => w.text.length)) + 0.4)));

export const Hook: Pattern = {
  camera: (ctx) => {
    const { end } = hookSlam(ctx.words);
    const base = heroCamera(ctx);
    const punch = 1 + 0.06 * (1 - glide(ctx.frame, end, 16)) * rise(ctx.frame, ctx.scene.startFrame, 6);
    return { ...base, z: base.z * punch };
  },
  View: ({ ctx, cam }) => {
    const f = ctx.frame;
    const { slam, end } = hookSlam(ctx.words);
    const hasSlam = slam.length > 0;
    const headline = ofKind(ctx, "headline")[0];
    const subtitle = ofKind(ctx, "subtitle")[0];
    // the slam stays at least 1.2 s so picture + question share the first second
    const outAt = Math.max(end + 3, ctx.scene.startFrame + 36);
    const out = glide(f, outAt, 8);
    const lastSlam = slam[slam.length - 1];
    const needsDots = lastSlam && !/[.,?!…]$/.test(lastSlam.text);
    // without slam words the title (the hook's short question) is on screen from the first frame
    const titleAt = headline ? (hasSlam ? Math.max(headline.revealFrame, outAt + 6) : ctx.scene.startFrame) : 0;
    const titleT = headline ? popIn(f, titleAt) : 0;
    const titleSize = headline ? fitSize(headline.label, 900, 3, 82, 60) : 0;
    const titleBottom = headline ? TOP + 10 + textLines(headline.label, titleSize) * titleSize * 1.08 : TOP;
    const heroSize = 600;
    // below the title and the slam words (some hero art reaches a little above its box, e.g. a rain cloud)
    const slamBottom = hasSlam ? TOP + textLines(slam.map((w) => w.text).join(" "), slamSize(slam), 940) * slamSize(slam) * 1.02 : TOP;
    const heroY = Math.max(860, titleBottom + 30 + heroSize / 2 - 30, slamBottom + heroSize / 2 + 30);
    // the pill (padding 2 × 36) stays left of the Reels buttons
    const subSize = subtitle ? fitSize(subtitle.label, HOOK_SUBTITLE_WIDTH - 72, 2, 50, 38) : 0;
    const subTop = Math.min(1180, heroY + heroSize / 2 + 10);
    // the pill appears only once the hook's own punch-in (camera, up to × 1.06) has settled, so the
    // scene camera's zoom alone decides its right edge (tests/video-layout.test.ts)
    const subAt = subtitle ? Math.max(subtitle.revealFrame, end + 16) : 0;
    return (
      <AbsoluteFill>
        <CameraView cam={cam}>
          <HeroLayer steps={ctx.scene.heroes} cues={ctx.heroCues} frame={f} cx={540} cy={heroY} size={heroSize} />
          {headline && (
            <>
              <Title text={headline.label} t={titleT} top={TOP + 10} size={titleSize} />
              <div style={{ position: "absolute", left: 540 - 110, top: titleBottom + 18, width: 220 * rise(f, titleAt + 6, 16), height: 10, borderRadius: 5, background: GRADIENTS.button }} />
            </>
          )}
          {subtitle && (
            <div style={{ position: "absolute", left: 540 - HOOK_SUBTITLE_WIDTH / 2, width: HOOK_SUBTITLE_WIDTH, top: subTop, display: "flex", justifyContent: "center", opacity: clamp01(popIn(f, subAt) * 1.5), transform: `translateY(${(1 - Math.min(1, popIn(f, subAt))) * 30}px)` }}>
              <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: subSize, lineHeight: 1.15, textAlign: "center", textWrap: "balance", color: C.gold, background: "rgba(26,18,10,0.92)", border: "2px solid rgba(245,165,36,0.6)", borderRadius: 40, padding: "12px 36px", maxWidth: HOOK_SUBTITLE_WIDTH, boxSizing: "border-box", boxShadow: "0 0 26px rgba(245,165,36,0.3)" }}>
                {subtitle.label}
              </div>
            </div>
          )}
        </CameraView>
        <Flash amount={0.3 * fall(f, ctx.scene.startFrame, 12)} />
        {hasSlam && out < 1 && (
          <div style={{ position: "absolute", left: 70, width: 940, top: TOP, display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "baseline", transform: `scale(${1 + out * 0.4}) translateY(${-out * 40}px)`, opacity: 1 - out }}>
            {slam.map((w, i) => (
              // the whole question is on screen within the first few frames, even when it is said slowly
              <SlamWord key={i} text={i === slam.length - 1 && needsDots ? `${w.text}…` : w.text} frame={f} at={Math.min(w.startFrame, ctx.scene.startFrame + i * 4) - (i === 0 ? 1 : 0)} size={slamSize(slam)} color={i === slam.length - 1 ? C.amber : undefined} />
            ))}
          </div>
        )}
      </AbsoluteFill>
    );
  },
};
