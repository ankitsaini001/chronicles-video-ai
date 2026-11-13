// Voice presets with their preview samples (docs/API.md B4, §11.1 `VoicePreset`, F13).
// Pure data, no database and no Node-only code: the Idea screen (a client component), the B4
// route and the one-time sample generator (`npm run voices:samples`) all read this one list.
// The preset ids and the language mapping are the same as VOICE_PRESETS / VOICE_PRESETS_BY_LANGUAGE
// in packages/pipeline/src/contracts/common.ts (a test checks they stay equal); the web app doesn't
// depend on the pipeline package, so the list lives here.
// Voice IDs and voice names are never part of this list: they stay in the server's .env
// (ELEVENLABS_VOICE_ID_*). Hinglish uses the Hindi voices (PRD decision #18) but has its own
// sample sentence (founder, 2026-11-13). The MP3s are pre-recorded once and served as static
// files from apps/web/public/voices/ (decision D7): pressing ▶ never calls ElevenLabs.

export type VoiceLanguage = "en" | "hi" | "hinglish";
export type VoicePresetGender = "female" | "male";
export type VoicePresetId =
  | "indian-english-female"
  | "indian-english-male"
  | "hindi-female"
  | "hindi-male"
  | "hinglish-female"
  | "hinglish-male";

export type VoicePresetInfo = {
  preset: VoicePresetId;
  language: VoiceLanguage;
  gender: VoicePresetGender;
  /** Shown to the creator: "Female voice" / "Male voice" style, never a voice name. */
  label: string;
  /** Static file under apps/web/public/voices/. */
  sampleUrl: string;
  /** What the sample says, as shown on screen. */
  sampleText: string;
};

/** The `lang` attribute for text in each language (Hinglish is Hindi written in Latin script). */
export const VOICE_TEXT_LANG: Record<VoiceLanguage, string> = { en: "en-IN", hi: "hi", hinglish: "hi-Latn" };

const SAMPLE_TEXT: Record<VoiceLanguage, string> = {
  en: "Hello! Today, let's understand how a rainbow is formed.",
  hi: "नमस्ते! आज हम समझेंगे कि इंद्रधनुष कैसे बनता है।",
  hinglish: "Hello doston! Aaj hum samjhenge ki rainbow kaise banta hai.",
};

const LABELS: Record<VoiceLanguage, Record<VoicePresetGender, string>> = {
  en: { female: "Female voice", male: "Male voice" },
  hi: { female: "महिला आवाज़ (Female)", male: "पुरुष आवाज़ (Male)" },
  hinglish: { female: "Female voice", male: "Male voice" },
};

const PRESET_PREFIX: Record<VoiceLanguage, string> = { en: "indian-english", hi: "hindi", hinglish: "hinglish" };

function preset(language: VoiceLanguage, gender: VoicePresetGender): VoicePresetInfo {
  const id = `${PRESET_PREFIX[language]}-${gender}` as VoicePresetId;
  return { preset: id, language, gender, label: LABELS[language][gender], sampleUrl: `/voices/${id}.mp3`, sampleText: SAMPLE_TEXT[language] };
}

/** All 6 presets: per language (en, hi, hinglish), female first (the order B4 answers in). */
export const VOICE_PRESET_LIST: readonly VoicePresetInfo[] = (["en", "hi", "hinglish"] as const).flatMap((language) => [
  preset(language, "female"),
  preset(language, "male"),
]);

/** The preset for a language and gender (e.g. `en` + `female` → `indian-english-female`). */
export function voicePresetFor(language: VoiceLanguage, gender: VoicePresetGender): VoicePresetInfo {
  const found = VOICE_PRESET_LIST.find((p) => p.language === language && p.gender === gender);
  if (!found) throw new Error(`No voice preset for ${language} + ${gender}.`);
  return found;
}
