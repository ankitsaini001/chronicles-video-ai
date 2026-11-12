import type React from "react";
import { AbsoluteFill, Composition, type CalculateMetadataFunction } from "remotion";
import { Captions } from "./Captions";
import { Explainer, type ExplainerProps } from "./Explainer";
import { loadPackagedFonts } from "./fonts";
import { DEVANAGARI_SAMPLES, devanagariSample, patternGallery, waterCycleFixture } from "./samples";
import { CANVAS, COLORS, FONT_FAMILY } from "@bytereel/pipeline/theme";

loadPackagedFonts();

/** Duration always comes from the compiled timeline, never from a hard-coded number. */
const fromTimeline: CalculateMetadataFunction<ExplainerProps> = ({ props }) => ({
  durationInFrames: props.timeline.totalFrames,
  fps: props.timeline.fps,
  width: props.timeline.width,
  height: props.timeline.height,
});

/**
 * Compositions:
 * - Explainer: the pipeline composition (render-fixture passes timeline + captions as input props).
 *   In Studio it previews the water-cycle fixture with synthetic silent timing.
 * - PatternGallery: Studio-only review of all 8 pattern components with sample data.
 * - DevanagariCheck: Studio/still-only check that Hindi conjuncts and matras shape correctly.
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Explainer"
      component={Explainer}
      defaultProps={{ ...waterCycleFixture(), showSafeZones: false }}
      calculateMetadata={fromTimeline}
      durationInFrames={1800}
      fps={CANVAS.fps}
      width={CANVAS.width}
      height={CANVAS.height}
    />
    <Composition
      id="PatternGallery"
      component={Explainer}
      defaultProps={{ ...patternGallery(), showSafeZones: false }}
      calculateMetadata={fromTimeline}
      durationInFrames={1200}
      fps={CANVAS.fps}
      width={CANVAS.width}
      height={CANVAS.height}
    />
    <Composition id="DevanagariCheck" component={DevanagariCheck} durationInFrames={150} fps={CANVAS.fps} width={CANVAS.width} height={CANVAS.height} />
  </>
);

const DevanagariCheck: React.FC = () => {
  const sample = devanagariSample();
  return (
    <AbsoluteFill style={{ background: COLORS.background }}>
      <Explainer timeline={sample.timeline} captions={{ ...sample.captions, captions: [] }} />
      <AbsoluteFill style={{ top: 1170, left: 80, right: 80, height: 130, fontFamily: FONT_FAMILY, color: COLORS.ink, display: "flex", flexDirection: "column", gap: 4 }}>
        {DEVANAGARI_SAMPLES.slice(2, 4).map((text, i) => (
          <div key={text} style={{ fontSize: 44 - i * 4, fontWeight: i === 0 ? 700 : 500 }}>
            {text}
          </div>
        ))}
      </AbsoluteFill>
      <Captions track={sample.captions} />
    </AbsoluteFill>
  );
};
