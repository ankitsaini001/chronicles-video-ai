import { z } from "zod";
import { HERO_NAMES } from "../planning/hero-catalog";
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

/**
 * One step of a scene's hero track (F22b): from `startFrame` on, the big object in the middle of
 * the screen is `hero`; null means "no hero fits", and the scene's `icon` is shown large in a
 * glowing medallion instead. `source` says where the choice came from: the planner's pick for the
 * narration block ("plan"; hero null when the planner said "none"), the free keyword fallback
 * ("keyword"), or the icon medallion because nothing was named ("icon").
 * Computed by the timeline compiler (packages/pipeline/src/timing/heroes.ts).
 */
export const HeroStepSchema = z.strictObject({
  startFrame: z.number().int().nonnegative(),
  hero: z.enum(HERO_NAMES).nullable(),
  icon: z.enum(ICON_NAMES),
  source: z.enum(["plan", "keyword", "icon"]),
});
export type HeroStep = z.infer<typeof HeroStepSchema>;

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
  /** The hero track, in frame order; the first step starts at `startFrame` (never an empty screen). */
  heroes: z.array(HeroStepSchema).min(1),
});
export type TimelineScene = z.infer<typeof TimelineSceneSchema>;

/**
 * Version 2 (F22b, video style v4) added the scene hero track and caption word timings. Version 1
 * files (written before) are never read back: a re-render compiles a fresh timeline from the plan
 * and the saved alignment, which is free and deterministic.
 */
export const TIMELINE_SCHEMA_VERSION = 2;

export const TimelineSchema = z.strictObject({
  schemaVersion: z.literal(TIMELINE_SCHEMA_VERSION),
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

/** One caption word: the display token, when it is spoken, and whether it is a key term (amber). */
export const CaptionTrackWordSchema = z.strictObject({
  text: z.string().min(1),
  /** Absolute frames: start = floor(word start), end = ceil(word end). */
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
  /** A number, or a word from the scene's on-screen labels (not a topic word or a stopword). */
  key: z.boolean(),
});
export type CaptionTrackWord = z.infer<typeof CaptionTrackWordSchema>;

export const CaptionSchema = z.strictObject({
  id: z.string().min(1),
  sceneId: SafeIdSchema,
  /** Absolute frames, end exclusive. */
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
  text: z.string().min(1),
  /** Pre-broken lines (1 or 2). The renderer never re-wraps them. */
  lines: z.array(z.string().min(1)).min(1).max(2),
  /**
   * The phrase's words in order (3-5 words, F22b): the renderer highlights the word being spoken.
   * Joined with single spaces they equal `text`, and the lines split them in order.
   */
  words: z.array(CaptionTrackWordSchema).min(1),
  /**
   * Only on a caption drawn smaller than the track's `fontSizePx`: a single word too wide for a line
   * at the normal size, shrunk or broken at a hyphen, slash or dot (timing/captions.ts
   * captionWordFit). Absent on every other caption, so other caption files are unchanged.
   */
  fontSizePx: z.number().positive().optional(),
  /**
   * Only on a caption the creator fixed (F25 caption fixes, timing/caption-overrides.ts): the text
   * the compiler made from the narration. `text` is then the creator's text. Absent on every other
   * caption, so other caption files are unchanged.
   */
  originalText: z.string().min(1).optional(),
});
export type Caption = z.infer<typeof CaptionSchema>;

export const CaptionTrackSchema = z.strictObject({
  schemaVersion: z.literal(TIMELINE_SCHEMA_VERSION),
  timingSource: TimingSourceSchema,
  language: LanguageSchema,
  /** How line widths were decided, e.g. "estimate:char-class-v1" (no browser outside rendering). */
  widthMethod: z.string().min(1),
  fontSizePx: z.number().positive(),
  maxLineWidthPx: z.number().positive(),
  captions: z.array(CaptionSchema),
});
export type CaptionTrack = z.infer<typeof CaptionTrackSchema>;
