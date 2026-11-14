import { z } from "zod";
import type { Language } from "../contracts";
import { BRAINSTORM_IDEA_COUNT, BRAINSTORM_TEXT_LIMITS } from "./prompts";

/**
 * The model's brainstorm answer: the structured-output schema we send, and the strict check of
 * what comes back (API.md C7). The model is never trusted: text is cleaned (control characters
 * and line breaks removed, NFC, spaces collapsed, trimmed), then exactly 5 ideas with lengths in
 * range and the right script for the language are required. Problems go to ONE repair attempt.
 */

export interface BrainstormIdea {
  /** "idea-1" … "idea-5", assigned by our code in answer order. */
  id: string;
  title: string;
  hook: string;
  angle: string;
}

/**
 * JSON Schema for Gemini's structured output. Only widely supported keywords: no minItems /
 * maxItems (gemini-3.6-flash rejects them, PRD decision #19) and no string lengths; our own
 * check below enforces both.
 */
export function brainstormOutputJsonSchema(): Record<string, unknown> {
  const text = (description: string) => ({ type: "string", description });
  return {
    type: "object",
    properties: {
      suitable: { type: "boolean", description: "false only when no safe educational video can be made about the subject" },
      ideas: {
        type: "array",
        description: `Exactly ${BRAINSTORM_IDEA_COUNT} ideas (empty only when suitable is false).`,
        items: {
          type: "object",
          properties: {
            title: text(`Short video title, at most ${BRAINSTORM_TEXT_LIMITS.title.aim} characters.`),
            hook: text(`Opening line(s) the narrator says, at most ${BRAINSTORM_TEXT_LIMITS.hook.aim} characters.`),
            angle: text(`How the video explains it, at most ${BRAINSTORM_TEXT_LIMITS.angle.aim} characters.`),
          },
          required: ["title", "hook", "angle"],
          propertyOrdering: ["title", "hook", "angle"],
        },
      },
    },
    required: ["suitable", "ideas"],
    propertyOrdering: ["suitable", "ideas"],
  };
}

/**
 * Every control character (line breaks and tabs too) becomes a space; invisible format characters
 * (bidi overrides, zero-width space, BOM …) are removed except ZWNJ/ZWJ, which Devanagari needs;
 * then NFC, one space, trim.
 */
export function cleanIdeaField(raw: string): string {
  return raw
    .replace(/\p{Cc}/gu, " ")
    .replace(/(?![\u200C\u200D])\p{Cf}/gu, "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

const RawOutputSchema = z.object({
  suitable: z.boolean(),
  ideas: z.array(z.object({ title: z.string(), hook: z.string(), angle: z.string() })),
});

const DEVANAGARI = /\p{Script=Devanagari}/u;
const LETTER = /\p{L}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;

/** English and Hinglish (Roman script): at least 80% of the letters are Latin (rejects e.g. Chinese or Devanagari answers). */
function mostlyLatin(text: string): boolean {
  const letters = text.match(LETTER)?.length ?? 0;
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  return letters > 0 && latin / letters >= 0.8;
}

export type BrainstormEvaluation =
  | { kind: "ok"; ideas: BrainstormIdea[] }
  /** The model said no safe educational video can be made about this subject. */
  | { kind: "unsuitable" }
  | { kind: "invalid"; problems: string[] };

/** Parse and check the model's JSON text. */
export function evaluateBrainstormOutput(text: string, language: Language): BrainstormEvaluation {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", problems: ["The answer was not valid JSON."] };
  }
  const parsed = RawOutputSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(answer)"}: ${i.message}`);
    return { kind: "invalid", problems };
  }
  if (!parsed.data.suitable) return { kind: "unsuitable" };

  const problems: string[] = [];
  const ideas = parsed.data.ideas.map((raw, index) => ({
    id: `idea-${index + 1}`,
    title: cleanIdeaField(raw.title),
    hook: cleanIdeaField(raw.hook),
    angle: cleanIdeaField(raw.angle),
  }));
  if (ideas.length !== BRAINSTORM_IDEA_COUNT) problems.push(`There were ${ideas.length} ideas; exactly ${BRAINSTORM_IDEA_COUNT} are needed.`);

  ideas.forEach((idea, index) => {
    for (const field of ["title", "hook", "angle"] as const) {
      const value = idea[field];
      const { min, max } = BRAINSTORM_TEXT_LIMITS[field];
      const where = `Idea ${index + 1} ${field}`;
      if (value.length < min) problems.push(`${where} is empty or too short (at least ${min} characters).`);
      else if (value.length > max) problems.push(`${where} has ${value.length} characters; at most ${max} are allowed.`);
      else if (language === "hi" && !DEVANAGARI.test(value)) problems.push(`${where} is not written in Hindi (Devanagari script).`);
      else if (language !== "hi" && !mostlyLatin(value)) problems.push(`${where} is not in ${language === "en" ? "English" : "Roman script"}; use Latin letters only.`);
    }
  });

  const seen = new Set<string>();
  ideas.forEach((idea, index) => {
    const key = idea.title.toLocaleLowerCase();
    if (key && seen.has(key)) problems.push(`Idea ${index + 1} has the same title as an earlier idea.`);
    seen.add(key);
  });

  return problems.length > 0 ? { kind: "invalid", problems } : { kind: "ok", ideas };
}
