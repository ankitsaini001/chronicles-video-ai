import type { VoicePreset } from "../contracts";

/**
 * Which env var holds the ElevenLabs voice ID for each voice preset (PIPELINE_DESIGN.md §10).
 * There are no separate Hinglish voices: Hinglish presets use the Hindi voices. Pure data, no file
 * access (the web app's video job imports it; config.ts re-exports it for the command-line tools).
 */
export const VOICE_ID_ENV_BY_PRESET: Record<VoicePreset, string> = {
  "indian-english-male": "ELEVENLABS_VOICE_ID_INDIAN_MALE",
  "indian-english-female": "ELEVENLABS_VOICE_ID_INDIAN_FEMALE",
  "hindi-male": "ELEVENLABS_VOICE_ID_HINDI_MALE",
  "hindi-female": "ELEVENLABS_VOICE_ID_HINDI_FEMALE",
  "hinglish-male": "ELEVENLABS_VOICE_ID_HINDI_MALE",
  "hinglish-female": "ELEVENLABS_VOICE_ID_HINDI_FEMALE",
};
