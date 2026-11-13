"use client";

import { VOICE_TEXT_LANG, voicePresetFor, type VoiceLanguage } from "@bytereel/db/voices";
import { cn } from "@/components/ui";
import type { VoiceGender } from "@/lib/auth/session";
import { useVoicePreview } from "./useVoicePreview";

// ① Idea "VOICE" (Stitch "Step 1 Idea": Female voice / Male voice, each with ▶; F13).
// Each voice is a real radio input (styled like the other chips) inside a <fieldset>, with its own
// ▶ button right after it. Real radios, not ChoiceChips: a button may not sit inside a
// role="radiogroup", and native radios keep the same keys (←/→ choose, Tab reaches only the chosen
// one). ▶ plays the sample for the CHOSEN LANGUAGE and that gender from the static MP3 (B4 list,
// packages/db/src/voices.ts); it never calls ElevenLabs. Labels come from the same list, so Hindi
// shows "महिला आवाज़ (Female)", wrapped in lang="hi".
// The parent owns the player (`preview`), so it can stop the sample when the language changes.

const GENDERS: readonly VoiceGender[] = ["female", "male"];

type VoicePickerProps = {
  language: VoiceLanguage;
  value: VoiceGender;
  onChange: (value: VoiceGender) => void;
  preview: ReturnType<typeof useVoicePreview>;
  disabled?: boolean;
  className?: string;
};

export function VoicePicker({ language, value, onChange, preview, disabled = false, className }: VoicePickerProps) {
  const lang = VOICE_TEXT_LANG[language];
  const playingPreset = GENDERS.map((g) => voicePresetFor(language, g)).find((p) => p.sampleUrl === preview.playing);
  const failed = GENDERS.some((g) => voicePresetFor(language, g).sampleUrl === preview.failed);

  return (
    <fieldset className={cn("m-0 min-w-0 border-0 p-0", className)}>
      <legend className="float-left mb-2.5 w-full p-0 font-mono text-xs uppercase tracking-wider text-muted">Voice</legend>
      <div className="clear-both flex flex-wrap gap-2.5">
        {GENDERS.map((gender) => {
          const preset = voicePresetFor(language, gender);
          const checked = gender === value;
          const isPlaying = preview.playing === preset.sampleUrl;
          return (
            <div key={gender} className="flex items-center gap-1.5">
              <label
                className={cn(
                  "inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 py-2 text-sm font-medium transition",
                  "has-focus-visible:outline-2 has-focus-visible:outline-offset-3 has-focus-visible:outline-gold-cream",
                  disabled && "pointer-events-none opacity-50",
                  checked ? "border-amber bg-progress-bg text-text" : "border-line bg-surface-2 text-muted hover:border-amber/40 hover:text-text",
                )}
              >
                <input
                  type="radio"
                  name="voiceGender"
                  value={gender}
                  checked={checked}
                  onChange={() => onChange(gender)}
                  disabled={disabled}
                  className="sr-only"
                />
                <span lang={language === "hi" ? lang : undefined}>{preset.label}</span>
              </label>
              <button
                type="button"
                onClick={() => preview.toggle(preset.sampleUrl)}
                disabled={disabled}
                aria-label={`${isPlaying ? "Stop" : "Play"} ${gender} voice sample`}
                className={cn(
                  "inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border transition",
                  "disabled:pointer-events-none disabled:opacity-50",
                  isPlaying ? "border-amber bg-progress-bg text-amber" : "border-line bg-surface-2 text-amber hover:border-amber/40",
                )}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5 fill-current">
                  {isPlaying ? <rect x="6" y="6" width="12" height="12" rx="1.5" /> : <polygon points="7,4 20,12 7,20" />}
                </svg>
              </button>
            </div>
          );
        })}
      </div>
      {playingPreset && (
        <p className="mt-2.5 text-xs text-muted">
          Playing: “<span lang={lang}>{playingPreset.sampleText}</span>”
        </p>
      )}
      {failed && !playingPreset && (
        <p role="status" className="mt-2.5 text-xs text-warning">
          Couldn&apos;t play this sample. Please try again.
        </p>
      )}
    </fieldset>
  );
}
