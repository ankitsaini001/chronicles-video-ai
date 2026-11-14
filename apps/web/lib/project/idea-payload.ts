import { fitsBrainstormText, ideaInputType } from "@bytereel/db/idea-text";
import type { Language, VoiceGender } from "../auth/session";

// The C2 body the Idea screen sends (API.md C2), kept pure so it can be tested (F14 review).
// A picked brainstorm idea is sent as `inputType: "brainstorm"` + `brainstormChoice` only while
// the text is 3–300 characters AND the Language chip still matches the language the idea was
// written in. Otherwise the text goes as a plain topic/notes (a Hindi idea is never saved as a
// brainstorm choice of an English project).

export type PickedChoice = { subject: string; title: string; hook: string; language: Language };

export type CreateProjectPayload =
  | { inputType: "topic" | "notes"; text: string; language: Language; voiceGender: VoiceGender }
  | { inputType: "brainstorm"; text: string; language: Language; voiceGender: VoiceGender; brainstormChoice: { subject: string; title: string; hook: string } };

/** `text` must already be cleaned (cleanIdeaText). */
export function createProjectPayload(input: { text: string; language: Language; voiceGender: VoiceGender; picked: PickedChoice | null }): CreateProjectPayload {
  const { text, language, voiceGender, picked } = input;
  if (picked && picked.language === language && fitsBrainstormText(text)) {
    return { inputType: "brainstorm", text, language, voiceGender, brainstormChoice: { subject: picked.subject, title: picked.title, hook: picked.hook } };
  }
  return { inputType: ideaInputType(text), text, language, voiceGender };
}

const LANGUAGE_NAMES: Record<Language, string> = { en: "English", hi: "Hindi", hinglish: "Hinglish" };

/** One line under the idea box when the picked idea's language differs from the chosen one. */
export function pickedLanguageHint(picked: PickedChoice | null, language: Language): string | null {
  if (!picked || picked.language === language) return null;
  return `This idea was suggested in ${LANGUAGE_NAMES[picked.language]}. Brainstorm again for ${LANGUAGE_NAMES[language]} ideas.`;
}
