import type { StoredPlan, VoiceEstimator } from "@bytereel/db";
import { VOICE_ID_ENV_BY_PRESET } from "@bytereel/pipeline/config/voice-env";
import type { Language, Plan } from "@bytereel/pipeline/contracts";
import { countCharacters, speechCacheKey, speechConfigFor, speechRequestFor, type SpeechConfig } from "@bytereel/pipeline/pipeline/speech";
import { ElevenLabsSpeech, type SpeechProvider } from "@bytereel/pipeline/providers";
import { FakeElevenLabsSpeech } from "./fake-elevenlabs";

// The narrator voice for the video job (F23, server only): ElevenLabs with ELEVENLABS_API_KEY, the
// model ELEVENLABS_MODEL and one voice per preset (ELEVENLABS_VOICE_ID_*; English: the free premade
// voices Matilda and Brian, founder 2026-11-15). There is NO fallback voice: a missing voice stops
// the job ("Voice service unavailable"). Voice ids never leave the server.
//
// E2E_FAKE_ELEVENLABS=1 swaps ElevenLabs for the local stand-in (fake-elevenlabs.ts): ZERO real calls.
// Allowed ONLY on a local test server: database `bytereel_test`, address http://localhost:3230–3239,
// not on Vercel. Set anywhere else, the video job refuses to run at all. And the other way round:
// on the test database the REAL voice is refused, so a test can never spend real characters.

export const FAKE_ELEVENLABS_ENV = "E2E_FAKE_ELEVENLABS";
const TEST_DB = "bytereel_test";
const TEST_ORIGIN = /^http:\/\/localhost:323\d$/;
const VOICE_ID = /^[A-Za-z0-9]{1,64}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9_.-]{1,79}$/;

/** Why the stand-in switch can't be used here, or null when it is off or allowed. */
export function fakeVoiceProblem(env: NodeJS.ProcessEnv): string | null {
  const flag = env[FAKE_ELEVENLABS_ENV];
  if (flag === undefined || flag === "") return null;
  if (flag !== "1") return `${FAKE_ELEVENLABS_ENV} must be "1" or unset.`;
  if (env.VERCEL || env.VERCEL_ENV) return `${FAKE_ELEVENLABS_ENV} is set on Vercel. Remove it from the project's environment variables.`;
  if (env.MONGODB_DB !== TEST_DB) return `${FAKE_ELEVENLABS_ENV} is only allowed with MONGODB_DB=${TEST_DB}.`;
  if (!TEST_ORIGIN.test(env.BETTER_AUTH_URL ?? "")) return `${FAKE_ELEVENLABS_ENV} is only allowed on a local test server (http://localhost:3230–3239).`;
  return null;
}

export type VoiceSetup =
  | { ok: true; fake: boolean; configFor: (plan: Plan) => SpeechConfig; provider: (language: Language) => SpeechProvider }
  | { ok: false; problem: string };

/** The voice settings from the environment, or the reason the video job can't record narration. */
export function voiceSetupFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceSetup {
  const problem = fakeVoiceProblem(env);
  if (problem) return { ok: false, problem };
  if (env[FAKE_ELEVENLABS_ENV] === "1") {
    return {
      ok: true,
      fake: true,
      // Own (fake) voice and model ids: stand-in recordings can never be mistaken for real ones (another cache key).
      configFor: (plan) => speechConfigFor(plan, plan.voicePreset.endsWith("-male") ? "e2eStandInMale" : "e2eStandInFemale", "e2e_stand_in"),
      provider: (language) => new FakeElevenLabsSpeech(language),
    };
  }
  if (env.MONGODB_DB === TEST_DB) return { ok: false, problem: `On the test database only the stand-in voice may be used (${FAKE_ELEVENLABS_ENV}=1): a test must never spend real ElevenLabs characters.` };
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  const model = env.ELEVENLABS_MODEL?.trim() ?? "";
  if (!apiKey) return { ok: false, problem: "ELEVENLABS_API_KEY is missing. Add it to the .env file." };
  if (!MODEL_ID.test(model)) return { ok: false, problem: "ELEVENLABS_MODEL is missing or not a model id (e.g. eleven_multilingual_v2)." };
  return {
    ok: true,
    fake: false,
    configFor: (plan) => {
      const name = VOICE_ID_ENV_BY_PRESET[plan.voicePreset];
      const voiceId = env[name]?.trim() ?? "";
      // No fallback voice (PRD decision #24c): the job stops with "Voice service unavailable".
      if (!VOICE_ID.test(voiceId)) throw new VoiceNotConfiguredError(`${name} is missing or not a voice id; no other voice is used instead.`);
      return speechConfigFor(plan, voiceId, model);
    },
    provider: () => new ElevenLabsSpeech(apiKey),
  };
}

export class VoiceNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceNotConfiguredError";
  }
}

/**
 * The recordings a plan needs (one per scene): its cache key and the characters ElevenLabs bills.
 * D8 and E2 use it to check the voice limits before starting, the worker to reserve them.
 */
export function voiceEstimatorFor(setup: Extract<VoiceSetup, { ok: true }>): VoiceEstimator {
  return (stored: StoredPlan) => {
    const plan = stored as unknown as Plan;
    const config = setup.configFor(plan);
    return plan.scenes.map((scene, index) => ({ cacheKey: speechCacheKey(scene, config), characters: countCharacters(speechRequestFor(plan, index, config).text) }));
  };
}
