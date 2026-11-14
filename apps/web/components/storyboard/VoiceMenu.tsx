"use client";

import { VOICE_PRESET_LIST, VOICE_TEXT_LANG, type VoiceLanguage, type VoicePresetId } from "@bytereel/db/voices";
import { Icon, cn } from "@/components/ui";
import { usePopover } from "@/components/ui/usePopover";
import { useVoicePreview } from "@/components/project/useVoicePreview";

// "Female voice ▾" on the storyboard header (F19; PRD §9). Offers only the two voices of the
// project's language (the language can't change, PRD decision #25). Choosing the other one saves a
// new storyboard version (D4): no AI call, nothing counted. ▶ plays the pre-recorded sample, only
// for voices whose sample file exists (F13: the Hindi/Hinglish samples don't exist yet; switching
// is still allowed, the voice is just metadata until F23 records the narration).

type VoiceMenuProps = {
  language: VoiceLanguage;
  current: "female" | "male";
  samplePresets: readonly VoicePresetId[];
  disabled: boolean;
  onChoose: (gender: "female" | "male") => void;
};

export function VoiceMenu({ language, current, samplePresets, disabled, onChoose }: VoiceMenuProps) {
  const { open, setOpen, toggle, wrapperRef, buttonRef, panelId } = usePopover();
  const preview = useVoicePreview();
  const voices = VOICE_PRESET_LIST.filter((v) => v.language === language);
  const currentVoice = voices.find((v) => v.gender === current);
  const lang = language === "hi" ? VOICE_TEXT_LANG.hi : undefined;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (open) preview.stop();
          toggle();
        }}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1 text-xs font-medium text-text transition hover:border-amber/40 disabled:pointer-events-none disabled:opacity-60"
      >
        <span lang={lang}>{currentVoice?.label}</span>
        <span className="sr-only">: change the voice</span>
        <Icon name="chevron" className={cn("size-3.5 text-muted transition", open && "rotate-180")} />
      </button>
      <div id={panelId} hidden={!open} className="absolute left-0 z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-2 shadow-card">
        <p className="px-3 pt-1 pb-2 font-mono text-[11px] tracking-wider text-muted uppercase">Narrator voice</p>
        <ul className="flex flex-col gap-0.5">
          {voices.map((v) => {
            const isCurrent = v.gender === current;
            const playing = preview.playing === v.sampleUrl;
            return (
              <li key={v.preset} className="flex items-center gap-1.5">
                {isCurrent ? (
                  <div aria-current="true" className="flex min-h-11 flex-1 items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 text-sm text-text">
                    <span lang={lang}>{v.label}</span>
                    <span className="text-xs text-amber">current</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      preview.stop();
                      setOpen(false);
                      onChoose(v.gender);
                    }}
                    className="flex min-h-11 flex-1 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 text-left text-sm text-text transition hover:bg-surface-2"
                  >
                    <span lang={lang}>{v.label}</span>
                    <span className="text-xs font-medium text-amber">Switch</span>
                  </button>
                )}
                {samplePresets.includes(v.preset) && (
                  <button
                    type="button"
                    onClick={() => preview.toggle(v.sampleUrl)}
                    aria-label={`${playing ? "Stop" : "Play"} ${v.gender} voice sample`}
                    className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line text-amber transition hover:border-amber/40"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5 fill-current">
                      {playing ? <rect x="6" y="6" width="12" height="12" rx="1.5" /> : <polygon points="7,4 20,12 7,20" />}
                    </svg>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="px-3 pt-2 pb-1 text-xs text-muted">Switching saves a new version of the storyboard.</p>
        <p role="status" className="px-3 text-xs text-warning empty:hidden">
          {preview.failed ? "Couldn't play this sample. Please try again." : ""}
        </p>
      </div>
    </div>
  );
}
