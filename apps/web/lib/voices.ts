import { VOICE_PRESET_LIST, type VoiceLanguage, type VoicePresetInfo } from "@bytereel/db/voices";
import { API_MESSAGES, ApiProblem } from "./api/v1";

// B4 GET /api/v1/voices (docs/API.md §14.2): the voice presets with their pre-recorded samples.
// The list is the shared one (packages/db/src/voices.ts); voice IDs are never part of it.
// `enabled` is always true for now: an admin switching a preset off comes with the settings
// page (I12, `settings.voices.enabledPresets`).

export type VoiceItem = VoicePresetInfo & { enabled: boolean };

const LANGUAGES: readonly VoiceLanguage[] = ["en", "hi", "hinglish"];

/** `?language=` is optional; anything other than one known language is 400 INVALID_INPUT. */
export function listVoices(url: URL): { items: VoiceItem[] } {
  const values = url.searchParams.getAll("language");
  let language: VoiceLanguage | null = null;
  if (values.length > 0) {
    const found = values.length === 1 ? LANGUAGES.find((l) => l === values[0]) : undefined;
    if (!found) {
      throw new ApiProblem(400, "INVALID_INPUT", API_MESSAGES.INVALID_INPUT, {
        issues: [{ path: "language", message: `must be one of ${LANGUAGES.join(", ")}` }],
      });
    }
    language = found;
  }
  return {
    items: VOICE_PRESET_LIST.filter((p) => language === null || p.language === language).map((p) => ({ ...p, enabled: true })),
  };
}
