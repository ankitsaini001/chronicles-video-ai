import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SceneAlignmentSchema,
  type Plan,
  type Scene,
  type SceneAlignment,
  type VoicePreset,
  type VoiceSettings,
} from "../contracts";
import { canonicalJson } from "../planning";
import { ProviderError, type SpeechRequest, type SpeechResponse } from "../providers";
import { sha256 } from "../shared/hash";
import type { SpeechCacheRecord } from "../storage";
import { localeFor, resolveProviderAlignment, speechInputForScene, timeSceneBlocks } from "../timing";
import type { AudioProbe } from "../validation/audio";

/**
 * Speech stage helpers (PIPELINE_DESIGN.md §6 "Start with scene-level speech synthesis", §8 "Speech").
 *
 * - One request per scene: the scene's narration blocks (speech form, else text) in order, joined
 *   by single spaces, plus previous_text / next_text from the neighbouring scenes for continuity.
 * - The same voice, model and explicit settings for the whole video. The voice comes from the
 *   plan's voicePreset via configuration; there is no fallback voice.
 * - Cache key = sha256 of everything that changes the audio for this scene: speech text, the
 *   per-block pronunciation mapping, voice ID, model, settings, output format, seed and text
 *   normalization mode. The continuity context is recorded but deliberately NOT in the key, so a
 *   wording change in one scene re-synthesizes only that scene (§9).
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

/** Characters as the provider counts them (code points). */
export function countCharacters(text: string): number {
  return [...text].length;
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

/** Continuity context: the last block of the previous scene and the first block of the next scene. */
export function sceneContext(plan: Plan, index: number): { previousText: string | null; nextText: string | null } {
  const previous = plan.scenes[index - 1]?.narration.at(-1);
  const next = plan.scenes[index + 1]?.narration[0];
  return { previousText: previous ? (previous.speech ?? previous.text) : null, nextText: next ? (next.speech ?? next.text) : null };
}

export function speechRequestFor(plan: Plan, index: number, config: SpeechConfig): SpeechRequest {
  const scene = plan.scenes[index]!;
  return {
    voiceId: config.voiceId,
    modelId: config.modelId,
    text: speechInputForScene(scene).speechText,
    ...sceneContext(plan, index),
    settings: config.settings,
    outputFormat: config.outputFormat,
    seed: config.seed,
    applyTextNormalization: config.applyTextNormalization,
  };
}

export function cacheRecordFor(cacheKey: string, request: SpeechRequest, response: SpeechResponse, at: Date): SpeechCacheRecord {
  return {
    schemaVersion: 1,
    cacheKey,
    audioSha256: sha256(response.audio),
    audioBytes: response.audio.byteLength,
    request: { ...request },
    alignment: response.alignment,
    normalizedAlignment: response.normalizedAlignment,
    requestId: response.requestId,
    characterCost: response.characterCost,
    charactersSent: countCharacters(request.text),
    synthesizedAt: at.toISOString(),
  };
}

/**
 * Build and fully check the scene alignment from a provider (or cached) response:
 * validate both provider alignments against the decoded audio, map normalization back to the
 * speech text, then check the approved text and caption text map onto the spoken words with
 * certainty (the same mapping the compiler uses). Throws AlignmentValidationError /
 * AlignmentMappingError on anything uncertain.
 */
export function buildSceneAlignment(input: {
  plan: Plan;
  scene: Scene;
  config: SpeechConfig;
  record: SpeechCacheRecord;
  probe: AudioProbe;
}): SceneAlignment {
  const { plan, scene, config, record, probe } = input;
  const { speechText, blocks } = speechInputForScene(scene);
  const resolved = resolveProviderAlignment({
    sceneId: scene.id,
    speechText,
    original: record.alignment,
    normalized: record.normalizedAlignment,
    audioDurationSeconds: probe.decodedSeconds,
    locale: localeFor(plan.language),
  });
  const request = record.request as Partial<SpeechRequest>;
  const alignment = SceneAlignmentSchema.parse({
    schemaVersion: 1,
    sceneId: scene.id,
    source: "elevenlabs",
    speechText,
    blocks,
    audioDurationSeconds: probe.decodedSeconds,
    audio: {
      sceneId: scene.id,
      sha256: record.audioSha256,
      durationMs: Math.round(probe.decodedSeconds * 1000),
      voiceId: config.voiceId,
      model: config.modelId,
    },
    alignment: resolved.alignment,
    normalizedAlignment: record.normalizedAlignment,
    speech: {
      provider: "elevenlabs",
      cacheKey: record.cacheKey,
      voicePreset: config.voicePreset,
      voiceId: config.voiceId,
      modelId: config.modelId,
      outputFormat: config.outputFormat,
      settings: config.settings,
      seed: config.seed,
      applyTextNormalization: config.applyTextNormalization,
      previousText: request.previousText ?? null,
      nextText: request.nextText ?? null,
      requestId: record.requestId,
      characterCost: record.characterCost,
      charactersSent: record.charactersSent,
      synthesizedAt: record.synthesizedAt,
      mappedFrom: resolved.mappedFrom,
      providerAlignment: record.alignment,
      audioProbe: probe,
    },
  });
  timeSceneBlocks(scene, alignment, plan.language); // throws if the text cannot be mapped with certainty
  return alignment;
}

/** Probe audio bytes by writing them to a temp file (used for cached audio before it is in the run). */
export async function probeAudioBytes(audio: Uint8Array, probe: (file: string) => Promise<AudioProbe>): Promise<AudioProbe> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bytereel-audio-"));
  try {
    const file = path.join(dir, "scene.mp3");
    await fs.writeFile(file, audio);
    return await probe(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export class SpeechBudgetError extends ProviderError {
  constructor(message: string) {
    super({ provider: "elevenlabs", kind: "budget", message });
    this.name = "SpeechBudgetError";
  }
}
