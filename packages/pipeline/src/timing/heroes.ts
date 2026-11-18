import type { HeroStep, SceneType } from "../contracts";
import { diagramSubject, heroDef, heroForIcon, heroForText, heroForWord, sceneIcon, type HeroName } from "../planning/hero-catalog";
import type { IconName } from "../planning/icon-catalog";

/**
 * Hero track (F22b, video style v4): which big object is on screen when, for one scene. Pure and
 * deterministic (no AI, no randomness), so it is computed once by the timeline compiler and stored
 * in timeline.json; the renderer only draws it.
 *
 * - A narration block with a planner-picked `hero` shows that hero for the whole block; a block whose
 *   hero is null (the planner said "none") shows the scene's icon medallion, with no keyword guess.
 * - A block without one uses the free keyword fallback inside its own time span: an event on a
 *   content object (its label, else its icon) is a STRONG cue; a spoken word that names a hero is
 *   a WEAK cue (generic words such as "time" or "monthly" are label-only and never cues, see the
 *   hero catalog). A hero stays at least MIN_HOLD frames before a weak cue may replace it, and
 *   MIN_HOLD_OTHER_GROUP frames (3 s) before a weak cue for a hero of another group (money ->
 *   places) may; a weak cue is skipped when a strong cue for another hero follows within LOOKAHEAD
 *   frames; a strong cue within MIN_STRONG frames of the last change replaces that change instead
 *   of adding one; and a weak cue never switches back to the hero shown just before within
 *   NO_RETURN frames (no flicker).
 * - A labeled diagram is about one thing: a block without a pick shows the diagram's own object (the
 *   hero its label or icon names), when there is one, instead of switching on keywords.
 * - The first hero is shown from the scene's first frame (never an empty screen). A spoken word does
 *   not open the scene when an object or a planner pick of another family follows within LOOKAHEAD
 *   frames (a cloud may still open before it turns into a rain cloud).
 * - Nothing named at all: the first object label that names a hero (generic label-only words don't
 *   count here), else the scene's icon large in a glowing medallion (hero null, `icon` set).
 * - A takeaway keeps one hero (the end card orbits it): its first planner pick, else the first hero.
 */

export const HERO_MIN_HOLD = 36;
export const HERO_MIN_STRONG = 20;
/** Longer than the sample's 45: an incidental word ("every month") no longer flashes a hero just before a planned one. */
export const HERO_LOOKAHEAD = 75;
export const HERO_NO_RETURN = 120;
/**
 * A spoken word switches to a hero of another group (nature, money, tech, science, places, generic)
 * only after the current hero has been on screen this long (3 s): an incidental word in a money
 * video no longer flashes a clock or a rocket. Planner picks and objects on screen are not held back.
 */
export const HERO_MIN_HOLD_OTHER_GROUP = 90;

const familyOf = (hero: HeroName | null) => (hero ? heroDef(hero).family : "icon");
const groupOf = (hero: HeroName | null) => (hero ? heroDef(hero).group : null);

/** Object kinds whose events say "this thing is being talked about now". */
const CONTENT_KINDS = new Set(["node", "part", "diagram", "column", "point", "milestone", "step", "bar", "line-point", "pie-slice", "counter", "icon"]);

export interface HeroTrackInput {
  sceneType: SceneType;
  sceneStart: number;
  blocks: { narrationId: string; hero?: HeroName | null | undefined; startFrame: number; words: { text: string; frame: number }[] }[];
  objects: { id: string; kind: string; label: string; icon?: IconName | null | undefined }[];
  events: { target: string; startFrame: number }[];
}

interface Candidate {
  frame: number;
  /** null: the planner's "none" (the icon medallion) */
  hero: HeroName | null;
  strong: boolean;
  /** holds for the whole block (a planner pick, or a labeled diagram's own object) */
  pinned: boolean;
  source: "plan" | "keyword";
}

export function heroTrack(input: HeroTrackInput): HeroStep[] {
  const { sceneStart, blocks, objects } = input;
  const candidates: Candidate[] = [];
  const subject = input.sceneType === "labeled-diagram" ? diagramSubject(objects) : null;
  blocks.forEach((block, i) => {
    const from = i === 0 ? sceneStart : block.startFrame;
    const to = blocks[i + 1]?.startFrame ?? Infinity;
    const picked = block.hero !== undefined; // a hero, or null for the planner's "none"
    if (picked || subject) {
      candidates.push({ frame: from, hero: picked ? block.hero! : subject!, strong: true, pinned: true, source: picked ? "plan" : "keyword" });
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

  type Step = { startFrame: number; hero: HeroName | null; source: "plan" | "keyword" };
  const steps: Step[] = [];
  let lastHit = -Infinity;
  for (const c of candidates) {
    const source = c.source;
    const last = steps[steps.length - 1];
    if (!last) {
      // the opening: a spoken word gives way to an object or a pick of another family that follows soon
      if (!c.strong && candidates.some((o) => o.strong && familyOf(o.hero) !== familyOf(c.hero) && o.frame > c.frame && o.frame <= c.frame + HERO_LOOKAHEAD)) continue;
      steps.push({ startFrame: sceneStart, hero: c.hero, source });
      lastHit = c.frame;
      continue;
    }
    if (c.hero === last.hero) {
      if (c.pinned) {
        lastHit = c.frame;
        // the planner picked the hero a word already showed: the step is the planner's (the takeaway keeps it)
        last.source = c.source;
      }
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
    const otherGroup = !!last.hero && groupOf(c.hero) !== groupOf(last.hero);
    if (otherGroup && c.frame - last.startFrame < HERO_MIN_HOLD_OTHER_GROUP) continue;
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
    if (input.sceneType === "takeaway") {
      const one = merged.find((s) => s.source === "plan") ?? merged[0]!;
      return [{ startFrame: sceneStart, hero: one.hero, icon, source: one.source }];
    }
    return merged.map((s) => ({ startFrame: s.startFrame, hero: s.hero, icon, source: s.source }));
  }
  for (const object of objects) {
    // nothing points at this object now, so a generic (label-only) word is not enough here
    const hero = heroForText(object.label, "spoken");
    if (hero) return [{ startFrame: sceneStart, hero, icon, source: "keyword" }];
  }
  return [{ startFrame: sceneStart, hero: null, icon, source: "icon" }];
}
