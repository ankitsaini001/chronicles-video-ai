import type React from "react";
import { useLayoutEffect, useRef } from "react";
import { cancelRender } from "remotion";
import type { CaptionTrack } from "@bytereel/pipeline/contracts";
import { CAPTION_STYLE } from "@bytereel/pipeline/theme";
import { pop } from "./motion";
import { C, FONT, LAYOUT } from "./theme";

/**
 * Phrase captions (F22b, video style v4): the compiled phrases of captions.json (3-5 words, at most
 * 2 pre-broken lines), big and bold, with the word being spoken in an amber pill and key terms in
 * amber. Placed in the Reels safe zone: above the bottom band, left of the button column.
 * `skipBefore`: words before this frame are shown elsewhere (the hook's slam words), so a phrase
 * shows only its later words (even when only one is left).
 *
 * Safety net: the compiler breaks lines with a width ESTIMATE (timing/text-width.ts). Each line is
 * measured here in the browser, and the render fails loudly if one is wider than the caption box,
 * so a wrong estimate can never ship as text running into the Reels buttons.
 */
export const Captions: React.FC<{ track: CaptionTrack; frame: number; skipBefore?: number }> = ({ track, frame, skipBefore = 0 }) => {
  const caption = track.captions.find((c) => frame >= c.startFrame && frame < c.endFrame);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  // each drawn line's index in caption.lines (the hook can hide a whole first line), for the error message
  const lineIndexes = useRef<number[]>([]);
  useLayoutEffect(() => {
    if (!caption) return;
    lineRefs.current.forEach((el, i) => {
      if (el && el.offsetWidth > LAYOUT.captionWidth + 0.5) {
        cancelRender(
          new Error(
            `Caption "${caption.id}" line ${(lineIndexes.current[i] ?? i) + 1} ("${caption.lines[lineIndexes.current[i] ?? i]}") is ${el.offsetWidth}px wide; the caption box fits ${LAYOUT.captionWidth}px. ` +
              "Lower CAPTION_STYLE.maxLineWidthPx or the caption font size.",
          ),
        );
      }
    });
  }, [caption, frame]);
  if (!caption) return null;
  const words = caption.words.filter((w) => w.startFrame >= skipBefore);
  if (words.length === 0) return null;
  // the lines split the phrase's words in order; each word keeps its index (for the next word's start)
  let index = 0;
  const shown = caption.lines
    .map((line, lineIndex) => {
      const count = line.split(" ").length;
      const lineWords = caption.words.slice(index, index + count).map((w, k) => ({ w, i: index + k }));
      index += count;
      return { lineIndex, words: lineWords.filter(({ w }) => w.startFrame >= skipBefore) };
    })
    .filter((l) => l.words.length > 0);
  const lines = shown.map((l) => l.words);
  lineIndexes.current = shown.map((l) => l.lineIndex);
  const enter = pop(frame, Math.max(caption.startFrame, words[0]!.startFrame - 2), 320, 18);
  // smaller only for one word too wide for a line at the normal size (captions.json fontSizePx)
  const fontSize = caption.fontSizePx ?? CAPTION_STYLE.fontSizePx;
  return (
    <div
      style={{
        position: "absolute",
        left: LAYOUT.captionCenterX - LAYOUT.captionWidth / 2,
        width: LAYOUT.captionWidth,
        bottom: LAYOUT.height - LAYOUT.captionBottom,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        transform: `translateY(${(1 - Math.min(enter, 1)) * 24}px) scale(${0.86 + 0.14 * enter})`,
        transformOrigin: "50% 100%",
        opacity: Math.min(1, enter * 1.6),
      }}
    >
      {lines.map((line, li) => (
        <div key={li} ref={(el) => void (lineRefs.current[li] = el)} style={{ display: "flex", justifyContent: "center", gap: CAPTION_STYLE.wordGap, whiteSpace: "nowrap" }}>
          {line.map(({ w, i }) => {
            // the pill stays at least 6 frames on a short word, but ends when the next word's pill starts (one pill at a
            // time); the two pieces of a word broken across lines share their timing and light up together
            const next = caption.words[i + 1];
            const pillEnd = Math.min(Math.max(w.endFrame, w.startFrame + 6), next && next.startFrame > w.startFrame ? next.startFrame - 1 : Infinity);
            const active = frame >= w.startFrame - 1 && frame < pillEnd;
            const spoken = frame >= w.startFrame - 1;
            const hit = pop(frame, w.startFrame - 1, 400, 20);
            return (
              <span
                key={`${w.startFrame}-${w.text}`}
                style={{
                  display: "inline-block",
                  fontFamily: FONT,
                  fontWeight: CAPTION_STYLE.fontWeight,
                  fontSize,
                  lineHeight: CAPTION_STYLE.lineHeight,
                  letterSpacing: "-0.01em",
                  padding: `0 ${CAPTION_STYLE.wordPaddingX}px`,
                  borderRadius: 18,
                  color: active ? "#1A1005" : w.key ? "#FFC24A" : C.text,
                  background: active ? "linear-gradient(180deg, #FFD27A, #F5A524)" : "transparent",
                  boxShadow: active ? "0 0 30px rgba(245,165,36,0.65), 0 8px 18px rgba(0,0,0,0.6)" : "none",
                  opacity: spoken ? 1 : 0.55,
                  transform: active ? `scale(${(1 + 0.1 * Math.min(hit, 1.2)).toFixed(3)}) rotate(-2deg)` : undefined,
                  textShadow: active ? "none" : "0 3px 0 rgba(0,0,0,0.85), 0 0 14px rgba(0,0,0,0.9)",
                }}
              >
                {w.text}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

/** Soft dark band behind the caption area so captions read over any picture. */
export const CaptionScrim: React.FC = () => (
  <div
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      top: LAYOUT.captionBottom - 300,
      height: 420,
      background: "linear-gradient(180deg, rgba(5,3,2,0) 0%, rgba(5,3,2,0.55) 40%, rgba(5,3,2,0.55) 70%, rgba(5,3,2,0) 100%)",
    }}
  />
);
