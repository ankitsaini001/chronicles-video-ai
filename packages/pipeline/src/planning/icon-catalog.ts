/**
 * Local icon catalog: which icon the renderer draws for an object, chosen from the object's label
 * by a fixed keyword table (first match wins; "bulb" when nothing matches).
 *
 * It lives in planning (not video) so the planner prompt and the Remotion icon component share
 * one list. The SVG artwork stays in packages/video/src/primitives/Icon.tsx.
 */

export const ICON_NAMES = [
  "sun", "raindrop", "droplets", "cloud", "waves", "snowflake", "glass", "mountain", "layers",
  "thermometer", "flame", "wind", "leaf", "globe", "bulb", "check", "cross", "clock", "coin",
  "bank", "chart", "book", "flag", "star", "question", "people", "gear", "dot",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** Ordered keyword table: the first match wins. Keep keywords lowercase. */
export const ICON_KEYWORDS: readonly (readonly [IconName, readonly string[]])[] = [
  ["glass", ["glass", "drink", "cup", "गिलास"]],
  ["sun", ["sun", "sunlight", "solar", "सूर्य", "धूप"]],
  ["snowflake", ["snow", "ice", "frozen", "glacier", "बर्फ"]],
  ["cloud", ["cloud", "vapour", "vapor", "steam", "condens", "बादल", "भाप"]],
  ["droplets", ["droplet", "particle"]],
  ["raindrop", ["raindrop", "drop", "rain", "hail", "water", "precipitation", "बारिश", "पानी"]],
  ["waves", ["ocean", "sea", "lake", "river", "wave", "flow", "collection", "समुद्र", "नदी"]],
  ["layers", ["ground", "soil", "layer", "earth", "मिट्टी"]],
  ["mountain", ["mountain", "hill"]],
  ["thermometer", ["temperature", "cold", "colder", "cool", "warm", "hot"]],
  ["flame", ["heat", "fire", "burn", "energy"]],
  ["wind", ["wind", "air"]],
  ["leaf", ["leaf", "plant", "tree", "green"]],
  ["globe", ["world", "planet", "global", "country"]],
  ["bank", ["bank", "deposit", "account", "fd"]],
  ["coin", ["money", "rupee", "₹", "price", "cost", "interest", "saving", "पैसा"]],
  ["chart", ["growth", "share", "percent", "data", "rate"]],
  ["clock", ["time", "year", "day", "hour", "minute", "history"]],
  ["book", ["learn", "study", "book", "lesson", "fact"]],
  ["people", ["people", "person", "population", "user", "you"]],
  ["bulb", ["idea", "remember", "key", "tip", "insight"]],
  ["question", ["why", "what", "how", "where", "?"]],
  ["flag", ["start", "goal", "finish", "milestone"]],
];

export const DEFAULT_ICON: IconName = "bulb";

/** Pick an icon for a label from the keyword table, or `fallback` when nothing matches. */
export function iconForLabel(label: string): IconName;
export function iconForLabel(label: string, fallback: IconName | null): IconName | null;
export function iconForLabel(label: string, fallback: IconName | null = DEFAULT_ICON): IconName | null {
  const text = label.toLowerCase();
  for (const [name, words] of ICON_KEYWORDS) {
    if (words.some((word) => text.includes(word))) return name;
  }
  return fallback;
}

export function isIconName(value: unknown): value is IconName {
  return typeof value === "string" && (ICON_NAMES as readonly string[]).includes(value);
}

/**
 * The icon to draw for an object: its explicit `icon` (P2b plans) when set, otherwise the keyword
 * fallback from its label (older plans, e.g. the plans approved before the `icon` field existed).
 */
export function iconFor(object: { icon?: IconName | null | undefined; label: string }): IconName;
export function iconFor(object: { icon?: IconName | null | undefined; label: string }, fallback: IconName | null): IconName | null;
export function iconFor(object: { icon?: IconName | null | undefined; label: string }, fallback: IconName | null = DEFAULT_ICON): IconName | null {
  return object.icon ?? iconForLabel(object.label, fallback);
}

/**
 * true when a label looks like a list of icon search words rather than on-screen text, e.g.
 * "sun heat solar", "why question rain", "water vapour vapour": three or more lowercase words with
 * no punctuation, where several are icon keywords or a word repeats. Used for a review warning only.
 */
export function looksLikeKeywordList(label: string): boolean {
  const words = label.trim().split(/\s+/);
  if (words.length < 2) return false;
  const lower = words.map((w) => w.toLowerCase());
  if (new Set(lower).size < lower.length) return true;
  if (words.length < 3) return false;
  if (/[^\p{L}\p{N}\s]/u.test(label)) return false; // "97% ocean", "Earth's ..." read as real text
  if (words.some((w) => /^\p{Lu}/u.test(w))) return false; // Title Case reads as a heading
  const keywordHits = lower.filter((w) =>
    ICON_KEYWORDS.some(([name, keys]) => name === w || keys.some((k) => k.length > 2 && (w === k || (w.startsWith(k) && k.length >= 5)))),
  ).length;
  return keywordHits >= 2;
}
