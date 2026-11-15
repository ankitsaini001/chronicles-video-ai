import type React from "react";
import { useMemo } from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import type { CaptionTrack, CaptionTrackWord, Timeline } from "@bytereel/pipeline/contracts";
import { SAFE_ZONE } from "@bytereel/pipeline/theme";
import { Backdrop } from "./Backdrop";
import { Captions, CaptionScrim } from "./Captions";
import { loadPackagedFonts } from "./fonts";
import { rise } from "./motion";
import { PATTERNS } from "./scenes";
import { hookCaptionStart } from "./hook-words";
import { sceneHeroCues, type Ctx } from "./scenes/shared";
import { FONT, LAYOUT } from "./theme";
import { LightWipe, ProgressBar } from "./ui";

loadPackagedFonts();

/** The background music file (generated in code by the render stage) in the render's public folder. */
export const MUSIC_FILE = "music-bed.wav";

export interface ExplainerProps {
  timeline: Timeline;
  captions: CaptionTrack;
  /** Play the generated music bed (public file MUSIC_FILE). Off for silent fixture renders. */
  music?: boolean;
  /** Studio-only helper: outline the Reels safe zones. Never on in pipeline renders. */
  showSafeZones?: boolean;
  [key: string]: unknown;
}

/** Frames a scene stays drawn around its edges, for the light-wipe cross-over. */
const PAD = 14;

/**
 * The Explainer composition, video style v4 (F22b): one big hero object per sentence on a dark
 * amber stage, the scene's pattern layout (8 patterns), phrase captions with the spoken word
 * highlighted, light-wipe transitions, a progress bar, and the narration (plus the optional music
 * bed). Draws only what timeline.json and captions.json say; it never calls AI and has no
 * randomness.
 */
export const Explainer: React.FC<ExplainerProps> = ({ timeline, captions, music = false, showSafeZones = false }) => {
  const frame = useCurrentFrame();
  const scenes = timeline.scenes;
  const wordsByScene = useMemo(() => {
    const map = new Map<string, CaptionTrackWord[]>();
    for (const c of captions.captions) map.set(c.sceneId, [...(map.get(c.sceneId) ?? []), ...c.words]);
    return map;
  }, [captions]);
  const cuesByScene = useMemo(() => new Map(scenes.map((s) => [s.sceneId, sceneHeroCues(s, wordsByScene.get(s.sceneId) ?? [])])), [scenes, wordsByScene]);
  const lastSpeech = useMemo(() => Math.max(0, ...captions.captions.map((c) => c.words[c.words.length - 1]?.endFrame ?? c.endFrame)), [captions]);
  const first = scenes[0];
  const skipBefore = first && first.type === "title-hook" ? hookCaptionStart(wordsByScene.get(first.sceneId) ?? []) : 0;

  return (
    <AbsoluteFill style={{ background: "#0B0806", fontFamily: FONT, overflow: "hidden" }}>
      <Backdrop frame={frame} />

      {scenes.map((scene, i) => {
        const start = scene.startFrame;
        const end = start + scene.durationFrames;
        if (frame < start - PAD || frame >= end + PAD) return null;
        const opacity = (i > 0 ? rise(frame, start - 3, 6) : 1) * (scenes[i + 1] ? 1 - rise(frame, end - 3, 6) : 1);
        if (opacity <= 0.001) return null;
        const pattern = PATTERNS[scene.type];
        const ctx: Ctx = { frame, language: timeline.language, scene, words: wordsByScene.get(scene.sceneId) ?? [], heroCues: cuesByScene.get(scene.sceneId)! };
        return (
          <AbsoluteFill key={scene.sceneId} style={{ opacity }}>
            <pattern.View ctx={ctx} cam={pattern.camera(ctx)} />
          </AbsoluteFill>
        );
      })}

      {scenes.slice(1).map((scene) => (
        <LightWipe key={scene.sceneId} frame={frame} at={scene.startFrame} />
      ))}

      {frame < lastSpeech + 20 && <CaptionScrim />}
      <Captions track={captions} frame={frame} skipBefore={skipBefore} />
      <ProgressBar frame={frame} total={timeline.totalFrames} ticks={scenes.slice(1).map((s) => s.startFrame)} />

      {scenes.map((scene) =>
        scene.audioKey ? (
          <Sequence key={`a-${scene.sceneId}`} from={scene.startFrame} durationInFrames={scene.durationFrames} name={`voice: ${scene.sceneId}`}>
            <Audio src={staticFile(scene.audioKey)} />
          </Sequence>
        ) : null,
      )}
      {music && <Audio src={staticFile(MUSIC_FILE)} />}
      {timeline.timingSource === "synthetic-silent-fixture" && <FixtureBadge />}
      {showSafeZones && <SafeZoneOverlay />}
    </AbsoluteFill>
  );
};

/** Always visible on synthetic/silent fixture renders, so they can never pass as live output. */
export const FixtureBadge: React.FC = () => (
  <div style={{ position: "absolute", top: SAFE_ZONE.top - 70, left: 0, width: LAYOUT.width, display: "flex", justifyContent: "center" }}>
    <div style={{ fontFamily: FONT, fontSize: 24, fontWeight: 800, letterSpacing: "0.08em", color: "#FFB4AB", background: "rgba(80,10,10,0.85)", border: "2px solid #FF6B6B", borderRadius: 999, padding: "6px 20px" }}>
      FIXTURE · SILENT · SYNTHETIC TIMING
    </div>
  </div>
);

const SafeZoneOverlay: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <div style={{ position: "absolute", left: 0, top: 0, width: LAYOUT.width, height: SAFE_ZONE.top, background: "rgba(255,0,0,0.18)" }} />
    <div style={{ position: "absolute", left: 0, bottom: 0, width: LAYOUT.width, height: SAFE_ZONE.bottom, background: "rgba(255,0,0,0.18)" }} />
    <div style={{ position: "absolute", right: 0, top: 960, width: SAFE_ZONE.rightUi, height: 960 - SAFE_ZONE.bottom, background: "rgba(255,0,0,0.18)" }} />
  </AbsoluteFill>
);
