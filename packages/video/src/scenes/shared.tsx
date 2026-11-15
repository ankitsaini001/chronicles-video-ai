import type React from "react";
import type { CaptionTrackWord, TimelineObject, TimelineScene } from "@bytereel/pipeline/contracts";
import { heroForText, heroForWord, iconDuplicatesHero, normalizeHeroWord } from "@bytereel/pipeline/planning/hero-catalog";
import { ICON_KEYWORDS, iconFor, type IconName } from "@bytereel/pipeline/planning/icon-catalog";
import { cameraAt, CAM_HOME, withDrift, type CamMove, type CamState } from "../camera";
import { heroAt, type HeroCues } from "../heroes/HeroLayer";
import { LiveIcon } from "../icons/LiveIcon";
import { CAMERA } from "../layout";
import { pop, pulse, rise } from "../motion";
import { C, FONT } from "../theme";
import { Card, IconTile } from "../ui";

/**
 * What every scene layout gets, and the helpers they share (F22b, video style v4).
 * Frames are absolute (the same numbers as timeline.json and captions.json).
 */

export interface Ctx {
  frame: number;
  /** The video's language (for the few words a layout writes itself, e.g. "STEP 2 OF 4"). */
  language: "en" | "hi" | "hinglish";
  scene: TimelineScene;
  /** This scene's caption words, in order (from captions.json). */
  words: readonly CaptionTrackWord[];
  /** Hero cues for this scene (frames where each hero is named). */
  heroCues: HeroCues;
}

export interface Pattern {
  camera(ctx: Ctx): CamState;
  View: React.FC<{ ctx: Ctx; cam: CamState }>;
}

/** The top band (titles, the current-step card). */
export const TOP = 290;

export const ofKind = (ctx: Ctx, ...kinds: string[]) => ctx.scene.objects.filter((o) => kinds.includes(o.kind));
export const eventsOn = (ctx: Ctx, id: string) => ctx.scene.events.filter((e) => e.target === id);
export const sceneEnd = (ctx: Ctx) => ctx.scene.startFrame + ctx.scene.durationFrames;
export const lastWordEnd = (ctx: Ctx) => (ctx.words.length ? ctx.words[ctx.words.length - 1]!.endFrame : sceneEnd(ctx));
/** When an object is first talked about: its first event, else its reveal. */
export const firstCue = (ctx: Ctx, o: TimelineObject) => Math.min(o.revealFrame, ...eventsOn(ctx, o.id).map((e) => e.startFrame));

export interface Activation {
  id: string;
  frame: number;
}

/** The objects the scene talks about, in order: each becomes active at its first event (else its reveal). */
export function activations(ctx: Ctx, objects: readonly TimelineObject[]): Activation[] {
  return objects.map((o) => ({ id: o.id, frame: firstCue(ctx, o) })).sort((a, b) => a.frame - b.frame);
}

export function activeAt(list: readonly Activation[], frame: number): Activation | null {
  let current: Activation | null = null;
  for (const a of list) if (a.frame <= frame) current = a;
  return current;
}

/** 0..1: how "active" object `id` is right now (eases in when it becomes the active one). */
export function activeAmount(list: readonly Activation[], id: string, frame: number): number {
  const now = activeAt(list, frame);
  return now && now.id === id ? rise(frame, now.frame, 8) : 0;
}

/** Hero cues of a scene: spoken words that name a hero, and events on objects whose label names one. */
export function sceneHeroCues(scene: TimelineScene, words: readonly CaptionTrackWord[]): HeroCues {
  const cues = new Map<string, { frame: number; word: string }[]>();
  const add = (key: string, frame: number, word: string) => {
    const list = cues.get(key) ?? [];
    list.push({ frame, word });
    cues.set(key, list);
  };
  for (const w of words) {
    const hero = heroForWord(w.text);
    if (hero) add(hero, w.startFrame, w.text);
  }
  for (const e of scene.events) {
    const target = scene.objects.find((o) => o.id === e.target);
    const hero = target ? heroForText(target.label) : null;
    if (hero && target) add(hero, e.startFrame, target.label);
  }
  // the medallion acts on every event of the scene
  for (const step of scene.heroes) if (!step.hero) for (const e of scene.events) add(`icon:${step.icon}`, e.startFrame, e.phrase);
  for (const list of cues.values()) list.sort((a, b) => a.frame - b.frame);
  return cues;
}

/** Camera: a small punch-in each time a new hero arrives, then it settles; slow push-in and drift. */
export function heroCamera(ctx: Ctx, home: CamState = CAM_HOME): CamState {
  const moves: CamMove[] = [{ at: ctx.scene.startFrame - 14, dur: 1, ...home }];
  ctx.scene.heroes.slice(1).forEach((s) => {
    moves.push({ at: s.startFrame, dur: 8, z: CAMERA.punchZoom });
    moves.push({ at: s.startFrame + 10, dur: 26, z: 1.0 });
  });
  moves.push({ at: ctx.scene.startFrame, dur: ctx.scene.durationFrames, z: CAMERA.pushZoom });
  return withDrift(cameraAt(ctx.frame, moves, home), ctx.frame, CAMERA.drift);
}

/** The hero step on screen now (for hiding a small icon that would show the same object twice). */
export const currentHero = (ctx: Ctx) => heroAt(ctx.scene.heroes, ctx.frame).current;

/** The icon a plan object shows (explicit icon, else from its label). */
export const iconOf = (o: TimelineObject): IconName => iconFor({ icon: o.icon, label: o.label });

/** true when this object's small icon would repeat the big hero on screen right now. */
export function iconRepeatsHero(ctx: Ctx, o: TimelineObject): boolean {
  const step = currentHero(ctx);
  if (!step) return false;
  const icon = iconOf(o);
  return step.hero ? iconDuplicatesHero(icon, step.hero) : step.icon === icon;
}

const STEMS_SKIP = new Set("the a an of and or to in into is are was be by for from on at as that this it its our your you we with".split(" "));

/** Frames where the narration names an object (its label words or its icon's keywords) or an event targets it. */
export function objectCues(ctx: Ctx, o: TimelineObject): number[] {
  const keys = new Set(
    o.label
      .split(/\s+/)
      .map(normalizeHeroWord)
      .filter((w) => w.length >= 3 && !STEMS_SKIP.has(w))
      .map((w) => (w.length > 5 ? w.slice(0, 5) : w.replace(/s$/, ""))),
  );
  const icon = iconOf(o);
  for (const [name, list] of ICON_KEYWORDS) if (name === icon) for (const k of list) keys.add(normalizeHeroWord(k));
  const frames = ctx.words
    .filter((w) => {
      const n = normalizeHeroWord(w.text);
      if (n.length < 3 || STEMS_SKIP.has(n)) return false;
      return [...keys].some((k) => k.length >= 3 && (n.startsWith(k) || (k.startsWith(n) && n.length >= 4)));
    })
    .map((w) => w.startFrame);
  for (const e of eventsOn(ctx, o.id)) frames.push(e.startFrame);
  const from = o.revealFrame - 6;
  return [...new Set(frames)].filter((f) => f >= from).sort((a, b) => a - b);
}

/** The animated icon of a plan object. */
export const ObjectIcon: React.FC<{ ctx: Ctx; object: TimelineObject; size: number }> = ({ ctx, object, size }) => {
  const cues = objectCues(ctx, object);
  const rising = /vapou?r|steam|evapor|rise|rising/i.test(object.label);
  const cooling = ctx.words.some((w) => cues.includes(w.startFrame) && /^(cold|cool|colder|freez|frozen|ice)/i.test(normalizeHeroWord(w.text)));
  return <LiveIcon name={iconOf(object)} size={size} frame={ctx.frame} cues={cues} mode={{ rising, cooling }} />;
};

/**
 * Big label card for the thing being talked about: an icon tile and the label. The icon tile is
 * left out when it would show the same object as the hero (never the same object twice at once).
 */
export const BigCard: React.FC<{ ctx: Ctx; object: TimelineObject; at: number; size?: number; maxWidth?: number }> = ({ ctx, object, at, size = 64, maxWidth = 900 }) => {
  const t = pop(ctx.frame, at, 220, 15);
  const tile = Math.round(size * 1.7);
  const showIcon = !iconRepeatsHero(ctx, object);
  return (
    <Card
      t={t}
      active={0.6 + 0.4 * pulse(ctx.frame, at, 30)}
      from={-20}
      style={{ display: "inline-flex", alignItems: "center", gap: 26, padding: showIcon ? "16px 40px 16px 18px" : "22px 44px", maxWidth, boxSizing: "border-box" }}
    >
      {showIcon && (
        <IconTile size={tile} active={1}>
          <ObjectIcon ctx={ctx} object={object} size={tile * 0.72} />
        </IconTile>
      )}
      <span style={{ fontFamily: FONT, fontWeight: 800, fontSize: size, lineHeight: 1.08, color: C.text, letterSpacing: "-0.01em", textWrap: "balance" }}>{object.label}</span>
    </Card>
  );
};
