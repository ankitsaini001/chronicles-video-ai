import { z } from "zod";
import { ICON_NAMES } from "../planning/icon-catalog";
import { LanguageSchema, SafeIdSchema, SCENE_TYPES, Sha256Schema } from "./common";

/**
 * Speech, alignment, timeline and caption contracts (PIPELINE_DESIGN.md §6-§8).
 *
 * P1 finalizes the alignment shape (compatible with ElevenLabs character alignment) and the
 * compiled timeline/captions. P2 fills `audio` with real ElevenLabs output; until then the only
 * timing source is a clearly marked synthetic, silent fixture.
 */

/** Where scene timing came from. A synthetic fixture is never a live result. */
export const TIMING_SOURCES = ["elevenlabs", "synthetic-silent-fixture"] as const;
export const TimingSourceSchema = z.enum(TIMING_SOURCES);
export type TimingSource = z.infer<typeof TimingSourceSchema>;

/** P2: one narration audio file per scene. */
export const AudioArtifactSchema = z.strictObject({
  sceneId: SafeIdSchema,
  sha256: Sha256Schema,
  durationMs: z.number().positive(),
  voiceId: z.string().min(1),
  model: z.string().min(1),
});
export type AudioArtifact = z.infer<typeof AudioArtifactSchema>;

/**
 * Character-level alignment, field names exactly as ElevenLabs returns them
 * (`alignment` / `normalized_alignment` in the text-to-speech "with-timestamps" response).
 * Shape only; ordering/bounds are checked by validateCharacterAlignment() in packages/pipeline/src/timing.
 */
export const CharacterAlignmentSchema = z.strictObject({
  characters: z.array(z.string()),
  character_start_times_seconds: z.array(z.number()),
  character_end_times_seconds: z.array(z.number()),
});
export type CharacterAlignment = z.infer<typeof CharacterAlignmentSchema>;

/** Voice settings sent explicitly with every request, so the voice's dashboard defaults never leak in. */
export const VoiceSettingsSchema = z.strictObject({
  stability: z.number().min(0).max(1),
  similarity_boost: z.number().min(0).max(1),
  style: z.number().min(0).max(1),
  use_speaker_boost: z.boolean(),
  speed: z.number().min(0.7).max(1.2),
});
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

/** How live speech was produced (P2b). Recorded with the alignment; never contains secrets. */
export const SpeechProvenanceSchema = z.strictObject({
  provider: z.literal("elevenlabs"),
  /** Content address of the speech input (text, pronunciation mapping, voice, model, settings). */
  cacheKey: Sha256Schema,
  voicePreset: z.string().min(1),
  voiceId: z.string().min(1),
  modelId: z.string().min(1),
  outputFormat: z.string().min(1),
  settings: VoiceSettingsSchema,
  seed: z.number().int().nonnegative().nullable(),
  applyTextNormalization: z.enum(["auto", "on", "off"]),
  /** Continuity context sent with the request (not part of the cache key). */
  previousText: z.string().nullable(),
  nextText: z.string().nullable(),
  requestId: z.string().nullable(),
  /** Characters the provider reported charging (x-character-count header), when it reported it. */
  characterCost: z.number().int().nonnegative().nullable(),
  /** Characters of `text` sent (our own count; retries counted separately in the manifest). */
  charactersSent: z.number().int().nonnegative(),
  synthesizedAt: z.iso.datetime(),
  /**
   * Which provider alignment the timings come from: "original" when the provider's original
   * alignment spells the speech text exactly, "normalized" when the original did not and the
   * normalized alignment was mapped back to the speech text word by word (many-to-many).
   */
  mappedFrom: z.enum(["original", "normalized"]),
  /** The provider's original alignment exactly as returned (null if it returned none). */
  providerAlignment: CharacterAlignmentSchema.nullable(),
  /** Decoded audio facts from probing the MP3 itself. */
  audioProbe: z.strictObject({
    codec: z.string().nullable(),
    sampleRate: z.number().int().positive().nullable(),
    channels: z.number().int().positive().nullable(),
    decodedSeconds: z.number().positive(),
  }),
});
export type SpeechProvenance = z.infer<typeof SpeechProvenanceSchema>;

/**
 * Per-scene speech timing: alignment/<scene-id>.json (live) or
 * alignment/<scene-id>.synthetic.json (synthetic fixture).
 *
 * `speechText` is exactly what was (or would be) sent to text-to-speech: the scene's narration
 * blocks (speech form, else text) joined by single spaces. `blocks` records each narration block's
 * span in it, so timing can be mapped back to approved text and caption display text.
 */
export const SceneAlignmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sceneId: SafeIdSchema,
  source: TimingSourceSchema,
  speechText: z.string().min(1),
  blocks: z.array(
    z.strictObject({
      narrationId: SafeIdSchema,
      /** UTF-16 offsets into speechText, end exclusive. */
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    }),
  ).min(1),
  /** Decoded audio duration; the basis for the scene length (never the last caption character). */
  audioDurationSeconds: z.number().positive(),
  /** Audio artifact for live speech (P2). null for the synthetic silent fixture. */
  audio: AudioArtifactSchema.nullable(),
  alignment: CharacterAlignmentSchema,
  normalizedAlignment: CharacterAlignmentSchema.nullable(),
  /** Live speech provenance (P2b). Absent for the synthetic fixture. */
  speech: SpeechProvenanceSchema.optional(),
});
export type SceneAlignment = z.infer<typeof SceneAlignmentSchema>;

// ---------- compiled timeline (timeline.json) ----------

export const VIDEO_FORMAT = { fps: 30, width: 1080, height: 1920 } as const;

export const TimelineObjectSchema = z.strictObject({
  id: SafeIdSchema,
  kind: z.string().min(1),
  label: z.string().min(1),
  /** Explicit icon from the plan; null means "pick from the label" (keyword fallback). */
  icon: z.enum(ICON_NAMES).nullable().default(null),
  value: z.number().finite().nullable(),
  /** Absolute frame at which the object starts to appear. */
  revealFrame: z.number().int().nonnegative(),
});
export type TimelineObject = z.infer<typeof TimelineObjectSchema>;

export const TimelineEventSchema = z.strictObject({
  id: SafeIdSchema,
  action: z.string().min(1),
  target: SafeIdSchema,
  narrationId: SafeIdSchema,
  phrase: z.string().min(1),
  /** Absolute frames: start = floor(phrase start), end = ceil(phrase end); end > start. */
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const TimelineSceneSchema = z.strictObject({
  sceneId: SafeIdSchema,
  type: z.enum(SCENE_TYPES),
  startFrame: z.number().int().nonnegative(),
  /** ceil((audioDurationSeconds + holdMs / 1000) * fps) */
  durationFrames: z.number().int().positive(),
  audioDurationSeconds: z.number().positive(),
  holdMs: z.number().int().nonnegative(),
  /** Artifact key of the scene audio (P2), played from startFrame. null when silent. */
  audioKey: z.string().nullable(),
  objects: z.array(TimelineObjectSchema),
  events: z.array(TimelineEventSchema),
});
export type TimelineScene = z.infer<typeof TimelineSceneSchema>;

export const TimelineSchema = z.strictObject({
  schemaVersion: z.literal(1),
  fps: z.literal(VIDEO_FORMAT.fps),
  width: z.literal(VIDEO_FORMAT.width),
  height: z.literal(VIDEO_FORMAT.height),
  totalFrames: z.number().int().positive(),
  language: LanguageSchema,
  planHash: Sha256Schema,
  timingSource: TimingSourceSchema,
  scenes: z.array(TimelineSceneSchema).min(1),
});
export type Timeline = z.infer<typeof TimelineSchema>;

// ---------- captions (captions.json) ----------

export const CaptionSchema = z.strictObject({
  id: z.string().min(1),
  sceneId: SafeIdSchema,
  /** Absolute frames, end exclusive. */
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
  text: z.string().min(1),
  /** Pre-broken lines (1 or 2). The renderer never re-wraps them. */
  lines: z.array(z.string().min(1)).min(1).max(2),
});
export type Caption = z.infer<typeof CaptionSchema>;

export const CaptionTrackSchema = z.strictObject({
  schemaVersion: z.literal(1),
  timingSource: TimingSourceSchema,
  language: LanguageSchema,
  /** How line widths were decided, e.g. "estimate:char-class-v1" (no browser outside rendering). */
  widthMethod: z.string().min(1),
  fontSizePx: z.number().positive(),
  maxLineWidthPx: z.number().positive(),
  captions: z.array(CaptionSchema),
});
export type CaptionTrack = z.infer<typeof CaptionTrackSchema>;
