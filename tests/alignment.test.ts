import { describe, expect, it } from "vitest";
import type { Language, Scene, SceneAlignment } from "../src/contracts";
import { SceneSchema } from "../src/contracts";
import {
  AlignmentMappingError,
  AlignmentValidationError,
  anchorSpan,
  atomsOf,
  localeFor,
  numberToWords,
  speechInputForScene,
  synthesizeSceneAlignment,
  timeSceneBlocks,
  tokenize,
  validateCharacterAlignment,
} from "../src/timing";

function scene(narration: { text: string; speech?: string; display?: string }[]): Scene {
  return SceneSchema.parse({
    id: "scene-test",
    type: "takeaway",
    narration: narration.map((n, i) => ({ id: `line-${i + 1}`, text: n.text, speech: n.speech ?? null, display: n.display ?? null })),
    objects: [{ id: "h", kind: "headline", label: "Test" }],
    events: [],
  });
}

function timed(s: Scene, language: Language = "en") {
  const alignment = synthesizeSceneAlignment(s, language);
  return { alignment, blocks: timeSceneBlocks(s, alignment, language) };
}

describe("text atoms", () => {
  it("normalizes numbers, %, ₹, acronyms and apostrophes", () => {
    expect(atomsOf("97%")).toEqual(["ninety", "seven", "percent"]);
    expect(atomsOf("ninety-seven")).toEqual(["ninety", "seven"]);
    expect(atomsOf("₹500")).toEqual(["five", "hundred", "rupees"]);
    expect(atomsOf("2.5")).toEqual(["two", "point", "five"]);
    expect(atomsOf("1,000")).toEqual(["one", "thousand"]);
    expect(atomsOf("DNA")).toEqual(["d", "n", "a"]);
    expect(atomsOf("Earth’s")).toEqual(atomsOf("Earth's"));
    expect(atomsOf("Earthʼs")).toEqual(["earths"]);
    expect(atomsOf("—")).toEqual([]);
    expect(numberToWords("1234567")).toEqual(["1234567"]); // too big for P1: must then match literally
  });

  it("keeps Devanagari words whole (matras and conjuncts stay inside the word)", () => {
    const tokens = tokenize("पृथ्वी का पानी, क्षेत्र और श्रम।", "hi");
    expect(tokens.map((t) => t.atoms)).toEqual([["पृथ्वी"], ["का"], ["पानी"], ["क्षेत्र"], ["और"], ["श्रम"]]);
  });
});

describe("alignment validation", () => {
  const ok = { characters: ["a", "b"], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] };
  it("accepts a well-formed alignment", () => {
    expect(() => validateCharacterAlignment("s", ok, 0.3)).not.toThrow();
  });
  it("rejects unequal lengths, unordered starts, end < start, non-finite and out-of-bounds times", () => {
    const bad = (patch: Partial<typeof ok>, duration = 0.3) => () => validateCharacterAlignment("s", { ...ok, ...patch }, duration);
    expect(bad({ character_end_times_seconds: [0.1] })).toThrow(/lengths differ/);
    expect(bad({ character_start_times_seconds: [0.1, 0.05], character_end_times_seconds: [0.1, 0.2] })).toThrow(/before character/);
    expect(bad({ character_end_times_seconds: [0.05, 0.2], character_start_times_seconds: [0.1, 0.1] })).toThrow(/ends .* before it starts/);
    expect(bad({ character_end_times_seconds: [0.1, Number.NaN] })).toThrow(/non-finite/);
    expect(bad({}, 0.1)).toThrow(/after the audio ends/);
  });
  it("rejects alignment characters that do not spell the speech text", () => {
    const s = scene([{ text: "Rain falls." }]);
    const alignment = synthesizeSceneAlignment(s, "en");
    const tampered: SceneAlignment = { ...alignment, alignment: { ...alignment.alignment, characters: alignment.alignment.characters.map((c) => (c === "R" ? "P" : c)) } };
    expect(() => timeSceneBlocks(s, tampered, "en")).toThrow(AlignmentValidationError);
  });
  it("rejects alignment for different narration", () => {
    const alignment = synthesizeSceneAlignment(scene([{ text: "Rain falls." }]), "en");
    expect(() => timeSceneBlocks(scene([{ text: "Snow falls." }]), alignment, "en")).toThrow(/does not match the approved plan/);
  });
});

describe("alignment -> word mapping", () => {
  it("joins narration blocks with one space and records their spans", () => {
    const input = speechInputForScene(scene([{ text: "One two." }, { text: "Three." }]));
    expect(input.speechText).toBe("One two. Three.");
    expect(input.blocks).toEqual([
      { narrationId: "line-1", start: 0, end: 8 },
      { narrationId: "line-2", start: 9, end: 15 },
    ]);
  });

  it("handles repeated words by position, and resolves a repeated phrase only when it is unique", () => {
    const s = scene([{ text: "The water heats the water, and the water rises again." }]);
    const { blocks } = timed(s);
    const tokens = blocks[0]!.textTokens;
    // Every token gets a strictly later time than the one before it, even the repeated "water".
    for (let i = 1; i < tokens.length; i++) expect(tokens[i]!.startSec).toBeGreaterThan(tokens[i - 1]!.startSec);
    const span = anchorSpan("s", tokens, "the water rises", "en");
    expect(span.startSec).toBe(tokens[6]!.startSec);
    expect(span.endSec).toBe(tokens[8]!.endSec);
    expect(() => anchorSpan("s", tokens, "the water", "en")).toThrow(/found 3 times/);
  });

  it("ignores punctuation, including punctuation-only tokens", () => {
    const s = scene([{ text: "Rain, snow — and hail!" }]);
    const { blocks } = timed(s);
    const dash = blocks[0]!.textTokens[2]!;
    expect(dash.text).toBe("—");
    expect(dash.spoken).toBe(false);
    expect(dash.startSec).toBe(blocks[0]!.textTokens[1]!.endSec); // borrows the previous word's end
    const span = anchorSpan("s", blocks[0]!.textTokens, "snow and hail", "en");
    expect(span.endSec).toBeGreaterThan(span.startSec);
    expect(() => anchorSpan("s", blocks[0]!.textTokens, "— !", "en")).toThrow(/punctuation only/);
  });

  it("maps text with Unicode apostrophes onto speech with ASCII ones", () => {
    const s = scene([{ text: "Earth’s water isn’t new.", speech: "Earth's water isn't new." }]);
    const { blocks } = timed(s);
    expect(blocks[0]!.textTokens.map((t) => t.spoken)).toEqual([true, true, true, true]);
  });

  it("maps display '97%' and speech 'ninety-seven percent' many-to-many", () => {
    const s = scene([{ text: "About 97 percent is salty.", speech: "About ninety-seven percent is salty.", display: "About 97% is salty." }]);
    const { blocks } = timed(s);
    const display = blocks[0]!.displayTokens;
    expect(display.map((t) => t.text)).toEqual(["About", "97%", "is", "salty."]);
    const speechWords = blocks[0]!.textTokens;
    // "97%" spans from the start of "ninety-seven" to the end of "percent".
    expect(display[1]!.startSec).toBe(speechWords[1]!.startSec);
    expect(display[1]!.endSec).toBe(speechWords[2]!.endSec);
  });

  it("fails clearly instead of guessing when text and speech disagree", () => {
    const s = scene([{ text: "About 97 percent is salty.", speech: "About ninety percent is salty." }]);
    expect(() => timed(s)).toThrow(AlignmentMappingError);
    expect(() => timed(s)).toThrow(/"97" does not match spoken "percent".*never guessed/);
  });

  it("maps Devanagari words with conjuncts and matras", () => {
    const s = scene([{ text: "पृथ्वी का 97 प्रतिशत पानी खारा है।" }]);
    const { blocks } = timed(s, "hi");
    const tokens = blocks[0]!.textTokens;
    expect(tokens.map((t) => t.text)).toEqual(["पृथ्वी", "का", "97", "प्रतिशत", "पानी", "खारा", "है।"]);
    const span = anchorSpan("s", tokens, "पानी खारा", localeFor("hi"));
    expect(span.startSec).toBe(tokens[4]!.startSec);
    expect(span.endSec).toBe(tokens[5]!.endSec);
  });

  it("refuses Hinglish Roman captions against Devanagari speech without an explicit mapping (P2/P3 work)", () => {
    const s = scene([{ text: "Paani garam hota hai.", speech: "पानी गरम होता है।" }]);
    expect(() => timed(s, "hinglish")).toThrow(AlignmentMappingError);
  });
});
