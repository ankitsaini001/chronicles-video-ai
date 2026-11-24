import { z } from "zod";
import type { Language } from "../contracts";
import { CAPTION_OUTPUT_LIMITS } from "./prompts";

/**
 * The model's caption answer (H1, F29): the structured-output schema we send, and the strict check of
 * what comes back. The model is never trusted: the caption is cleaned (control and invisible
 * characters removed, NFC, at most one blank line in a row, trimmed), then it must be 1–2,000
 * characters, without hashtags of its own, in the project's script; 3–5 hashtags, each "#" + 1–100
 * letters, digits or underscores (duplicates dropped). Problems go to ONE repair attempt.
 */

export interface PostCaptionSuggestion {
  caption: string;
  hashtags: string[];
}

/** JSON Schema for Gemini's structured output (only widely supported keywords, as brainstorm/output.ts). */
export function postCaptionOutputJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      suitable: { type: "boolean", description: "false only when the script is not suitable for a general audience of students" },
      caption: { type: "string", description: `The Instagram caption without hashtags, at most ${CAPTION_OUTPUT_LIMITS.captionAim} characters.` },
      hashtags: {
        type: "array",
        description: `${CAPTION_OUTPUT_LIMITS.hashtagsMin} to ${CAPTION_OUTPUT_LIMITS.hashtagsMax} hashtags, each starting with #.`,
        items: { type: "string" },
      },
    },
    required: ["suitable", "caption", "hashtags"],
    propertyOrdering: ["suitable", "caption", "hashtags"],
  };
}

/** Counts Unicode code points (what Instagram counts), like postCaptionLength in packages/db. */
function length(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Caption text from the model: paragraphs kept, everything else tidied. */
export function cleanSuggestedCaption(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/(?!\n)\p{Cc}/gu, " ")
    .replace(/(?![\u200C\u200D])\p{Cf}/gu, "")
    .normalize("NFC")
    .split("\n")
    .map((line) => line.replace(/[  ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "#" + 1–100 letters (with their combining marks, e.g. Devanagari), digits or underscores. */
const HASHTAG = new RegExp(`^#[\\p{L}\\p{M}\\p{N}_]{1,${CAPTION_OUTPUT_LIMITS.hashtagCharsMax}}$`, "u");
/** A hashtag written inside the caption text. */
const HASHTAG_IN_TEXT = /(^|\s)#[\p{L}\p{N}_]/u;

/** Trims, adds a missing "#", NFC. The format itself is checked by isValidHashtag. */
export function normalizeHashtag(raw: string): string {
  const text = raw.replace(/(?![\u200C\u200D])\p{Cf}/gu, "").normalize("NFC").trim();
  return text.startsWith("#") ? text : `#${text}`;
}

export function isValidHashtag(tag: string): boolean {
  return HASHTAG.test(tag);
}

const RawOutputSchema = z.object({ suitable: z.boolean(), caption: z.string(), hashtags: z.array(z.string()) });

const DEVANAGARI = /\p{Script=Devanagari}/u;
const LETTER = /\p{L}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;

/** English and Hinglish: at least 80% of the letters are Latin (as brainstorm/output.ts). */
function mostlyLatin(text: string): boolean {
  const letters = text.match(LETTER)?.length ?? 0;
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  return letters > 0 && latin / letters >= 0.8;
}

export type PostCaptionEvaluation = { kind: "ok"; suggestion: PostCaptionSuggestion } | { kind: "unsuitable" } | { kind: "invalid"; problems: string[] };

/** Parse and check the model's JSON text. */
export function evaluatePostCaptionOutput(text: string, language: Language): PostCaptionEvaluation {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", problems: ["The answer was not valid JSON."] };
  }
  const parsed = RawOutputSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "invalid", problems: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(answer)"}: ${i.message}`) };
  }
  if (!parsed.data.suitable) return { kind: "unsuitable" };

  const { captionMax, hashtagsMin, hashtagsMax, hashtagCharsMax } = CAPTION_OUTPUT_LIMITS;
  const problems: string[] = [];
  const caption = cleanSuggestedCaption(parsed.data.caption);
  if (caption.length === 0) problems.push("The caption is empty.");
  else if (length(caption) > captionMax) problems.push(`The caption has ${length(caption)} characters; at most ${captionMax} are allowed.`);
  else if (HASHTAG_IN_TEXT.test(caption)) problems.push('The caption contains hashtags; put every hashtag only in "hashtags".');
  else if (language === "hi" && !DEVANAGARI.test(caption)) problems.push("The caption is not written in Hindi (Devanagari script).");
  else if (language !== "hi" && !mostlyLatin(caption)) problems.push(`The caption is not in ${language === "en" ? "English" : "Roman script"}; use Latin letters only.`);

  const hashtags: string[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.data.hashtags) {
    const tag = normalizeHashtag(raw);
    if (!isValidHashtag(tag)) {
      problems.push(`The hashtag "${tag.slice(0, 40)}" is not allowed: "#" then 1-${hashtagCharsMax} letters, digits or underscores, no spaces.`);
      continue;
    }
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue; // a repeated hashtag is simply dropped
    seen.add(key);
    hashtags.push(tag);
  }
  if (hashtags.length < hashtagsMin || hashtags.length > hashtagsMax) problems.push(`There were ${hashtags.length} different valid hashtags; ${hashtagsMin} to ${hashtagsMax} are needed.`);

  return problems.length > 0 ? { kind: "invalid", problems } : { kind: "ok", suggestion: { caption, hashtags } };
}
