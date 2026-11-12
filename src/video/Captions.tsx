import type React from "react";
import { useLayoutEffect, useRef } from "react";
import { cancelRender, useCurrentFrame } from "remotion";
import type { CaptionTrack } from "../contracts";
import { ramp } from "./anim";
import { CANVAS, CAPTION_STYLE, CAPTION_ZONE, COLORS, FONT_FAMILY, RADIUS } from "./theme";

/**
 * Phrase captions (PIPELINE_DESIGN.md §7): high contrast, max two pre-broken lines, no word-by-word
 * effects. Lines come from the compiler; this component never re-wraps them. As a layout check it
 * measures each line in the browser and fails the render if a line is wider than the caption box,
 * so a wrong width estimate can never ship as clipped or overflowing text.
 */
export const Captions: React.FC<{ track: CaptionTrack }> = ({ track }) => {
  const frame = useCurrentFrame();
  const caption = track.captions.find((c) => frame >= c.startFrame && frame < c.endFrame);
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  // Captions are centred on the canvas and must stay clear of the right-hand Reels buttons.
  const maxBoxWidth = 2 * (CAPTION_ZONE.right - CANVAS.width / 2);
  const maxInner = maxBoxWidth - 2 * CAPTION_STYLE.paddingX;

  useLayoutEffect(() => {
    if (!caption) return;
    lineRefs.current.forEach((el, i) => {
      if (el && el.getBoundingClientRect().width > maxInner + 0.5) {
        cancelRender(
          new Error(
            `Caption "${caption.id}" line ${i + 1} ("${caption.lines[i]}") is ${Math.round(el.getBoundingClientRect().width)}px wide; ` +
              `the caption box fits ${maxInner}px. Lower CAPTION_STYLE.maxLineWidthPx or the font size.`,
          ),
        );
      }
    });
  }, [caption, maxInner]);

  if (!caption) return null;
  const appear = ramp(frame, caption.startFrame, 4);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        width: CANVAS.width,
        bottom: CANVAS.height - CAPTION_ZONE.bottom,
        display: "flex",
        justifyContent: "center",
        opacity: appear,
      }}
    >
      <div
        style={{
          background: COLORS.captionBackground,
          color: COLORS.captionText,
          borderRadius: RADIUS.m,
          padding: `${CAPTION_STYLE.paddingY}px ${CAPTION_STYLE.paddingX}px`,
          fontFamily: FONT_FAMILY,
          fontSize: CAPTION_STYLE.fontSizePx,
          fontWeight: CAPTION_STYLE.fontWeight,
          lineHeight: CAPTION_STYLE.lineHeight,
          textAlign: "center",
          maxWidth: maxBoxWidth,
          boxShadow: "0 10px 30px rgba(23,33,59,0.18)",
        }}
      >
        {caption.lines.map((line, i) => (
          <div key={i}>
            <span ref={(el) => void (lineRefs.current[i] = el)} style={{ whiteSpace: "nowrap", display: "inline-block" }}>
              {line}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
