import type React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import type { CaptionTrack, Timeline, TimelineScene } from "../contracts";
import { makeSceneClock } from "./anim";
import { Captions } from "./Captions";
import { loadPackagedFonts } from "./fonts";
import { PATTERN_COMPONENTS } from "./patterns";
import { CANVAS, CAPTION_ZONE, COLORS, FONT_FAMILY, SAFE_ZONE, STAGE } from "./theme";

loadPackagedFonts();

export interface ExplainerProps {
  timeline: Timeline;
  captions: CaptionTrack;
  /** Studio-only helper: outline the Reels safe zones. Never on in pipeline renders. */
  showSafeZones?: boolean;
  [key: string]: unknown;
}

/**
 * The Explainer composition: one <Sequence> per compiled scene, placed at its exact start frame
 * (simple cuts), each scene's narration audio playing from that scene's start, captions on top,
 * and a permanent badge when timing is synthetic (live runs never show it).
 * Draws only what the timeline says; it never calls AI and has no randomness.
 */
export const Explainer: React.FC<ExplainerProps> = ({ timeline, captions, showSafeZones = false }) => {
  const synthetic = timeline.timingSource === "synthetic-silent-fixture";
  return (
    <AbsoluteFill style={{ background: COLORS.background, fontFamily: FONT_FAMILY }}>
      {timeline.scenes.map((scene) => (
        <Sequence key={scene.sceneId} from={scene.startFrame} durationInFrames={scene.durationFrames} name={`${scene.type}: ${scene.sceneId}`}>
          <SceneView scene={scene} />
          {scene.audioKey && <Audio src={staticFile(scene.audioKey)} />}
        </Sequence>
      ))}
      <Captions track={captions} />
      {synthetic && <FixtureBadge />}
      {showSafeZones && <SafeZoneOverlay />}
    </AbsoluteFill>
  );
};

const SceneView: React.FC<{ scene: TimelineScene }> = ({ scene }) => {
  const frame = useCurrentFrame() + scene.startFrame; // absolute frame, same numbers as timeline.json
  const Pattern = PATTERN_COMPONENTS[scene.type];
  return (
    <AbsoluteFill>
      <Pattern clock={makeSceneClock(scene, frame)} />
    </AbsoluteFill>
  );
};

/** Always visible on synthetic/silent fixture renders, so they can never pass as live output. */
export const FixtureBadge: React.FC = () => (
  <div style={{ position: "absolute", top: SAFE_ZONE.top + 6, left: 0, width: CANVAS.width, display: "flex", justifyContent: "center" }}>
    <div
      style={{
        fontFamily: FONT_FAMILY,
        fontSize: 26,
        fontWeight: 800,
        letterSpacing: "0.08em",
        color: COLORS.fixtureBadge,
        background: "#FDECEA",
        border: `3px solid ${COLORS.fixtureBadge}`,
        borderRadius: 999,
        padding: "8px 22px",
      }}
    >
      FIXTURE · SILENT · SYNTHETIC TIMING
    </div>
  </div>
);

const SafeZoneOverlay: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <div style={{ position: "absolute", left: 0, top: 0, width: CANVAS.width, height: SAFE_ZONE.top, background: "rgba(255,0,0,0.12)" }} />
    <div style={{ position: "absolute", left: 0, bottom: 0, width: CANVAS.width, height: SAFE_ZONE.bottom, background: "rgba(255,0,0,0.12)" }} />
    <div style={{ position: "absolute", right: 0, top: 960, width: SAFE_ZONE.rightUi, height: 960 - SAFE_ZONE.bottom, background: "rgba(255,0,0,0.12)" }} />
    <div style={{ position: "absolute", left: STAGE.x, top: STAGE.y, width: STAGE.width, height: STAGE.height, outline: "3px dashed rgba(37,99,235,0.6)" }} />
    <div style={{ position: "absolute", left: CAPTION_ZONE.left, top: CAPTION_ZONE.bottom - 220, width: CAPTION_ZONE.right - CAPTION_ZONE.left, height: 220, outline: "3px dashed rgba(232,129,26,0.7)" }} />
  </AbsoluteFill>
);
