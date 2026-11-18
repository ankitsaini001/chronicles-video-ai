import { VoiceSettingsSchema, type Plan, type Scene, type VoicePreset, type VoiceSettings } from "../contracts";
import { canonicalJson } from "../planning/plan-hash";
import type { SpeechRequest } from "../providers";
import { sha256 } from "../shared/hash";
import type { SpeechCacheRecord } from "../storage/speech-cache";
import { speechInputForScene } from "../timing/alignment";

/**
 * The voice setup and the recording cache key (split out of speech.ts in the F25 review). This module
 * loads NO provider code (its only provider import is a type), so the caption-fix worker can check a
 * recording without the ElevenLabs adapter ever being loaded. speech.ts re-exports everything here.
 */

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1,
};
/** 128 kbps MP3 at 44.1 kHz: the provider default, available on the free tier. */
export const SPEECH_OUTPUT_FORMAT = "mp3_44100_128";
/** Fixed seed for repeatability (the provider says determinism is not guaranteed). */
export const SPEECH_SEED = 1;

export interface SpeechConfig {
  voicePreset: VoicePreset;
  voiceId: string;
  modelId: string;
  settings: VoiceSettings;
  outputFormat: string;
  seed: number | null;
  applyTextNormalization: "auto" | "on" | "off";
}

export function speechConfigFor(plan: Plan, voiceId: string, modelId: string): SpeechConfig {
  return {
    voicePreset: plan.voicePreset,
    voiceId,
    modelId,
    settings: DEFAULT_VOICE_SETTINGS,
    outputFormat: SPEECH_OUTPUT_FORMAT,
    seed: SPEECH_SEED,
    applyTextNormalization: "auto",
  };
}

/**
 * F25 caption fixes: the voice setup a recording WAS made with, read from its saved request
 * (alignment.json in R2), so a re-render of an existing video needs no voice settings (and no
 * voice provider) at all. The caller checks that `speechCacheKey(scene, config)` is still the
 * recording's cache key (the narration and voice really are the same). Throws when the request
 * is incomplete.
 */
export function speechConfigFromRecord(plan: Pick<Plan, "voicePreset">, record: Pick<SpeechCacheRecord, "request">): SpeechConfig {
  const request = record.request as Partial<SpeechRequest>;
  const settings = VoiceSettingsSchema.parse(request.settings);
  const normalization = request.applyTextNormalization;
  if (typeof request.voiceId !== "string" || typeof request.modelId !== "string" || typeof request.outputFormat !== "string") {
    throw new Error("the recording's saved request has no voice, model or output format");
  }
  if (normalization !== "auto" && normalization !== "on" && normalization !== "off") throw new Error("the recording's saved request has no text normalization mode");
  return {
    voicePreset: plan.voicePreset,
    voiceId: request.voiceId,
    modelId: request.modelId,
    settings,
    outputFormat: request.outputFormat,
    seed: typeof request.seed === "number" ? request.seed : null,
    applyTextNormalization: normalization,
  };
}

export function speechCacheKey(scene: Scene, config: SpeechConfig): string {
  const { speechText } = speechInputForScene(scene);
  return sha256(
    canonicalJson({
      v: 1,
      provider: "elevenlabs",
      speechText,
      pronunciation: scene.narration.map((block) => ({ text: block.text, speech: block.speech })),
      voiceId: config.voiceId,
      modelId: config.modelId,
      settings: config.settings,
      outputFormat: config.outputFormat,
      seed: config.seed,
      applyTextNormalization: config.applyTextNormalization,
    }),
  );
}

