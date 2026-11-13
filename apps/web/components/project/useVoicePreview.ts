"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Plays the pre-recorded voice samples (F13, decision D7): static MP3s from /voices/, never an
// ElevenLabs call. One <audio> element for the whole screen, so only one sample plays at a time.
// It is created on the first ▶ press and `play()` is called inside that same click (phones only
// allow sound after a tap). Pressing the playing sample again stops it; `stop()` is also called
// when the language changes and when the screen goes away.

export function useVoicePreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** The sample the <audio> element is busy with; events from an older sample are ignored. */
  const currentRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const stop = useCallback(() => {
    currentRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setPlaying(null);
  }, []);

  const toggle = useCallback(
    (url: string) => {
      if (currentRef.current === url) {
        stop();
        return;
      }
      let audio = audioRef.current;
      if (!audio) {
        audio = new Audio();
        audio.preload = "auto";
        audio.addEventListener("ended", () => {
          currentRef.current = null;
          setPlaying(null);
        });
        audio.addEventListener("error", () => {
          const url = currentRef.current;
          if (url === null) return;
          currentRef.current = null;
          setPlaying(null);
          setFailed(url);
        });
        audioRef.current = audio;
      }
      audio.pause();
      currentRef.current = url;
      audio.src = url;
      setFailed(null);
      setPlaying(url);
      audio.play().catch((error: unknown) => {
        // AbortError = another sample (or stop) took over before this one started: not a failure.
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (currentRef.current !== url) return;
        currentRef.current = null;
        setPlaying(null);
        setFailed(url);
      });
    },
    [stop],
  );

  useEffect(
    () => () => {
      currentRef.current = null;
      audioRef.current?.pause();
    },
    [],
  );

  return { playing, failed, toggle, stop };
}
