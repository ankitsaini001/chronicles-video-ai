import type React from "react";
import type { CaptionTrack } from "@bytereel/pipeline/contracts";
import { CAPTION_STYLE } from "@bytereel/pipeline/theme";
import { pop } from "./motion";
import { C, FONT, LAYOUT } from "./theme";

/**
 * Phrase captions (F22b, video style v4): the compiled phrases of captions.json (3-5 words, at most
 * 2 pre-broken lines), big and bold, with the word being spoken in an amber pill and key terms in
 * amber. Placed in the Reels safe zone: above the bottom band, left of the button column.
 * `skipBefore`: words before this frame are shown elsewhere (the hook's slam words), so a phrase
 * shows only its later words, and none at all when fewer than two are left.
 */
export const Captions: React.FC<{ track: CaptionTrack; frame: number; skipBefore?: number }> = ({ track, frame, skipBefore = 0 }) => {
  const caption = track.captions.find((c) => frame >= c.startFrame && frame < c.endFrame);
  if (!caption) return null;
  const words = caption.words.filter((w) => w.startFrame >= skipBefore);
  if (words.length === 0 || (words.length < 2 && words.length < caption.words.length)) return null;
  // the lines split the phrase's words in order
  let index = 0;
  const lines = caption.lines
    .map((line) => {
      const count = line.split(" ").length;
      const lineWords = caption.words.slice(index, index + count);
      index += count;
      return lineWords.filter((w) => w.startFrame >= skipBefore);
    })
    .filter((l) => l.length > 0);
  const enter = pop(frame, Math.max(caption.startFrame, words[0]!.startFrame - 2), 320, 18);
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
      {lines.map((line, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "center", gap: CAPTION_STYLE.wordGap, whiteSpace: "nowrap" }}>
          {line.map((w) => {
            const active = frame >= w.startFrame - 1 && frame < Math.max(w.endFrame, w.startFrame + 6);
            const spoken = frame >= w.startFrame - 1;
            const hit = pop(frame, w.startFrame - 1, 400, 20);
            return (
              <span
                key={`${w.startFrame}-${w.text}`}
                style={{
                  display: "inline-block",
                  fontFamily: FONT,
                  fontWeight: CAPTION_STYLE.fontWeight,
                  fontSize: CAPTION_STYLE.fontSizePx,
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
