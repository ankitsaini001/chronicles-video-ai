import type React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { CANVAS } from "@bytereel/pipeline/theme";
import { Explainer, type ExplainerProps } from "./Explainer";
import { HeroGallery } from "./HeroGallery";
import { waterCycleFixture } from "./samples";

/** Duration always comes from the compiled timeline, never from a hard-coded number. */
const fromTimeline: CalculateMetadataFunction<ExplainerProps> = ({ props }) => ({
  durationInFrames: props.timeline.totalFrames,
  fps: props.timeline.fps,
  width: props.timeline.width,
  height: props.timeline.height,
});

/**
 * Compositions:
 * - Explainer: the pipeline composition, video style v4 (render passes timeline + captions + music
 *   as input props). In Studio it previews the water-cycle fixture with synthetic silent timing.
 * - HeroGallery: Studio/QA review of the hero object library, 12 per page.
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Explainer"
      component={Explainer}
      defaultProps={{ ...waterCycleFixture(), music: false, showSafeZones: false }}
      calculateMetadata={fromTimeline}
      durationInFrames={1800}
      fps={CANVAS.fps}
      width={CANVAS.width}
      height={CANVAS.height}
    />
    <Composition id="HeroGallery" component={HeroGallery} defaultProps={{ page: 0 }} durationInFrames={150} fps={CANVAS.fps} width={CANVAS.width} height={CANVAS.height} />
  </>
);
