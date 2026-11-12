import type { Language, Scene, SceneAlignment } from "../contracts";
import { localeFor, speechInputForScene } from "./alignment";
import { tokenize } from "./text";

/**
 * SYNTHETIC, SILENT timing fixture (PIPELINE_DESIGN.md §10 "clearly marked silent timing fixture").
 *
 * There is no audio in P1, so this invents deterministic per-character timings from a fixed
 * words-per-second rate, in exactly the shape ElevenLabs returns. It exists only to exercise the
 * compiler, captions and renderer. It is labelled `source: "synthetic-silent-fixture"`, stored as
 * alignment/<scene-id>.synthetic.json, and must never be reported as live output.
 *
 * Rules (all deterministic):
 * - every word lasts 1 / wordsPerSecond seconds, its characters spread evenly;
 * - a short pause follows commas/colons, a longer one follows sentence ends;
 * - whitespace characters take zero time;
 * - the "audio" lasts until the last character plus a short tail.
 */

export interface SyntheticTimingOptions {
  wordsPerSecond: number;
  leadInSeconds: number;
  clausePauseSeconds: number;
  sentencePauseSeconds: number;
  tailSeconds: number;
}

/** 2.8 words/s is about 168 words/min, a brisk but typical narration pace. */
export const DEFAULT_SYNTHETIC_TIMING: SyntheticTimingOptions = {
  wordsPerSecond: 2.8,
  leadInSeconds: 0.15,
  clausePauseSeconds: 0.15,
  sentencePauseSeconds: 0.3,
  tailSeconds: 0.25,
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function synthesizeSceneAlignment(
  scene: Scene,
  language: Language,
  options: SyntheticTimingOptions = DEFAULT_SYNTHETIC_TIMING,
): SceneAlignment {
  const { speechText, blocks } = speechInputForScene(scene);
  const tokens = tokenize(speechText, localeFor(language));
  const wordSeconds = 1 / options.wordsPerSecond;

  // Start/end per UTF-16 offset; whitespace stays at the current cursor time.
  const startAt = new Array<number>(speechText.length);
  const endAt = new Array<number>(speechText.length);
  let cursor = options.leadInSeconds;
  let offset = 0;
  for (const token of tokens) {
    for (; offset < token.start; offset++) {
      startAt[offset] = cursor;
      endAt[offset] = cursor;
    }
    const perChar = wordSeconds / (token.end - token.start);
    for (; offset < token.end; offset++) {
      startAt[offset] = cursor;
      cursor += perChar;
      endAt[offset] = cursor;
    }
    if (/[.?!।]["')]?$/u.test(token.text)) cursor += options.sentencePauseSeconds;
    else if (/[,;:—–]["')]?$/u.test(token.text)) cursor += options.clausePauseSeconds;
  }
  for (; offset < speechText.length; offset++) {
    startAt[offset] = cursor;
    endAt[offset] = cursor;
  }

  // One alignment entry per code point, as the provider does (a code point may be 2 UTF-16 units).
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let unit = 0;
  for (const ch of speechText) {
    characters.push(ch);
    starts.push(round3(startAt[unit]!));
    ends.push(round3(endAt[unit + ch.length - 1]!));
    unit += ch.length;
  }
  const lastEnd = ends[ends.length - 1] ?? 0;

  return {
    schemaVersion: 1,
    sceneId: scene.id,
    source: "synthetic-silent-fixture",
    speechText,
    blocks,
    audioDurationSeconds: round3(lastEnd + options.tailSeconds),
    audio: null,
    alignment: { characters, character_start_times_seconds: starts, character_end_times_seconds: ends },
    normalizedAlignment: null,
  };
}
