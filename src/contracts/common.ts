import { z } from "zod";

/**
 * Safe identifier used for owners, projects, versions, scenes, narration blocks,
 * objects and events. Lowercase letters, digits and dashes only, so an ID can be
 * used as a folder or file name without allowing path tricks like "../".
 */
export const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const SafeIdSchema = z
  .string()
  .regex(
    SAFE_ID_PATTERN,
    "must be 1-64 characters: lowercase letters, digits and dashes, starting with a letter or digit",
  );

export const LANGUAGES = ["en", "hi", "hinglish"] as const;
export const LanguageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof LanguageSchema>;

export const VOICE_PRESETS = [
  "indian-english-male",
  "indian-english-female",
  "hindi-male",
  "hindi-female",
  "hinglish-male",
  "hinglish-female",
] as const;
export const VoicePresetSchema = z.enum(VOICE_PRESETS);
export type VoicePreset = z.infer<typeof VoicePresetSchema>;

/** Which voice presets belong to which language. */
export const VOICE_PRESETS_BY_LANGUAGE: Record<Language, readonly VoicePreset[]> = {
  en: ["indian-english-male", "indian-english-female"],
  hi: ["hindi-male", "hindi-female"],
  hinglish: ["hinglish-male", "hinglish-female"],
};

/** The 8 motion patterns from the PRD (§8.1). */
export const SCENE_TYPES = [
  "title-hook",
  "labeled-diagram",
  "process-flow",
  "comparison",
  "timeline",
  "chart",
  "step-sequence",
  "takeaway",
] as const;
export const SceneTypeSchema = z.enum(SCENE_TYPES);
export type SceneType = z.infer<typeof SceneTypeSchema>;

/** ISO-8601 timestamp string, e.g. 2026-11-12T10:00:00.000Z */
export const TimestampSchema = z.iso.datetime();

/** "sha256:<64 hex chars>" */
export const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must look like sha256:<64 hex characters>");
