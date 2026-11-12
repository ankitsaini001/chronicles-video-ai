import {
  CaptionTrackSchema,
  TimelineSchema,
  VIDEO_FORMAT,
  type Caption,
  type CaptionTrack,
  type Plan,
  type Scene,
  type SceneAlignment,
  type Timeline,
  type TimelineEvent,
  type TimelineObject,
  type TimelineScene,
  type TimingSource,
} from "../contracts";
import { CAPTION_STYLE, MOTION } from "../theme";
import { localeFor, timeSceneBlocks, type TimedToken } from "./alignment";
import { breakLines, groupPhrases, type CaptionLayout, type CaptionWord } from "./captions";
import { AlignmentMappingError, CompileInputError, DurationOutOfRangeError } from "./errors";
import {
  endFrameOf,
  MAX_SCENE_HOLD_MS,
  MAX_TAKEAWAY_HOLD_MS,
  MAX_TOTAL_FRAMES,
  MIN_TOTAL_FRAMES,
  placeScenes,
  sceneFrames,
  startFrameOf,
} from "./frames";
import { tokenize } from "./text";
import { WIDTH_METHOD } from "./text-width";

/**
 * Timeline + caption compiler (PIPELINE_DESIGN.md §3, §6, §7). Pure and deterministic:
 * the same plan + alignments + options always give byte-identical timeline.json/captions.json.
 * No clock, no randomness, no I/O, no AI.
 */

export interface HoldOptions {
  /** Trailing hold after each scene's audio, 0-500 ms. */
  sceneHoldMs: number;
  /** Trailing hold after the final takeaway, 0-1500 ms (500 ms + up to 1 s extra). */
  takeawayHoldMs: number;
}

export const DEFAULT_HOLDS: HoldOptions = { sceneHoldMs: 400, takeawayHoldMs: 1200 };

export const DEFAULT_CAPTION_LAYOUT: CaptionLayout = {
  fontSizePx: CAPTION_STYLE.fontSizePx,
  maxLineWidthPx: CAPTION_STYLE.maxLineWidthPx,
};

/** Actions that bring an object on screen. Other actions (highlight, pulse, ...) act on a visible object. */
export const ENTRANCE_ACTIONS = new Set(["appear", "grow", "count-up", "rise", "fall", "flow", "gather", "point-to", "advance"]);
/** Kinds that form the base of a scene and are visible from its first frame unless an event brings them in. */
export const BASE_KINDS = new Set(["diagram", "column"]);
/** Captions stay up this long after their last word (unless the next caption starts sooner). */
const CAPTION_LINGER_FRAMES = 12;

export interface CompileInput {
  plan: Plan;
  planHash: string;
  /** One alignment per scene, keyed by scene ID. */
  alignments: Readonly<Record<string, SceneAlignment>>;
  holds?: HoldOptions;
  captionLayout?: CaptionLayout;
}

export interface CompileResult {
  timeline: Timeline;
  captions: CaptionTrack;
}

export function compileTimeline(input: CompileInput): CompileResult {
  const { plan, planHash } = input;
  const holds = input.holds ?? DEFAULT_HOLDS;
  const layout = input.captionLayout ?? DEFAULT_CAPTION_LAYOUT;
  const fps = VIDEO_FORMAT.fps;
  checkHolds(holds);

  const alignments = plan.scenes.map((scene) => {
    const alignment = input.alignments[scene.id];
    if (!alignment) throw new CompileInputError(`scene "${scene.id}" has no alignment; run speech for it first`);
    return alignment;
  });
  const timingSource = singleTimingSource(alignments.map((a) => a.source));

  const lastIndex = plan.scenes.length - 1;
  const holdFor = (index: number) => (index === lastIndex ? holds.takeawayHoldMs : holds.sceneHoldMs);
  const durations = alignments.map((a, i) => sceneFrames(a.audioDurationSeconds, holdFor(i), fps));
  const { starts, totalFrames } = placeScenes(durations);
  if (totalFrames < MIN_TOTAL_FRAMES || totalFrames > MAX_TOTAL_FRAMES) {
    throw new DurationOutOfRangeError(totalFrames, MIN_TOTAL_FRAMES, MAX_TOTAL_FRAMES, fps);
  }

  const scenes: TimelineScene[] = [];
  const captions: Caption[] = [];
  plan.scenes.forEach((scene, index) => {
    const alignment = alignments[index]!;
    const startFrame = starts[index]!;
    const durationFrames = durations[index]!;
    const blocks = timeSceneBlocks(scene, alignment, plan.language);

    const events = resolveEvents(scene, blocks, startFrame, durationFrames, plan.language);
    const speechFrames = Math.min(durationFrames, endFrameOf(alignment.audioDurationSeconds, fps));
    scenes.push({
      sceneId: scene.id,
      type: scene.type,
      startFrame,
      durationFrames,
      audioDurationSeconds: alignment.audioDurationSeconds,
      holdMs: holdFor(index),
      audioKey: alignment.audio ? `audio/${scene.id}.mp3` : null,
      objects: scheduleObjects(scene, events, startFrame, speechFrames),
      events,
    });

    const words: CaptionWord[] = blocks.flatMap((block) => block.displayTokens.map(toCaptionWord));
    captions.push(...sceneCaptions(scene.id, words, startFrame, durationFrames, layout));
  });

  const timeline = TimelineSchema.parse({
    schemaVersion: 1,
    ...VIDEO_FORMAT,
    totalFrames,
    language: plan.language,
    planHash,
    timingSource,
    scenes,
  });
  const track = CaptionTrackSchema.parse({
    schemaVersion: 1,
    timingSource,
    language: plan.language,
    widthMethod: WIDTH_METHOD,
    fontSizePx: layout.fontSizePx,
    maxLineWidthPx: layout.maxLineWidthPx,
    captions,
  });
  return { timeline, captions: track };
}

function checkHolds(holds: HoldOptions): void {
  const bad = (value: number, max: number) => !Number.isInteger(value) || value < 0 || value > max;
  if (bad(holds.sceneHoldMs, MAX_SCENE_HOLD_MS)) {
    throw new CompileInputError(`scene hold ${holds.sceneHoldMs} ms is outside 0-${MAX_SCENE_HOLD_MS} ms`);
  }
  if (bad(holds.takeawayHoldMs, MAX_TAKEAWAY_HOLD_MS)) {
    throw new CompileInputError(`takeaway hold ${holds.takeawayHoldMs} ms is outside 0-${MAX_TAKEAWAY_HOLD_MS} ms`);
  }
}

function singleTimingSource(sources: TimingSource[]): TimingSource {
  const unique = [...new Set(sources)];
  if (unique.length !== 1) {
    throw new CompileInputError(`scenes mix timing sources (${unique.join(", ")}); a video uses one source only`);
  }
  return unique[0]!;
}

function toCaptionWord(token: TimedToken): CaptionWord {
  return { text: token.text, startSec: token.startSec, endSec: token.endSec };
}

// ---------- events ----------

/** Find the anchor phrase in the block's approved text tokens and return its time span. */
export function anchorSpan(sceneId: string, tokens: readonly TimedToken[], phrase: string, locale: string): { startSec: number; endSec: number } {
  const needle = tokenize(phrase, locale).flatMap((t) => t.atoms);
  if (needle.length === 0) {
    throw new AlignmentMappingError(sceneId, `anchor phrase "${phrase}" has no spoken words (punctuation only)`);
  }
  const atoms: { atom: string; token: number }[] = [];
  tokens.forEach((token, index) => token.atoms.forEach((atom) => atoms.push({ atom, token: index })));

  const matches: number[] = [];
  for (let i = 0; i + needle.length <= atoms.length; i++) {
    if (needle.every((atom, k) => atoms[i + k]!.atom === atom)) matches.push(i);
  }
  if (matches.length !== 1) {
    throw new AlignmentMappingError(
      sceneId,
      `anchor phrase "${phrase}" was found ${matches.length} times in the spoken words; it must match exactly once`,
    );
  }
  const first = tokens[atoms[matches[0]!]!.token]!;
  const last = tokens[atoms[matches[0]! + needle.length - 1]!.token]!;
  return { startSec: first.startSec, endSec: last.endSec };
}

function resolveEvents(
  scene: Scene,
  blocks: ReturnType<typeof timeSceneBlocks>,
  sceneStart: number,
  durationFrames: number,
  language: Plan["language"],
): TimelineEvent[] {
  const locale = localeFor(language);
  const events = scene.events.map((event): TimelineEvent => {
    const block = blocks.find((b) => b.narrationId === event.anchor.narrationId);
    if (!block) throw new CompileInputError(`event "${event.id}" refers to unknown narration block "${event.anchor.narrationId}"`);
    const span = anchorSpan(scene.id, block.textTokens, event.anchor.phrase, locale);
    const startFrame = sceneStart + startFrameOf(span.startSec);
    const endFrame = sceneStart + endFrameOf(span.endSec);
    if (endFrame <= startFrame) {
      throw new AlignmentMappingError(scene.id, `event "${event.id}" has an empty interval (frames ${startFrame}-${endFrame})`);
    }
    if (endFrame > sceneStart + durationFrames) {
      throw new CompileInputError(`event "${event.id}" ends at frame ${endFrame}, after its scene ends (${sceneStart + durationFrames})`);
    }
    return {
      id: event.id,
      action: event.action,
      target: event.target,
      narrationId: event.anchor.narrationId,
      phrase: event.anchor.phrase,
      startFrame,
      endFrame,
    };
  });
  // Stable order: by start frame, then plan order.
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.startFrame - b.event.startFrame || a.index - b.index)
    .map(({ event }) => event);
}

// ---------- object reveal schedule ----------

/**
 * When each object appears:
 * - an object whose first event is an entrance action (appear, grow, rise, ...) appears at that event;
 * - base kinds (diagram, column) appear at the scene start;
 * - every other object appears in plan order, spread evenly across the narration, never before the
 *   object listed before it and always a little before its first event (so a highlight has something to highlight).
 */
export function scheduleObjects(scene: Scene, events: readonly TimelineEvent[], sceneStart: number, speechFrames: number): TimelineObject[] {
  const firstEvent = (id: string) => events.find((e) => e.target === id);
  const unscheduled = scene.objects.filter((o) => {
    const first = firstEvent(o.id);
    return !(first && ENTRANCE_ACTIONS.has(first.action)) && !BASE_KINDS.has(o.kind);
  });
  const slotSpan = Math.floor(speechFrames * 0.75);

  let previousReveal = sceneStart;
  return scene.objects.map((object) => {
    const first = firstEvent(object.id);
    let revealFrame: number;
    if (first && ENTRANCE_ACTIONS.has(first.action)) {
      revealFrame = first.startFrame;
    } else if (BASE_KINDS.has(object.kind)) {
      revealFrame = sceneStart;
    } else {
      const slot = unscheduled.indexOf(object);
      revealFrame = sceneStart + Math.floor((slot * slotSpan) / Math.max(1, unscheduled.length));
      revealFrame = Math.max(revealFrame, previousReveal + MOTION.stagger);
      if (first) revealFrame = Math.min(revealFrame, first.startFrame - MOTION.reveal);
      revealFrame = Math.max(sceneStart, revealFrame);
    }
    previousReveal = revealFrame;
    return { id: object.id, kind: object.kind, label: object.label, icon: object.icon ?? null, value: object.value, revealFrame };
  });
}

// ---------- captions ----------

function sceneCaptions(sceneId: string, words: CaptionWord[], sceneStart: number, durationFrames: number, layout: CaptionLayout): Caption[] {
  const sceneEnd = sceneStart + durationFrames;
  const phrases = groupPhrases(words, layout);
  const starts = phrases.map((p) => sceneStart + startFrameOf(p[0]!.startSec));
  return phrases.map((phrase, index) => {
    const lines = breakLines(phrase.map((w) => w.text), layout);
    if (!lines) throw new Error(`internal: caption phrase does not fit in 2 lines in scene "${sceneId}"`);
    const naturalEnd = sceneStart + endFrameOf(phrase[phrase.length - 1]!.endSec) + CAPTION_LINGER_FRAMES;
    const nextStart = starts[index + 1] ?? sceneEnd;
    const startFrame = starts[index]!;
    const endFrame = Math.max(startFrame + 1, Math.min(naturalEnd, nextStart, sceneEnd));
    return {
      id: `${sceneId}-c${String(index + 1).padStart(2, "0")}`,
      sceneId,
      startFrame,
      endFrame,
      text: phrase.map((w) => w.text).join(" "),
      lines: lines.map((line) => line.join(" ")),
    };
  });
}
