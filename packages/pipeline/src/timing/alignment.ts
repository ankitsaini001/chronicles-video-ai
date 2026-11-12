import type { CharacterAlignment, Language, NarrationBlock, Scene, SceneAlignment } from "../contracts";
import { AlignmentMappingError, AlignmentValidationError } from "./errors";
import { tokenize, type Token } from "./text";

/**
 * Alignment -> timed words (PIPELINE_DESIGN.md §6 "Alignment algorithm").
 *
 * 1. speechInputForScene(): the exact speech text for a scene and each narration block's span in it.
 * 2. validateSceneAlignment(): equal array lengths, finite non-negative times, ordered starts,
 *    end >= start, bounded by the audio duration, characters equal to the speech text.
 * 3. timeSceneBlocks(): time every speech token from its characters, then map the approved text
 *    and the caption display text onto those tokens by their normalized atoms (many-to-many,
 *    e.g. "97%" <-> "ninety-seven percent"). Any mismatch throws AlignmentMappingError.
 */

/** Separator between narration blocks in one scene speech request. */
export const BLOCK_SEPARATOR = " ";

/** Speech end times may exceed the decoded audio duration by at most this much (encoder padding). */
export const AUDIO_BOUND_TOLERANCE_SECONDS = 0.05;

export interface SpeechInput {
  speechText: string;
  blocks: { narrationId: string; start: number; end: number }[];
}

export function speechFormOf(block: NarrationBlock): string {
  return block.speech ?? block.text;
}

export function displayFormOf(block: NarrationBlock): string {
  return block.display ?? block.text;
}

export function speechInputForScene(scene: Scene): SpeechInput {
  let speechText = "";
  const blocks: SpeechInput["blocks"] = [];
  scene.narration.forEach((block, index) => {
    if (index > 0) speechText += BLOCK_SEPARATOR;
    const start = speechText.length;
    speechText += speechFormOf(block);
    blocks.push({ narrationId: block.id, start, end: speechText.length });
  });
  return { speechText, blocks };
}

export function localeFor(language: Language): string {
  return language === "hi" ? "hi" : "en";
}

// ---------- validation ----------

export function validateCharacterAlignment(sceneId: string, alignment: CharacterAlignment, audioDurationSeconds: number): void {
  const fail = (message: string) => {
    throw new AlignmentValidationError(sceneId, message);
  };
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  if (characters.length === 0) fail("no characters");
  if (starts.length !== characters.length || ends.length !== characters.length) {
    fail(`array lengths differ (characters ${characters.length}, starts ${starts.length}, ends ${ends.length})`);
  }
  if (!Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0) fail(`audio duration ${audioDurationSeconds} is not positive`);
  const limit = audioDurationSeconds + AUDIO_BOUND_TOLERANCE_SECONDS;
  for (let i = 0; i < characters.length; i++) {
    const start = starts[i]!;
    const end = ends[i]!;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) {
      fail(`character ${i} (${JSON.stringify(characters[i])}) has a non-finite or negative time`);
    }
    if (end < start) fail(`character ${i} (${JSON.stringify(characters[i])}) ends (${end}) before it starts (${start})`);
    if (i > 0 && start < starts[i - 1]!) fail(`character ${i} starts at ${start}, before character ${i - 1} (${starts[i - 1]})`);
    if (end > limit) fail(`character ${i} ends at ${end} s, after the audio ends (${audioDurationSeconds} s)`);
  }
}

export function validateSceneAlignment(scene: Scene, alignment: SceneAlignment): void {
  if (alignment.sceneId !== scene.id) {
    throw new AlignmentValidationError(scene.id, `alignment belongs to scene "${alignment.sceneId}"`);
  }
  const expected = speechInputForScene(scene);
  if (alignment.speechText !== expected.speechText) {
    throw new AlignmentValidationError(
      scene.id,
      "speech text does not match the approved plan's narration (the plan changed after speech, or the alignment is for other text)",
    );
  }
  if (JSON.stringify(alignment.blocks) !== JSON.stringify(expected.blocks)) {
    throw new AlignmentValidationError(scene.id, "narration block spans do not match the plan's narration blocks");
  }
  validateCharacterAlignment(scene.id, alignment.alignment, alignment.audioDurationSeconds);
  const joined = alignment.alignment.characters.join("");
  if (joined !== alignment.speechText) {
    const at = firstDifference(joined, alignment.speechText);
    throw new AlignmentValidationError(
      scene.id,
      `alignment characters do not spell the speech text (first difference at offset ${at}: ` +
        `${JSON.stringify(joined.slice(at, at + 20))} vs ${JSON.stringify(alignment.speechText.slice(at, at + 20))})`,
    );
  }
}

function firstDifference(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ---------- timing ----------

export interface TimedToken extends Token {
  startSec: number;
  endSec: number;
  /** false for punctuation-only tokens, which borrow a neighbour's time. */
  spoken: boolean;
}

export interface TimedBlock {
  narrationId: string;
  /** Approved text tokens (used to resolve event anchors). */
  textTokens: TimedToken[];
  /** Caption display tokens (display form, else text). */
  displayTokens: TimedToken[];
}

const SPOKEN_CHAR = /[\p{L}\p{M}\p{N}]/u;

/** Times for each whitespace token of the speech text, from its spoken characters. */
export function timeSpeechTokens(alignment: SceneAlignment, locale: string): TimedToken[] {
  return timeTokensFromAlignment(alignment.speechText, alignment.alignment, locale);
}

/**
 * Time each whitespace token of `text` from a character alignment whose characters spell `text`
 * exactly (a provider "character" may span several UTF-16 code units).
 */
export function timeTokensFromAlignment(text: string, alignment: CharacterAlignment, locale: string): TimedToken[] {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  // UTF-16 offset -> alignment character index.
  const charAt: number[] = [];
  characters.forEach((ch, index) => {
    for (let k = 0; k < ch.length; k++) charAt.push(index);
  });

  return tokenize(text, locale).map((token) => {
    let startSec = Infinity;
    let endSec = -Infinity;
    let anySpoken = false;
    for (let offset = token.start; offset < token.end; offset++) {
      if (!SPOKEN_CHAR.test(text[offset]!)) continue;
      const index = charAt[offset]!;
      startSec = Math.min(startSec, starts[index]!);
      endSec = Math.max(endSec, ends[index]!);
      anySpoken = true;
    }
    if (!anySpoken) {
      const first = charAt[token.start]!;
      const last = charAt[token.end - 1]!;
      startSec = starts[first]!;
      endSec = ends[last]!;
    }
    return { ...token, startSec, endSec, spoken: token.atoms.length > 0 };
  });
}

/**
 * Map source tokens (approved or display text) onto timed speech tokens by comparing their atoms
 * in order. Both sides must normalize to the same atom sequence; each source token then spans the
 * speech tokens its atoms came from. Repeated words are handled because matching is positional.
 */
export function mapTokensToSpeech(sceneId: string, what: string, source: Token[], speech: TimedToken[]): TimedToken[] {
  const speechAtoms: { atom: string; token: number }[] = [];
  speech.forEach((token, index) => token.atoms.forEach((atom) => speechAtoms.push({ atom, token: index })));
  const sourceAtoms: { atom: string; token: number }[] = [];
  source.forEach((token, index) => token.atoms.forEach((atom) => sourceAtoms.push({ atom, token: index })));

  const limit = Math.max(sourceAtoms.length, speechAtoms.length);
  for (let i = 0; i < limit; i++) {
    const a = sourceAtoms[i];
    const b = speechAtoms[i];
    if (a?.atom !== b?.atom) {
      const sourceWord = a ? `"${source[a.token]!.text}"` : "(end of text)";
      const speechWord = b ? `"${speech[b.token]!.text}"` : "(end of speech)";
      throw new AlignmentMappingError(
        sceneId,
        `cannot map the ${what} onto the spoken words with certainty: ${sourceWord} does not match spoken ${speechWord} ` +
          `(word ${i + 1}). Add an explicit speech/display form to the narration block, or retry speech. ` +
          "Timings are never guessed.",
      );
    }
  }

  const ranges: { first: number; last: number }[] = source.map(() => ({ first: Infinity, last: -Infinity }));
  sourceAtoms.forEach((a, i) => {
    const speechToken = speechAtoms[i]!.token;
    const range = ranges[a.token]!;
    range.first = Math.min(range.first, speechToken);
    range.last = Math.max(range.last, speechToken);
  });

  const timed: TimedToken[] = source.map((token, index) => {
    const range = ranges[index]!;
    if (range.first === Infinity) return { ...token, startSec: NaN, endSec: NaN, spoken: false };
    return { ...token, startSec: speech[range.first]!.startSec, endSec: speech[range.last]!.endSec, spoken: true };
  });
  // Punctuation-only tokens (e.g. "—") borrow the end of the previous word, or the start of the next one.
  timed.forEach((token, index) => {
    if (token.spoken) return;
    const previous = timed.slice(0, index).reverse().find((t) => t.spoken);
    const next = timed.slice(index + 1).find((t) => t.spoken);
    const at = previous ? previous.endSec : next ? next.startSec : NaN;
    if (Number.isNaN(at)) throw new AlignmentMappingError(sceneId, `the ${what} has no spoken words`);
    token.startSec = at;
    token.endSec = at;
  });
  return timed;
}

export function timeSceneBlocks(scene: Scene, alignment: SceneAlignment, language: Language): TimedBlock[] {
  validateSceneAlignment(scene, alignment);
  const locale = localeFor(language);
  const speechTokens = timeSpeechTokens(alignment, locale);

  return scene.narration.map((block, index) => {
    const span = alignment.blocks[index]!;
    const blockSpeech = speechTokens.filter((t) => t.start >= span.start && t.end <= span.end);
    const textTokens = mapTokensToSpeech(scene.id, `approved text of "${block.id}"`, tokenize(block.text, locale), blockSpeech);
    const displayTokens = mapTokensToSpeech(scene.id, `caption text of "${block.id}"`, tokenize(displayFormOf(block), locale), blockSpeech);
    return { narrationId: block.id, textTokens, displayTokens };
  });
}
