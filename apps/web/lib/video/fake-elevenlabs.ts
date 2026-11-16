import type { Language, Scene } from "@bytereel/pipeline/contracts";
import { countCharacters } from "@bytereel/pipeline/pipeline/speech";
import { ProviderError, type SpeechCallOptions, type SpeechProvider, type SpeechRequest, type SpeechResponse } from "@bytereel/pipeline/providers";
import { synthesizeSceneAlignment } from "@bytereel/pipeline/timing";

// A stand-in for ElevenLabs, ONLY for the automated end-to-end check (tools/e2e/f23-generate.ts):
// ZERO calls to ElevenLabs. It answers like the real adapter (ElevenLabsSpeech): silent MP3 audio
// plus character timings for exactly the text it was sent, so the whole real pipeline runs after it
// (speech lock, R2 upload, alignment checks, timeline, captions, render, MP4 checks).
// It is switched on only by lib/video/voice.ts, and only on a local test server (test database,
// test port, never on Vercel).
// Test switches in the narration text:
// - "e2e voice busy": the first 3 calls for that text fail as "busy" (the provider's 2 quick retries
//   included), so the job fails with PROVIDER_BUSY; the next call (Try again) succeeds.
// - "e2e voice refused": always refused as a voice-account problem (PROVIDER_UNAVAILABLE).

/** One silent MPEG-1 Layer III frame: 128 kbps, 44.1 kHz, mono, no CRC (decodes as silence). */
function silentFrame(): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0xc0;
  return frame;
}

const FRAME_SECONDS = 1152 / 44100;

/** A silent MP3 at least `seconds` long (whole frames). */
export function silentMp3(seconds: number): Uint8Array {
  const frame = silentFrame();
  const count = Math.max(1, Math.ceil(seconds / FRAME_SECONDS));
  return new Uint8Array(Buffer.concat(Array.from({ length: count }, () => frame)));
}

/** How many calls each text got (per server process), for the "e2e voice busy" switch. */
const callsByText = new Map<string, number>();

export class FakeElevenLabsSpeech implements SpeechProvider {
  readonly name = "elevenlabs-e2e-stand-in";

  constructor(private readonly language: Language = "en") {}

  async synthesize(request: SpeechRequest, options: SpeechCallOptions = {}): Promise<SpeechResponse> {
    const started = Date.now();
    let attempt = 0;
    for (;;) {
      attempt++;
      await options.beforeAttempt?.(attempt);
      const calls = (callsByText.get(request.text) ?? 0) + 1;
      callsByText.set(request.text, calls);
      if (request.text.includes("e2e voice refused")) {
        throw new ProviderError({ provider: "elevenlabs", kind: "account-restricted", status: 402, message: "ElevenLabs stand-in: refused (e2e voice refused)" });
      }
      if (request.text.includes("e2e voice busy") && calls <= 3) {
        const busy = new ProviderError({ provider: "elevenlabs", kind: "transient", status: 503, message: "ElevenLabs stand-in: busy (e2e voice busy)" });
        if (attempt > 2) throw busy;
        options.retry?.onRetry?.({ attempt, waitMs: 0, error: busy }); // the real adapter retries a busy answer twice
        continue;
      }
      break;
    }
    // The same timing rule as the silent fixtures: words at a fixed pace, pauses after punctuation.
    const scene = { id: "stand-in", type: "title-hook", narration: [{ id: "n1", text: request.text, speech: null, display: null }], objects: [], events: [] } as unknown as Scene;
    const synthetic = synthesizeSceneAlignment(scene, this.language);
    const alignment = synthetic.alignment!;
    return {
      audio: silentMp3(synthetic.audioDurationSeconds + 0.1),
      alignment,
      normalizedAlignment: alignment,
      requestId: `e2e-stand-in-${callsByText.get(request.text)}`,
      characterCost: countCharacters(request.text),
      retries: attempt - 1,
      durationMs: Date.now() - started,
    };
  }
}
