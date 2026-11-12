import { existsSync } from "node:fs";
import type { VoicePreset } from "../contracts";

/**
 * Pipeline configuration (PIPELINE_DESIGN.md §10).
 *
 * Values come from environment variables, optionally loaded from an ignored local `.env` file.
 * Secret values are never printed or written to manifests: reports only say "set" or "missing".
 * Nothing here talks to the network.
 */

export type ConfigStage = "live-english" | "live-hindi-hinglish";

export interface EnvVarSpec {
  name: string;
  secret: boolean;
  /** Which live stage needs it. P0/P1 fixture work needs none of these. */
  neededFor: ConfigStage;
  description: string;
  /** Baseline value suggested by the design doc (shown as a hint, never applied silently). */
  baseline?: string;
}

export const ENV_VARS: readonly EnvVarSpec[] = [
  { name: "GEMINI_API_KEY", secret: true, neededFor: "live-english", description: "Gemini planner API key" },
  { name: "GEMINI_MODEL", secret: false, neededFor: "live-english", description: "Gemini model ID", baseline: "gemini-3.8-flash" },
  { name: "ELEVENLABS_API_KEY", secret: true, neededFor: "live-english", description: "ElevenLabs API key" },
  { name: "ELEVENLABS_MODEL", secret: false, neededFor: "live-english", description: "ElevenLabs model ID", baseline: "eleven_multilingual_v2" },
  { name: "ELEVENLABS_VOICE_ID_INDIAN_MALE", secret: false, neededFor: "live-english", description: "Voice for indian-english-male" },
  { name: "ELEVENLABS_VOICE_ID_INDIAN_FEMALE", secret: false, neededFor: "live-english", description: "Voice for indian-english-female" },
  { name: "ELEVENLABS_VOICE_ID_HINDI_MALE", secret: false, neededFor: "live-hindi-hinglish", description: "Voice for hindi-male and hinglish-male" },
  { name: "ELEVENLABS_VOICE_ID_HINDI_FEMALE", secret: false, neededFor: "live-hindi-hinglish", description: "Voice for hindi-female and hinglish-female" },
];

/**
 * Which env var holds the ElevenLabs voice ID for each voice preset.
 * There are no separate Hinglish voices: Hinglish presets use the Hindi voices.
 */
export const VOICE_ID_ENV_BY_PRESET: Record<VoicePreset, string> = {
  "indian-english-male": "ELEVENLABS_VOICE_ID_INDIAN_MALE",
  "indian-english-female": "ELEVENLABS_VOICE_ID_INDIAN_FEMALE",
  "hindi-male": "ELEVENLABS_VOICE_ID_HINDI_MALE",
  "hindi-female": "ELEVENLABS_VOICE_ID_HINDI_FEMALE",
  "hinglish-male": "ELEVENLABS_VOICE_ID_HINDI_MALE",
  "hinglish-female": "ELEVENLABS_VOICE_ID_HINDI_FEMALE",
};

/** The configured voice ID for a preset, or undefined when it is not set. */
export function voiceIdFor(preset: VoicePreset, config: ConfigReport): string | undefined {
  return config.values[VOICE_ID_ENV_BY_PRESET[preset]];
}

export type EnvVarStatus = "set" | "missing" | "invalid";

export interface EnvVarReport {
  name: string;
  secret: boolean;
  neededFor: ConfigStage;
  status: EnvVarStatus;
  /** Safe text to show: never the secret itself. */
  shown: string;
}

export interface ConfigReport {
  entries: EnvVarReport[];
  readyFor: Record<ConfigStage, boolean>;
  /** Typed values for later stages. Secrets are present here but must never be logged. */
  values: Record<string, string | undefined>;
}

/** Placeholder values that count as "not configured". */
const PLACEHOLDER = /^(|replace-me|changeme|change-me|todo|xxx+|<.*>|your[-_].*)$/i;
/** Config values are single tokens: no whitespace or control characters. */
const VALID_VALUE = /^[^\s\p{Cc}]+$/u;

/**
 * Load `.env` into process.env if it exists. Existing environment variables win.
 * Uses Node's built-in loader (no dependency).
 */
export function loadLocalEnvFile(filePath = ".env"): boolean {
  if (!existsSync(filePath)) return false;
  process.loadEnvFile(filePath);
  return true;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConfigReport {
  const values: Record<string, string | undefined> = {};
  const entries = ENV_VARS.map((spec): EnvVarReport => {
    const raw = env[spec.name]?.trim() ?? "";
    let status: EnvVarStatus;
    if (PLACEHOLDER.test(raw)) status = "missing";
    else if (!VALID_VALUE.test(raw)) status = "invalid";
    else status = "set";

    values[spec.name] = status === "set" ? raw : undefined;
    let shown: string;
    if (status === "missing") shown = spec.baseline ? `missing (design baseline: ${spec.baseline})` : "missing";
    else if (status === "invalid") shown = "invalid (contains spaces or control characters)";
    else shown = spec.secret ? "set (hidden)" : raw;
    return { name: spec.name, secret: spec.secret, neededFor: spec.neededFor, status, shown };
  });

  const readyFor = {
    "live-english": entries.filter((e) => e.neededFor === "live-english").every((e) => e.status === "set"),
    "live-hindi-hinglish": entries.every((e) => e.status === "set"),
  };
  return { entries, readyFor, values };
}

/**
 * Replace any configured secret value, and anything that looks like an auth header,
 * with "[redacted]". Apply to every diagnostic before it is printed or saved.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let result = text;
  for (const spec of ENV_VARS) {
    const value = env[spec.name]?.trim();
    if (spec.secret && value && value.length >= 4) result = result.split(value).join("[redacted]");
  }
  return result
    .replace(/(authorization|x-goog-api-key|xi-api-key)(["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',;]+/gi, "$1$2[redacted]")
    .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[redacted]");
}
