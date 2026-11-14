import { statSync } from "node:fs";
import path from "node:path";
import { VOICE_PRESET_LIST, type VoiceLanguage, type VoicePresetId, type VoicePresetInfo } from "@bytereel/db/voices";
import { API_MESSAGES, ApiProblem } from "./api/v1";

// Voice presets for the web app (server code only): B4 GET /api/v1/voices (docs/API.md §14.2) and
// the ① Idea screen's ▶ buttons (F13).
// The list is the shared one (packages/db/src/voices.ts); voice IDs are never part of it.
// A preset's sample counts as available only when its MP3 really exists (and isn't empty) in
// apps/web/public/voices/. The Hindi/Hinglish samples wait for a voice-plan decision before F23
// (founder, 2026-11-13); once `npm run voices:samples` records them, their ▶ appears and B4 gives
// their URL, with no code change. Without a file: no ▶, and B4 answers `sampleUrl: null`.
// `enabled` is always true for now: an admin switching a preset off comes with I12.

export type VoiceItem = Omit<VoicePresetInfo, "sampleUrl"> & { sampleUrl: string | null; enabled: boolean };

const LANGUAGES: readonly VoiceLanguage[] = ["en", "hi", "hinglish"];

/** Where Next serves /voices/* from. `next dev/build/start` run with apps/web as the working folder. */
export const VOICES_PUBLIC_DIR = path.join(process.cwd(), "public", "voices");
/** Look at the folder again at most once a minute (a new recording shows up without a restart). */
const CACHE_MS = 60_000;

/** The presets whose sample MP3 exists in `dir` and is not empty. */
export function findAvailableSamples(dir: string): Set<VoicePresetId> {
  const found = new Set<VoicePresetId>();
  for (const p of VOICE_PRESET_LIST) {
    try {
      const stat = statSync(path.join(dir, `${p.preset}.mp3`));
      if (stat.isFile() && stat.size > 0) found.add(p.preset);
    } catch {
      // not recorded yet
    }
  }
  return found;
}

let cache: { at: number; presets: Set<VoicePresetId> } | null = null;

/** The presets with a sample file, re-checked at most once a minute. */
export function availableSamples(now = Date.now()): ReadonlySet<VoicePresetId> {
  if (!cache || now - cache.at >= CACHE_MS) cache = { at: now, presets: findAvailableSamples(VOICES_PUBLIC_DIR) };
  return cache.presets;
}

/** `?language=` is optional; anything other than one known language is 400 INVALID_INPUT. */
export function listVoices(url: URL, available: ReadonlySet<VoicePresetId>): { items: VoiceItem[] } {
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
    items: VOICE_PRESET_LIST.filter((p) => language === null || p.language === language).map((p) => ({
      ...p,
      sampleUrl: available.has(p.preset) ? p.sampleUrl : null,
      enabled: true,
    })),
  };
}
