import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { HERO_NAMES, heroTitle, type HeroName } from "@bytereel/pipeline/planning/hero-catalog";
import { Backdrop } from "./Backdrop";
import { loadPackagedFonts } from "./fonts";
import { HeroSvg } from "./heroes/HeroLayer";
import { C, FONT } from "./theme";

loadPackagedFonts();

export interface HeroGalleryProps {
  /** Which page of 12 heroes (3 x 4 grid) to show. */
  page: number;
  /** Or an explicit list of hero names (overrides `page`). */
  names?: HeroName[];
  [key: string]: unknown;
}

const PER_PAGE = 12;
/** Frames where every gallery hero "is named", so its cue animation can be reviewed. */
const CUES = [20, 80];

/** Studio / QA composition: the hero library as a grid, animated, to review the artwork at phone size. */
export const HeroGallery: React.FC<HeroGalleryProps> = ({ page, names }) => {
  const frame = useCurrentFrame();
  const list = names ?? HERO_NAMES.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  return (
    <AbsoluteFill style={{ background: "#0B0806", fontFamily: FONT }}>
      <Backdrop frame={frame} />
      {list.map((name, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        return (
          <div key={name} style={{ position: "absolute", left: col * 360, top: 40 + row * 465, width: 360, height: 465, display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ marginTop: 30 }}>
              <HeroSvg step={{ startFrame: 0, hero: name, icon: "bulb", source: "plan" }} size={320} frame={frame} cues={CUES} cueWords={CUES.map((c) => ({ frame: c, word: name === "rain-cloud" && c > 50 ? "snow" : name }))} since={0} />
            </div>
            <div style={{ marginTop: 26, fontSize: 34, fontWeight: 800, color: C.text }}>{heroTitle(name)}</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: C.muted }}>{name}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
