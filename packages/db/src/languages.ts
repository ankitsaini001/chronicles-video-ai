// The video languages, and THE ONE SWITCH that says which of them creators may use now
// (founder, 2026-11-14). Safe for browser code: no database import (`@bytereel/db/languages`).
//
// Hindi and Hinglish are HIDDEN, not removed: the ElevenLabs free plan can't use Hindi voices, so
// those storyboards could never become videos, and no AI tokens should be spent on them. All their
// code, prompts, voice presets, fonts and saved projects stay.
//
// TO TURN THEM BACK ON: add them to ENABLED_LANGUAGES below, e.g. ["en", "hi", "hinglish"]. That is
// all: the home page, the Idea screen (Language row), brainstorm, the server refusals (C2, C7, D5,
// E2: 422 LANGUAGE_UNAVAILABLE) and the storyboard buttons all follow this list
// (docs/features/README.md "Language switch").

/** Every language a project can be saved in (API.md §11.1). Old projects may hold any of them. */
export const LANGUAGES = ["en", "hi", "hinglish"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Languages creators may use NOW. The first one is the default. */
export const ENABLED_LANGUAGES: readonly Language[] = ["en"];

export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", hi: "Hindi", hinglish: "Hinglish" };

export function isLanguageEnabled(language: string): boolean {
  return (ENABLED_LANGUAGES as readonly string[]).includes(language);
}

/** The language to use when the wanted one (e.g. an old account default) is switched off. */
export function enabledLanguageOr(language: Language): Language {
  return isLanguageEnabled(language) ? language : ENABLED_LANGUAGES[0]!;
}

/** "Only English is available right now." (lists every enabled language). */
export function languageUnavailableMessage(enabled: readonly Language[] = ENABLED_LANGUAGES): string {
  const names = enabled.map((l) => LANGUAGE_NAMES[l]);
  const list = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Only ${list} ${names.length > 1 ? "are" : "is"} available right now.`;
}
