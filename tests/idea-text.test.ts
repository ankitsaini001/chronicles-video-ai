import { describe, expect, it } from "vitest";
import { CreateProjectBodySchema } from "@bytereel/db";
import { cleanIdeaText, IDEA_MAX_CHARS, ideaInputType, ideaProblem } from "@bytereel/db/idea-text";

// F12 review: the Idea screen and the server count the same characters (control characters out,
// NFC, trim), so Hindi nukta letters and pasted control characters can't make them disagree.

const NUKTA = "क़"; // क़ as one code point; NFC turns it into क + ़ (two)

describe("cleanIdeaText", () => {
  it("NFC: Devanagari nukta letters U+0958–U+095F become two characters each", () => {
    for (let c = 0x0958; c <= 0x095f; c++) expect(cleanIdeaText(String.fromCharCode(c))).toHaveLength(2);
    expect(cleanIdeaText(NUKTA)).toBe("क़");
  });

  it("NFC also composes (e + combining accent → é)", () => {
    expect(cleanIdeaText("café")).toBe("café");
  });

  it("removes control characters but keeps tab, line feed and carriage return", () => {
    expect(cleanIdeaText("How\u0000 UPI\u0007 works\u001b\u007f\u0085\tok\r\nnext")).toBe("How UPI works\tok\r\nnext");
  });

  it("trims after removing control characters", () => {
    expect(cleanIdeaText("\u0000  topic  \u0000")).toBe("topic");
  });
});

describe("limits and topic/notes on the cleaned text", () => {
  it("3,000 nukta letters look like 3,000 but count 6,000 → too long (the server agrees)", () => {
    const raw = NUKTA.repeat(3000);
    expect(raw.length).toBe(3000);
    const clean = cleanIdeaText(raw);
    expect(clean.length).toBe(6000);
    expect(ideaProblem(clean)).toBe("too_long");
    expect(CreateProjectBodySchema.safeParse({ inputType: ideaInputType(clean), text: raw, language: "hi", voiceGender: "female" }).success).toBe(false);
  });

  it("200 nukta letters are 400 characters → sent as notes, and the server accepts them", () => {
    const clean = cleanIdeaText(NUKTA.repeat(200));
    expect(ideaInputType(clean)).toBe("notes");
    expect(CreateProjectBodySchema.safeParse({ inputType: ideaInputType(clean), text: clean, language: "hi", voiceGender: "female" }).success).toBe(true);
  });

  it("empty, too short, fine, at the limit, over", () => {
    expect(ideaProblem(cleanIdeaText(" \u0000\n "))).toBe("empty");
    expect(ideaProblem("ab")).toBe("too_short");
    expect(ideaProblem("abc")).toBeNull();
    expect(ideaProblem("a".repeat(IDEA_MAX_CHARS))).toBeNull();
    expect(ideaProblem("a".repeat(IDEA_MAX_CHARS + 1))).toBe("too_long");
    expect(ideaInputType("a".repeat(300))).toBe("topic");
    expect(ideaInputType("a".repeat(301))).toBe("notes");
  });

  it("server: control characters are removed before the length check and never stored", () => {
    const r = CreateProjectBodySchema.safeParse({ inputType: "topic", text: "\u0000\u0001ab\u0002", language: "en", voiceGender: "female" });
    expect(r.success).toBe(false); // "ab" is 2 characters, below the minimum of 3
    const ok = CreateProjectBodySchema.safeParse({ inputType: "topic", text: "UPI\u0000 basics\u001b", language: "en", voiceGender: "female" });
    expect(ok.success && ok.data.text).toBe("UPI basics");
  });
});
