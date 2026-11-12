import type { CharacterAlignment } from "../contracts";
import { mapTokensToSpeech, timeTokensFromAlignment, validateCharacterAlignment } from "./alignment";
import { AlignmentValidationError } from "./errors";
import { tokenize } from "./text";

/**
 * Provider alignment -> alignment over the exact speech text (PIPELINE_DESIGN.md §6 steps 2-4, 7).
 *
 * The provider returns an `alignment` for the text it was sent and, separately, a
 * `normalized_alignment` for the text it actually spoke (e.g. "97%" spoken as "ninety-seven percent").
 *
 * 1. Both arrays are validated (equal lengths, finite non-negative times, ordered starts, end >= start,
 *    within the decoded audio duration).
 * 2. If the original alignment spells the speech text exactly, it is used as is ("original").
 * 3. Otherwise the normalized alignment is mapped back onto the speech text word by word with
 *    many-to-many atom matching (numbers, %, ₹, acronyms, apostrophes). Each speech word takes the
 *    time span of the spoken words it maps to; its characters are spread evenly inside that span.
 *    This is a word-level mapping, never a guess across the scene ("normalized").
 * 4. Anything uncertain throws AlignmentValidationError / AlignmentMappingError (recoverable: fix the
 *    speech/display mapping or retry speech). Timings are never stretched to fit.
 */

export type AlignmentOrigin = "original" | "normalized";

export interface ResolvedAlignment {
  alignment: CharacterAlignment;
  mappedFrom: AlignmentOrigin;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

export function resolveProviderAlignment(input: {
  sceneId: string;
  speechText: string;
  original: CharacterAlignment | null;
  normalized: CharacterAlignment | null;
  audioDurationSeconds: number;
  locale: string;
}): ResolvedAlignment {
  const { sceneId, speechText, original, normalized, audioDurationSeconds, locale } = input;
  if (!original && !normalized) throw new AlignmentValidationError(sceneId, "the provider returned no alignment at all");
  if (original) validateCharacterAlignment(sceneId, original, audioDurationSeconds);
  if (normalized) validateCharacterAlignment(sceneId, normalized, audioDurationSeconds);

  if (original && original.characters.join("") === speechText) return { alignment: original, mappedFrom: "original" };
  if (!normalized) {
    throw new AlignmentValidationError(
      sceneId,
      "the provider's alignment does not spell the text that was sent, and no normalized alignment was returned to map it back. Retry speech.",
    );
  }

  const normalizedText = normalized.characters.join("");
  const spoken = timeTokensFromAlignment(normalizedText, normalized, locale);
  const mapped = mapTokensToSpeech(sceneId, "speech text", tokenize(speechText, locale), spoken);
  return { alignment: characterAlignmentFromTokens(speechText, mapped), mappedFrom: "normalized" };
}

/** One entry per code point of `text`; characters of a word share its span evenly, whitespace takes no time. */
function characterAlignmentFromTokens(text: string, tokens: readonly { start: number; end: number; startSec: number; endSec: number }[]): CharacterAlignment {
  const startAt = new Array<number>(text.length);
  const endAt = new Array<number>(text.length);
  let cursor = tokens[0]?.startSec ?? 0;
  let offset = 0;
  for (const token of tokens) {
    for (; offset < token.start; offset++) {
      startAt[offset] = cursor;
      endAt[offset] = cursor;
    }
    const length = token.end - token.start;
    const step = (token.endSec - token.startSec) / length;
    for (let k = 0; offset < token.end; offset++, k++) {
      startAt[offset] = token.startSec + step * k;
      endAt[offset] = token.startSec + step * (k + 1);
    }
    cursor = Math.max(cursor, token.endSec);
  }
  for (; offset < text.length; offset++) {
    startAt[offset] = cursor;
    endAt[offset] = cursor;
  }
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let unit = 0;
  for (const ch of text) {
    characters.push(ch);
    starts.push(round4(startAt[unit]!));
    ends.push(round4(endAt[unit + ch.length - 1]!));
    unit += ch.length;
  }
  // Rounding must never break ordering.
  for (let i = 1; i < starts.length; i++) {
    if (starts[i]! < starts[i - 1]!) starts[i] = starts[i - 1]!;
    if (ends[i]! < starts[i]!) ends[i] = starts[i]!;
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}
