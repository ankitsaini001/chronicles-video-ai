import { z } from "zod";
import { ICON_NAMES } from "../planning/icon-catalog";
import { LanguageSchema, SafeIdSchema, SCENE_TYPES, VoicePresetSchema } from "./common";

/**
 * Plan + scene contract (PIPELINE_DESIGN.md §5).
 *
 * The schema checks *shape*. Rules that need the whole plan (first/last scene,
 * anchors, targets, catalog limits, duration, script) live in
 * src/planning/semantic-validation.ts.
 *
 * Objects are strict: unknown keys are rejected so a typo never passes silently.
 */

export const PLAN_SCHEMA_VERSION = 1;

/**
 * One narration block. `text` is the approved wording.
 * - `speech`: what is sent to text-to-speech when it differs from `text`
 *   (numbers, acronyms, Hinglish words written in Devanagari for better pronunciation).
 * - `display`: what captions show when it differs from `text`.
 * null means "same as text". The block itself is the explicit text/speech/display mapping.
 */
export const NarrationBlockSchema = z.strictObject({
  id: SafeIdSchema,
  text: z.string().trim().min(1, "narration text cannot be empty"),
  speech: z.string().trim().min(1).nullable().default(null),
  display: z.string().trim().min(1).nullable().default(null),
});
export type NarrationBlock = z.infer<typeof NarrationBlockSchema>;

/** A visual object drawn by the scene's pattern component. `kind` must be in the component catalog. */
export const VisualObjectSchema = z.strictObject({
  id: SafeIdSchema,
  kind: z.string().min(1),
  /** Short, human-readable on-screen text (never a list of icon search words). */
  label: z.string().trim().min(1, "label cannot be empty"),
  /**
   * Optional icon from the local icon set (src/planning/icon-catalog.ts). When absent the renderer
   * falls back to the label keyword table. Optional (not nullable-with-default) on purpose: plans
   * approved before this field existed parse and hash exactly as before.
   */
  icon: z
    .enum(ICON_NAMES, { error: (issue) => `unknown icon ${JSON.stringify(issue.input)}; allowed icons: ${ICON_NAMES.join(", ")}` })
    .optional(),
  /** Numeric value for chart bars/points/slices and counters. null for everything else. */
  value: z.number().finite().nullable().default(null),
});
export type VisualObject = z.infer<typeof VisualObjectSchema>;

/** An event is anchored to a phrase in a narration block. Never a raw timestamp. */
export const SceneEventSchema = z.strictObject({
  id: SafeIdSchema,
  anchor: z.strictObject({
    narrationId: SafeIdSchema,
    phrase: z.string().trim().min(1, "anchor phrase cannot be empty"),
  }),
  action: z.string().min(1),
  target: SafeIdSchema,
});
export type SceneEvent = z.infer<typeof SceneEventSchema>;

export const SceneSchema = z.strictObject({
  id: SafeIdSchema,
  type: z.enum(SCENE_TYPES, {
    error: (issue) =>
      `unknown motion pattern ${JSON.stringify(issue.input)}; allowed patterns: ${SCENE_TYPES.join(", ")}`,
  }),
  narration: z.array(NarrationBlockSchema).min(1, "a scene needs at least one narration block"),
  objects: z.array(VisualObjectSchema),
  events: z.array(SceneEventSchema),
});
export type Scene = z.infer<typeof SceneSchema>;

/** User-provided reference notes with a stable ID. The planner must never invent citations. */
export const SourceSchema = z.strictObject({
  id: SafeIdSchema,
  title: z.string().trim().min(1),
  notes: z.string().trim().max(20_000),
});
export type Source = z.infer<typeof SourceSchema>;

/** Unsupported or uncertain content that a human should look at during review. */
export const PlanWarningSchema = z.strictObject({
  sceneId: SafeIdSchema.nullable().default(null),
  message: z.string().trim().min(1),
});
export type PlanWarning = z.infer<typeof PlanWarningSchema>;

export const PlanSchema = z.strictObject({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
  // Ownership and lineage: assigned by application code, never by the model.
  projectId: SafeIdSchema,
  ownerId: SafeIdSchema,
  versionId: SafeIdSchema,
  parentVersionId: SafeIdSchema.nullable(),
  // Content intent
  topic: z.string().trim().min(1).max(200),
  audience: z.string().trim().min(1).max(200),
  learningObjective: z.string().trim().min(1).max(300),
  language: LanguageSchema,
  voicePreset: VoicePresetSchema,
  sources: z.array(SourceSchema),
  scenes: z.array(SceneSchema).min(2, "a plan needs at least a title-hook and a takeaway scene").max(12),
  warnings: z.array(PlanWarningSchema),
});
export type Plan = z.infer<typeof PlanSchema>;
/** The plan as written in a JSON file, before defaults (speech/display/value = null) are applied. */
export type PlanInput = z.input<typeof PlanSchema>;
