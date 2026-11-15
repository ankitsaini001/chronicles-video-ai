import type { HeroStep, SceneType } from "../contracts";
import { heroForIcon, heroForText, heroForWord, sceneIcon, type HeroName } from "../planning/hero-catalog";
import type { IconName } from "../planning/icon-catalog";

/**
 * Hero track (F22b, video style v4): which big object is on screen when, for one scene. Pure and
 * deterministic (no AI, no randomness), so it is computed once by the timeline compiler and stored
 * in timeline.json; the renderer only draws it.
 *
 * - A narration block with a planner-picked `hero` shows that hero for the whole block.
 * - A block without one uses the free keyword fallback inside its own time span: an event on a
 *   content object (its label, else its icon) is a STRONG cue; a spoken word that names a hero is
 *   a WEAK cue. A hero stays at least MIN_HOLD frames before a weak cue may replace it, a weak cue
 *   is skipped when a strong cue for another hero follows within LOOKAHEAD frames, and a strong
 *   cue within MIN_STRONG frames of the last change replaces that change instead of adding one, and
 *   a weak cue never switches back to the hero shown just before within NO_RETURN frames (no flicker).
 * - A labeled diagram is about one thing: a block without a pick shows the diagram's own object (the
 *   hero its label or icon names), when there is one, instead of switching on keywords.
 * - The first hero is shown from the scene's first frame (never an empty screen).
 * - Nothing named at all: the first object label that names a hero, else the scene's icon large in
 *   a glowing medallion (hero null, `icon` set).
 * - A takeaway keeps one hero (the end card orbits it).
 */

export const HERO_MIN_HOLD = 36;
export const HERO_MIN_STRONG = 20;
/** Longer than the sample's 45: an incidental word ("every month") no longer flashes a hero just before a planned one. */
export const HERO_LOOKAHEAD = 75;
export const HERO_NO_RETURN = 120;

/** Object kinds whose events say "this thing is being talked about now". */
const CONTENT_KINDS = new Set(["node", "part", "diagram", "column", "point", "milestone", "step", "bar", "line-point", "pie-slice", "counter", "icon"]);

export interface HeroTrackInput {
  sceneType: SceneType;
  sceneStart: number;
  blocks: { narrationId: string; hero?: HeroName | undefined; startFrame: number; words: { text: string; frame: number }[] }[];
  objects: { id: string; kind: string; label: string; icon?: IconName | null | undefined }[];
  events: { target: string; startFrame: number }[];
}

interface Candidate {
  frame: number;
  hero: HeroName;
  strong: boolean;
  /** holds for the whole block (a planner pick, or a labeled diagram's own object) */
  pinned: boolean;
  source: "plan" | "keyword";
}

export function heroTrack(input: HeroTrackInput): HeroStep[] {
  const { sceneStart, blocks, objects } = input;
  const candidates: Candidate[] = [];
  const diagram = input.sceneType === "labeled-diagram" ? objects.find((o) => o.kind === "diagram") : undefined;
  const subject = diagram ? (heroForText(diagram.label) ?? heroForIcon(diagram.icon)) : null;
  blocks.forEach((block, i) => {
    const from = i === 0 ? sceneStart : block.startFrame;
    const to = blocks[i + 1]?.startFrame ?? Infinity;
    if (block.hero || subject) {
      candidates.push({ frame: from, hero: block.hero ?? subject!, strong: true, pinned: true, source: block.hero ? "plan" : "keyword" });
      return;
    }
    for (const event of input.events) {
      if (event.startFrame < from || event.startFrame >= to) continue;
      const target = objects.find((o) => o.id === event.target);
      if (!target || !CONTENT_KINDS.has(target.kind)) continue;
      const hero = heroForText(target.label) ?? heroForIcon(target.icon);
      if (hero) candidates.push({ frame: event.startFrame, hero, strong: true, pinned: false, source: "keyword" });
    }
    for (const word of block.words) {
      const hero = heroForWord(word.text);
      if (hero) candidates.push({ frame: word.frame, hero, strong: false, pinned: false, source: "keyword" });
    }
  });
  candidates.sort((a, b) => a.frame - b.frame || Number(b.pinned) - Number(a.pinned) || Number(b.strong) - Number(a.strong));

  type Step = { startFrame: number; hero: HeroName; source: "plan" | "keyword" };
  const steps: Step[] = [];
  let lastHit = -Infinity;
  for (const c of candidates) {
    const source = c.source;
    const last = steps[steps.length - 1];
    if (!last) {
      steps.push({ startFrame: sceneStart, hero: c.hero, source });
      lastHit = c.frame;
      continue;
    }
    if (c.hero === last.hero) {
      if (c.pinned) lastHit = c.frame;
      continue;
    }
    if (c.pinned || c.strong) {
      if (c.frame - lastHit < HERO_MIN_STRONG && !(last.source === "plan" && !c.pinned)) {
        last.hero = c.hero;
        last.source = source;
      } else {
        steps.push({ startFrame: c.frame, hero: c.hero, source });
      }
      lastHit = c.frame;
      continue;
    }
    if (c.frame - lastHit < HERO_MIN_HOLD) continue;
    // no flicker: a spoken word never switches back to the hero shown just before, soon after it left
    const before = steps[steps.length - 2];
    if (before && before.hero === c.hero && c.frame - last.startFrame < HERO_NO_RETURN) continue;
    if (candidates.some((o) => o.strong && o.hero !== c.hero && o.frame > c.frame && o.frame <= c.frame + HERO_LOOKAHEAD)) continue;
    steps.push({ startFrame: c.frame, hero: c.hero, source });
    lastHit = c.frame;
  }

  // a replacement may leave two equal neighbours: merge them
  const merged = steps.filter((s, i) => i === 0 || s.hero !== steps[i - 1]!.hero);
  const icon = sceneIcon(objects);
  if (merged.length) {
    const kept = input.sceneType === "takeaway" ? merged.slice(0, 1) : merged;
    return kept.map((s) => ({ startFrame: s.startFrame, hero: s.hero, icon, source: s.source }));
  }
  for (const object of objects) {
    const hero = heroForText(object.label);
    if (hero) return [{ startFrame: sceneStart, hero, icon, source: "keyword" }];
  }
  return [{ startFrame: sceneStart, hero: null, icon, source: "icon" }];
}
