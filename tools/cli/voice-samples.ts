import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { VOICE_PRESET_LIST, type VoiceLanguage, type VoicePresetInfo } from "@bytereel/db/voices";
import { loadLocalEnvFile, readConfig, voiceIdFor, VOICE_ID_ENV_BY_PRESET } from "@bytereel/pipeline/config/config";
import { countCharacters, DEFAULT_VOICE_SETTINGS, SPEECH_SEED } from "@bytereel/pipeline/pipeline";
import { ElevenLabsReadClient, ElevenLabsSpeech, type SpeechProvider } from "@bytereel/pipeline/providers";
import { probeAudioFile, type AudioProbe } from "@bytereel/pipeline/validation";

/**
 * `voice-samples [--force]` (F13, npm run voices:samples): records the 6 voice preview MP3s ONCE
 * into apps/web/public/voices/{preset}.mp3 (decision D7). They are committed to git and served as
 * static files, so pressing ▶ on the Idea screen never calls ElevenLabs.
 *
 * Money safety (every character costs ElevenLabs credit):
 * - a file that already exists is skipped (unless --force), so running it again spends nothing;
 * - it prints the characters it is about to send and refuses above MAX_TOTAL_CHARACTERS;
 * - it checks every needed setting BEFORE the first call, so it never stops halfway for a missing key;
 * - at most ONE text-to-speech call per missing file: retries are switched off, and the first
 *   failure stops the run (the files already made are kept; run again to make the rest).
 * Same model, voice settings, seed and text normalization as the real pipeline (pipeline/speech.ts);
 * only the output format is smaller (64 kbps is plenty for a 5-second preview).
 * Keys and voice IDs are never printed.
 */

export const MAX_TOTAL_CHARACTERS = 600;
/** 64 kbps MP3 at 44.1 kHz: a standard ElevenLabs format, available on the free tier. */
export const SAMPLE_OUTPUT_FORMAT = "mp3_44100_64";
export const VOICES_DIR = path.join("apps", "web", "public", "voices");

/**
 * What is sent to text-to-speech, when it differs from the shown sentence. Hinglish follows the
 * pipeline's pronunciation rule (planning/prompts.ts, contracts/plan.ts `speech`): Hindi words
 * in Devanagari for the speech form, Roman script on screen. English words stay as they are.
 */
export const SAMPLE_SPEECH_TEXT: Partial<Record<VoiceLanguage, string>> = {
  hinglish: "Hello दोस्तों! आज हम समझेंगे कि rainbow कैसे बनता है।",
};

export function speechTextFor(preset: VoicePresetInfo): string {
  return SAMPLE_SPEECH_TEXT[preset.language] ?? preset.sampleText;
}

export interface VoiceSamplesOptions {
  projectRoot: string;
  force: boolean;
  print: (lines: string[]) => void;
  /** Tests pass fakes; by default the real ElevenLabs adapter and the .env file. */
  env?: NodeJS.ProcessEnv;
  speech?: (apiKey: string) => SpeechProvider;
  probe?: (file: string) => Promise<AudioProbe>;
  usage?: (apiKey: string) => Promise<string | null>;
}

export async function runVoiceSamplesCommand(opts: VoiceSamplesOptions): Promise<{ ok: boolean; lines: string[] }> {
  const dir = path.join(opts.projectRoot, VOICES_DIR);
  const todo = VOICE_PRESET_LIST.filter((p) => opts.force || !existsSync(path.join(dir, `${p.preset}.mp3`)));
  const skipped = VOICE_PRESET_LIST.length - todo.length;

  const plan = todo.map((p) => ({ preset: p, text: speechTextFor(p), characters: countCharacters(speechTextFor(p)) }));
  const total = plan.reduce((sum, item) => sum + item.characters, 0);
  const header = [
    "Voice preview samples (LIVE: ElevenLabs text-to-speech)",
    `Folder: ${VOICES_DIR}`,
    `${skipped} of ${VOICE_PRESET_LIST.length} already exist and are skipped${opts.force ? "" : " (use --force to record them again)"}.`,
  ];
  if (todo.length === 0) return { ok: true, lines: [...header, "Nothing to record. No ElevenLabs characters were used."] };

  header.push(
    "To record:",
    ...plan.map((item) => `  ${item.preset.preset.padEnd(22)} ${String(item.characters).padStart(3)} characters`),
    `Total: ${total} characters (limit ${MAX_TOTAL_CHARACTERS}).`,
  );
  if (total > MAX_TOTAL_CHARACTERS) {
    return { ok: false, lines: [...header, `REFUSED: ${total} characters is more than the ${MAX_TOTAL_CHARACTERS} allowed for samples. Nothing was sent.`] };
  }

  if (!opts.env) loadLocalEnvFile(path.join(opts.projectRoot, ".env"));
  const config = readConfig(opts.env ?? process.env);
  const apiKey = config.values.ELEVENLABS_API_KEY;
  const modelId = config.values.ELEVENLABS_MODEL;
  const missing = new Set<string>();
  if (!apiKey) missing.add("ELEVENLABS_API_KEY");
  if (!modelId) missing.add("ELEVENLABS_MODEL");
  for (const item of plan) if (!voiceIdFor(item.preset.preset, config)) missing.add(VOICE_ID_ENV_BY_PRESET[item.preset.preset]);
  if (missing.size > 0 || !apiKey || !modelId) {
    return { ok: false, lines: [...header, `REFUSED: set ${[...missing].join(", ")} in .env first. Nothing was sent.`] };
  }

  opts.print(header);
  const usage = opts.usage ?? defaultUsage;
  const before = await usage(apiKey);
  if (before) opts.print([`ElevenLabs account before: ${before}`]);

  const speech = (opts.speech ?? ((key) => new ElevenLabsSpeech(key)))(apiKey);
  const probe = opts.probe ?? probeAudioFile;
  await mkdir(dir, { recursive: true });
  const lines: string[] = [];
  let charged = 0;
  let made = 0;

  for (const item of plan) {
    const name = item.preset.preset;
    const file = path.join(dir, `${name}.mp3`);
    let audio: Uint8Array;
    let cost: number | null;
    try {
      const response = await speech.synthesize(
        {
          voiceId: voiceIdFor(name, config)!,
          modelId,
          text: item.text,
          previousText: null,
          nextText: null,
          settings: DEFAULT_VOICE_SETTINGS,
          outputFormat: SAMPLE_OUTPUT_FORMAT,
          seed: SPEECH_SEED,
          applyTextNormalization: "auto",
        },
        { retry: { maxRetries: 0 } },
      );
      audio = response.audio;
      cost = response.characterCost;
    } catch (error) {
      lines.push(
        `FAILED ${name}: ${error instanceof Error ? error.message : String(error)}`,
        `Stopped here so nothing more is spent. ${made} file(s) were made this run; run the command again to record the rest (existing files are skipped).`,
      );
      return { ok: false, lines: [...lines, chargedLine(charged, made)] };
    }
    charged += cost ?? item.characters;
    if (audio.byteLength === 0) {
      lines.push(`FAILED ${name}: ElevenLabs returned an empty file. Stopped.`);
      return { ok: false, lines: [...lines, chargedLine(charged, made)] };
    }

    // Write to a temporary name first, so a half-written file is never taken as done.
    const temp = `${file}.part`;
    await writeFile(temp, audio);
    let probed: AudioProbe;
    try {
      probed = await probe(temp);
    } catch (error) {
      await rm(temp, { force: true });
      lines.push(`FAILED ${name}: the audio could not be read (${error instanceof Error ? error.message : String(error)}). Stopped.`);
      return { ok: false, lines: [...lines, chargedLine(charged, made)] };
    }
    await rename(temp, file);
    made++;
    const seconds = probed.decodedSeconds;
    const note = seconds < 2 || seconds > 10 ? "  (please listen: unusual length)" : "";
    lines.push(`  saved ${name}.mp3  ${(audio.byteLength / 1024).toFixed(1)} KB  ${seconds.toFixed(2)} s${cost !== null ? `  (${cost} characters charged)` : ""}${note}`);
  }

  const after = await usage(apiKey);
  return { ok: true, lines: [...lines, chargedLine(charged, made), ...(after ? [`ElevenLabs account after: ${after}`] : []), "Listen to each file, then commit them."] };
}

function chargedLine(charged: number, made: number): string {
  return `Characters used this run: about ${charged} (${made} file(s) saved).`;
}

async function defaultUsage(apiKey: string): Promise<string | null> {
  try {
    const usage = await new ElevenLabsReadClient(apiKey).getCharacterUsage();
    return usage ? `${usage.used} / ${usage.limit} characters used (${usage.limit - usage.used} left)` : null;
  } catch {
    return null;
  }
}
