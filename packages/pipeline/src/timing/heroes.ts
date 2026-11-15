import type { HeroStep, SceneType } from "../contracts";
import { heroForIcon, heroForText, heroForWord, type HeroName } from "../planning/hero-catalog";
import { iconFor, type IconName } from "../planning/icon-catalog";

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
 *   cue within MIN_STRONG frames of the last change replaces that change instead of adding one.
 * - The first hero is shown from the scene's first frame (never an empty screen).
 * - Nothing named at all: the first object label that names a hero, else the scene's icon large in
 *   a glowing medallion (hero null, `icon` set).
 * - A takeaway keeps one hero (the end card orbits it).
 */

export const HERO_MIN_HOLD = 36;
export const HERO_MIN_STRONG = 20;
export const HERO_LOOKAHEAD = 45;

/** Object kinds whose events say "this thing is being talked about now". */
const CONTENT_KINDS = new Set(["node", "part", "diagram", "column", "point", "milestone", "step", "bar", "line-point", "pie-slice", "counter", "icon"]);
/** Kinds that best name the scene's subject, for the medallion icon. */
const SUBJECT_KINDS = ["icon", "diagram", "headline", "axis", "column", "node", "milestone", "step", "part", "bullet"];

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
  /** planner pick: holds for the whole block */
  pinned: boolean;
}

export function heroTrack(input: HeroTrackInput): HeroStep[] {
  const { sceneStart, blocks, objects } = input;
  const candidates: Candidate[] = [];
  blocks.forEach((block, i) => {
    const from = i === 0 ? sceneStart : block.startFrame;
    const to = blocks[i + 1]?.startFrame ?? Infinity;
    if (block.hero) {
      candidates.push({ frame: from, hero: block.hero, strong: true, pinned: true });
      return;
    }
    for (const event of input.events) {
      if (event.startFrame < from || event.startFrame >= to) continue;
      const target = objects.find((o) => o.id === event.target);
      if (!target || !CONTENT_KINDS.has(target.kind)) continue;
      const hero = heroForText(target.label) ?? heroForIcon(target.icon);
      if (hero) candidates.push({ frame: event.startFrame, hero, strong: true, pinned: false });
    }
    for (const word of block.words) {
      const hero = heroForWord(word.text);
      if (hero) candidates.push({ frame: word.frame, hero, strong: false, pinned: false });
    }
  });
  candidates.sort((a, b) => a.frame - b.frame || Number(b.pinned) - Number(a.pinned) || Number(b.strong) - Number(a.strong));

  type Step = { startFrame: number; hero: HeroName; source: "plan" | "keyword" };
  const steps: Step[] = [];
  let lastHit = -Infinity;
  for (const c of candidates) {
    const source = c.pinned ? "plan" : "keyword";
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

/** The icon that best stands for the scene (the medallion picture when no hero fits). */
export function sceneIcon(objects: HeroTrackInput["objects"]): IconName {
  for (const kind of SUBJECT_KINDS) {
    const object = objects.find((o) => o.kind === kind);
    if (object) return iconFor({ icon: object.icon ?? null, label: object.label });
  }
  const first = objects[0];
  return first ? iconFor({ icon: first.icon ?? null, label: first.label }) : "bulb";
}
