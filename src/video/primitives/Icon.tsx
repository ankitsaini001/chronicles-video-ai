import type React from "react";
import { ICON_NAMES, iconFor, iconForLabel, type IconName } from "../../planning/icon-catalog";
import { COLORS } from "../theme";

/**
 * Small allow-listed local icon set (inline SVG, 100×100 view box, two accents only).
 * No icon is ever fetched or generated at render time.
 *
 * The icon is picked from an object's label with the fixed keyword table in
 * src/planning/icon-catalog.ts (shared with the planner prompt).
 */

const B = COLORS.accent;
const BS = COLORS.accentSoft;
const W = COLORS.warm;
const WS = COLORS.warmSoft;
const INK = COLORS.ink;

const ICONS = {
  sun: (
    <>
      <circle cx="50" cy="50" r="20" fill={W} />
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} x="47" y="8" width="6" height="16" rx="3" fill={W} transform={`rotate(${i * 45} 50 50)`} />
      ))}
    </>
  ),
  raindrop: <path d="M50 8 C50 8 22 44 22 62 a28 28 0 0 0 56 0 C78 44 50 8 50 8 Z" fill={B} />,
  droplets: (
    <>
      <path d="M32 18 C32 18 16 40 16 51 a16 16 0 0 0 32 0 C48 40 32 18 32 18 Z" fill={B} />
      <path d="M68 40 C68 40 54 58 54 67 a14 14 0 0 0 28 0 C82 58 68 40 68 40 Z" fill={B} opacity="0.7" />
    </>
  ),
  cloud: (
    <path
      d="M28 74 H72 A17 17 0 0 0 74 40 A23 23 0 0 0 31 33 A20 20 0 0 0 28 74 Z"
      fill={BS}
      stroke={B}
      strokeWidth="4"
      strokeLinejoin="round"
    />
  ),
  waves: (
    <>
      {[34, 54, 74].map((y, i) => (
        <path key={y} d={`M10 ${y} q10 -10 20 0 t20 0 t20 0 t20 0`} fill="none" stroke={B} strokeWidth="7" strokeLinecap="round" opacity={1 - i * 0.25} />
      ))}
    </>
  ),
  snowflake: (
    <g stroke={B} strokeWidth="6" strokeLinecap="round">
      {[0, 60, 120].map((r) => (
        <line key={r} x1="50" y1="14" x2="50" y2="86" transform={`rotate(${r} 50 50)`} />
      ))}
    </g>
  ),
  glass: (
    <>
      <path d="M26 16 h48 l-7 70 a6 6 0 0 1 -6 5 h-22 a6 6 0 0 1 -6 -5 Z" fill={COLORS.surface} stroke={INK} strokeWidth="4" strokeLinejoin="round" />
      <path d="M30 44 h40 l-4 40 a4 4 0 0 1 -4 3 h-24 a4 4 0 0 1 -4 -3 Z" fill={B} opacity="0.85" />
    </>
  ),
  mountain: (
    <>
      <path d="M6 84 L38 30 L56 58 L68 42 L94 84 Z" fill={BS} stroke={B} strokeWidth="4" strokeLinejoin="round" />
      <path d="M30 44 L38 30 L46 43 Z" fill={COLORS.surface} />
    </>
  ),
  layers: (
    <>
      <rect x="10" y="22" width="80" height="16" rx="5" fill={WS} stroke={W} strokeWidth="3" />
      <rect x="10" y="44" width="80" height="16" rx="5" fill={WS} stroke={W} strokeWidth="3" />
      <rect x="10" y="66" width="80" height="16" rx="5" fill={BS} stroke={B} strokeWidth="3" />
    </>
  ),
  thermometer: (
    <>
      <rect x="40" y="10" width="20" height="58" rx="10" fill={COLORS.surface} stroke={INK} strokeWidth="4" />
      <circle cx="50" cy="74" r="16" fill={W} />
      <rect x="46" y="34" width="8" height="36" rx="4" fill={W} />
    </>
  ),
  flame: <path d="M50 8 C58 30 78 40 74 66 a24 24 0 0 1 -48 0 C24 50 36 44 40 30 C46 42 52 40 50 8 Z" fill={W} />,
  wind: (
    <g fill="none" stroke={B} strokeWidth="7" strokeLinecap="round">
      <path d="M10 38 h52 a12 12 0 1 0 -12 -12" />
      <path d="M10 58 h66 a12 12 0 1 1 -12 12" />
    </g>
  ),
  leaf: (
    <>
      <path d="M18 82 C18 40 46 16 86 14 C84 56 60 82 18 82 Z" fill={BS} stroke={B} strokeWidth="4" />
      <path d="M18 82 L64 36" stroke={B} strokeWidth="4" />
    </>
  ),
  globe: (
    <g fill="none" stroke={B} strokeWidth="5">
      <circle cx="50" cy="50" r="36" fill={BS} />
      <ellipse cx="50" cy="50" rx="16" ry="36" />
      <line x1="14" y1="50" x2="86" y2="50" />
    </g>
  ),
  bulb: (
    <>
      <path d="M50 10 a28 28 0 0 0 -16 51 v9 h32 v-9 a28 28 0 0 0 -16 -51 Z" fill={WS} stroke={W} strokeWidth="4" />
      <rect x="36" y="74" width="28" height="8" rx="4" fill={INK} />
      <rect x="40" y="86" width="20" height="6" rx="3" fill={INK} />
    </>
  ),
  check: (
    <>
      <circle cx="50" cy="50" r="40" fill={B} />
      <path d="M30 52 L44 66 L72 36" fill="none" stroke={COLORS.surface} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  cross: (
    <>
      <circle cx="50" cy="50" r="40" fill={W} />
      <path d="M34 34 L66 66 M66 34 L34 66" stroke={COLORS.surface} strokeWidth="9" strokeLinecap="round" />
    </>
  ),
  clock: (
    <>
      <circle cx="50" cy="50" r="38" fill={COLORS.surface} stroke={INK} strokeWidth="5" />
      <path d="M50 26 V50 L66 60" fill="none" stroke={W} strokeWidth="6" strokeLinecap="round" />
    </>
  ),
  coin: (
    <>
      <circle cx="50" cy="50" r="38" fill={WS} stroke={W} strokeWidth="5" />
      <text x="50" y="64" textAnchor="middle" fontSize="40" fontWeight="700" fill={W} fontFamily="Inter">₹</text>
    </>
  ),
  bank: (
    <g fill={BS} stroke={B} strokeWidth="4" strokeLinejoin="round">
      <path d="M10 36 L50 12 L90 36 Z" />
      <rect x="18" y="40" width="10" height="34" />
      <rect x="45" y="40" width="10" height="34" />
      <rect x="72" y="40" width="10" height="34" />
      <rect x="10" y="78" width="80" height="10" />
    </g>
  ),
  chart: (
    <>
      <rect x="14" y="54" width="16" height="32" rx="3" fill={BS} />
      <rect x="42" y="34" width="16" height="52" rx="3" fill={B} />
      <rect x="70" y="16" width="16" height="70" rx="3" fill={W} />
    </>
  ),
  book: (
    <>
      <path d="M50 24 C40 16 22 16 10 20 V82 C22 78 40 78 50 86 C60 78 78 78 90 82 V20 C78 16 60 16 50 24 Z" fill={BS} stroke={B} strokeWidth="4" strokeLinejoin="round" />
      <line x1="50" y1="24" x2="50" y2="86" stroke={B} strokeWidth="4" />
    </>
  ),
  flag: (
    <>
      <rect x="20" y="10" width="6" height="82" rx="3" fill={INK} />
      <path d="M26 14 H80 L68 32 L80 50 H26 Z" fill={W} />
    </>
  ),
  star: <path d="M50 8 L61 38 L93 38 L67 57 L77 88 L50 69 L23 88 L33 57 L7 38 L39 38 Z" fill={W} />,
  question: (
    <>
      <circle cx="50" cy="50" r="40" fill={BS} />
      <text x="50" y="68" textAnchor="middle" fontSize="54" fontWeight="800" fill={B} fontFamily="Inter">?</text>
    </>
  ),
  people: (
    <g fill={B}>
      <circle cx="36" cy="32" r="13" />
      <circle cx="68" cy="36" r="11" opacity="0.7" />
      <path d="M12 84 a24 24 0 0 1 48 0 Z" />
      <path d="M52 84 a19 19 0 0 1 38 0 Z" opacity="0.7" />
    </g>
  ),
  gear: (
    <>
      <circle cx="50" cy="50" r="26" fill="none" stroke={INK} strokeWidth="12" strokeDasharray="12 8" />
      <circle cx="50" cy="50" r="12" fill={W} />
    </>
  ),
  dot: <circle cx="50" cy="50" r="30" fill={B} />,
} satisfies Record<IconName, React.ReactNode>;

export { ICON_NAMES, iconFor, iconForLabel, type IconName };

export const Icon: React.FC<{ name: IconName; size: number; style?: React.CSSProperties }> = ({ name, size, style }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block", overflow: "visible", ...style }}>
    {ICONS[name]}
  </svg>
);
