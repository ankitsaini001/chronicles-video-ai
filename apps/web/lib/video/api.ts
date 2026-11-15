import { ENABLED_LANGUAGES, voicePresetFor, type VoiceEstimator } from "@bytereel/db";
import { VOICE_ID_ENV_BY_PRESET } from "@bytereel/pipeline/config/voice-env";
import type { VoicePreset } from "@bytereel/pipeline/contracts";
import { getInngest } from "../../inngest/client";
import { storageFromEnv } from "./storage";
import { FAKE_ELEVENLABS_ENV, voiceEstimatorFor, voiceSetupFromEnv } from "./voice";

/**
 * Before saving anything that starts a video job (D8, E2 on a video job; F23): Inngest, the voice
 * (ElevenLabs key, model, and both voices of every enabled language: there is no fallback voice) and
 * the R2 bucket settings must be set up. Otherwise nothing is saved or counted and the answer is 500
 * (the reason goes to the server log only). Returns the voice estimator D8/E2 check the limits with.
 */
export function assertGenerateReady(env: NodeJS.ProcessEnv = process.env): VoiceEstimator {
  const inngest = getInngest(env);
  if (!inngest.ok) throw new Error(`Background jobs are not set up: ${inngest.problem}`);
  const voice = voiceSetupFromEnv(env);
  if (!voice.ok) throw new Error(`The narrator voice is not set up: ${voice.problem}`);
  if (env[FAKE_ELEVENLABS_ENV] !== "1") {
    for (const language of ENABLED_LANGUAGES) {
      for (const gender of ["female", "male"] as const) {
        const name = VOICE_ID_ENV_BY_PRESET[voicePresetFor(language, gender).preset as VoicePreset];
        if (!/^[A-Za-z0-9]{1,64}$/.test(env[name]?.trim() ?? "")) throw new Error(`The narrator voice is not set up: ${name} is missing or not a voice id.`);
      }
    }
  }
  const storage = storageFromEnv(env);
  if (!storage.ok) throw new Error(`File storage (R2) is not set up: ${storage.problem}`);
  return voiceEstimatorFor(voice);
}
