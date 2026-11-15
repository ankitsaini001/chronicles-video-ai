import type { CaptionTrack, Timeline } from "../contracts";
import { MUSIC_FILE } from "../theme";

/**
 * The soft background music bed of video style v4 (F22b), generated in code: no downloads, no
 * provider, no cost, the same file every time for the same timeline. 48 kHz stereo 16-bit WAV.
 *
 * - Pad: a warm 4-chord loop (Dmaj7 - Bm7 - Gmaj7 - A6sus, 4 s each) of detuned sines with a slow
 *   breath, plus soft plucked arpeggio notes with a ping-pong echo. One 16 s loop is synthesised
 *   and repeated (fast: about 1 s instead of 12 s for a whole video).
 * - Ducking: the bed sits about 20 dB under the narration while words are spoken and rises about
 *   8 dB in pauses (smooth attack/release), so the voice always leads.
 * - Sound effects: a soft impact on the first frame, a whoosh on every scene change and a gentle
 *   chime on key reveals (checks, chart values).
 *
 * The narration level is a fixed reference: ElevenLabs speech measured about -22 dBFS RMS while
 * speaking on the approved sample (2026-11-15), so no audio decoding is needed here.
 */

/**
 * THE music switch (F22b, founder + colleague 2026-11-15): the soft code-generated music bed is on
 * for every voiced video. Set to false to render narration only. Silent fixture renders never have
 * music (they must stay silent).
 */
export const BACKGROUND_MUSIC = true;

/** Public file name of the music bed (one name, shared with the composition: theme.ts). */
export { MUSIC_FILE };

export const MUSIC_SAMPLE_RATE = 48000;
const SR = MUSIC_SAMPLE_RATE;
const VOICE_RMS = Math.pow(10, -22 / 20);
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
const TAU = Math.PI * 2;

// D3=50, F#3=54, A3=57, C#4=61 / B2=47 ... (voicings in a warm mid register)
const CHORDS = [
  [50, 54, 57, 61],
  [47, 50, 54, 57],
  [43, 47, 50, 54],
  [45, 50, 52, 54],
];
const BAR = 4; // seconds per chord
const LOOP = BAR * CHORDS.length; // 16 s
const ARP = [0, 2, 1, 3, 2, 1, 3, 2]; // 8 plucks of 0.5 s: one bar
const ARP_STEP = 0.5;

export interface MusicInput {
  durationSeconds: number;
  /** Speech spans in seconds (merged word times). */
  speech: [number, number][];
  impacts: number[];
  whooshes: number[];
  chimes: number[];
  /** Final fade-out starts here (seconds). */
  fadeOutAt: number;
}

let cachedLoop: { l: Float32Array; r: Float32Array; rms: number } | null = null;

/** One 16 s loop of pad + arpeggio (computed once per process; deterministic). */
function loop(): { l: Float32Array; r: Float32Array; rms: number } {
  if (cachedLoop) return cachedLoop;
  const n = LOOP * SR;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const barPos = t / BAR;
    const bar = Math.floor(barPos);
    const within = barPos - bar;
    // crossfade into the next chord over the last 25% of a bar (wraps around the loop)
    const xf = within > 0.75 ? 0.5 - 0.5 * Math.cos(((within - 0.75) / 0.25) * Math.PI) : 0;
    const breathe = 0.85 + 0.15 * Math.sin((TAU * t) / LOOP);
    let left = 0;
    let right = 0;
    for (const [chordIndex, weight] of [
      [bar % CHORDS.length, 1 - xf],
      [(bar + 1) % CHORDS.length, xf],
    ] as const) {
      if (weight <= 0) continue;
      const chord = CHORDS[chordIndex]!;
      chord.forEach((note, k) => {
        const f = midi(note);
        const a = Math.sin(TAU * f * 1.0015 * t + k);
        const b = Math.sin(TAU * f * 0.9985 * t + 2 * k);
        const oct = 0.18 * Math.sin(TAU * f * 2 * t + k * 0.7);
        const v = weight * 0.25 * (1 - k * 0.08);
        left += v * (a * 0.7 + b * 0.3 + oct);
        right += v * (a * 0.3 + b * 0.7 + oct);
      });
      const root = Math.sin(TAU * midi(chord[0]! - 12) * t);
      left += weight * 0.22 * root;
      right += weight * 0.22 * root;
    }
    l[i] = left * breathe;
    r[i] = right * breathe;
  }
  // arpeggio with echoes; echoes past the loop end wrap to its start, so the loop is seamless
  for (let s = 0; s * ARP_STEP < LOOP; s++) {
    const t0 = s * ARP_STEP;
    const chord = CHORDS[Math.floor(t0 / BAR) % CHORDS.length]!;
    const f = midi(chord[ARP[s % ARP.length]!]! + 24);
    const accent = s % 4 === 0 ? 1 : 0.7;
    for (const [delay, gain, pan] of [
      [0, 1, 0.5],
      [0.375, 0.32, 0.15],
      [0.75, 0.12, 0.85],
    ] as const) {
      const start = Math.floor((t0 + delay) * SR);
      const len = Math.floor(1.2 * SR);
      for (let j = 0; j < len; j++) {
        const tt = j / SR;
        const env = Math.min(1, tt / 0.006) * Math.exp(-tt / 0.32);
        const v = 0.11 * accent * gain * env * (Math.sin(TAU * f * tt) + 0.25 * Math.sin(TAU * 2 * f * tt));
        const idx = (start + j) % n;
        l[idx]! += v * (1 - pan);
        r[idx]! += v * pan;
      }
    }
  }
  let power = 0;
  for (let i = 0; i < n; i++) power += (l[i]! * l[i]! + r[i]! * r[i]!) / 2;
  cachedLoop = { l, r, rms: Math.sqrt(power / n) };
  return cachedLoop;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The music bed as a WAV file (bytes). */
export function synthMusicBed(input: MusicInput): Buffer {
  const n = Math.ceil(input.durationSeconds * SR);
  const bed = loop();
  const loopN = bed.l.length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);

  // ---- bed, levelled against the voice, with ducking ----
  const underVoice = (VOICE_RMS * Math.pow(10, -20 / 20)) / bed.rms;
  const inPause = underVoice * Math.pow(10, 8 / 20);
  const speaking = new Uint8Array(n);
  for (const [a, b] of input.speech) {
    for (let i = Math.max(0, Math.floor((a - 0.08) * SR)); i < Math.min(n, Math.ceil((b + 0.12) * SR)); i++) speaking[i] = 1;
  }
  const attack = 1 - Math.exp(-1 / (0.08 * SR));
  const release = 1 - Math.exp(-1 / (0.45 * SR));
  const fadeLength = Math.max(0.001, input.durationSeconds - input.fadeOutAt);
  let g = inPause * 0.3; // start a little low; the impact carries frame 0
  for (let i = 0; i < n; i++) {
    const target = speaking[i] ? underVoice : inPause;
    g += (target - g) * (target < g ? attack : release);
    const t = i / SR;
    const fadeIn = Math.min(1, t / 0.4);
    const fadeOut = t > input.fadeOutAt ? Math.max(0, 1 - (t - input.fadeOutAt) / fadeLength) : 1;
    const k = g * fadeIn * fadeOut;
    outL[i] = bed.l[i % loopN]! * k;
    outR[i] = bed.r[i % loopN]! * k;
  }

  // ---- sound effects (not ducked, kept quiet) ----
  const rnd = seeded(2024);
  const level = VOICE_RMS;
  for (const at of input.impacts) {
    const start = Math.floor(at * SR);
    for (let j = 0; j < 1.4 * SR && start + j < n; j++) {
      const tt = j / SR;
      const f = 45 + 50 * Math.exp(-tt / 0.08);
      const boom = Math.sin(TAU * f * tt) * Math.exp(-tt / 0.35);
      const shimmer = (Math.sin(TAU * 1760 * tt) + Math.sin(TAU * 2637 * tt) * 0.6) * Math.exp(-tt / 0.5) * 0.12 * Math.min(1, tt / 0.01);
      const v = level * 1.6 * (boom * 0.9 + shimmer);
      outL[start + j]! += v;
      outR[start + j]! += v;
    }
  }
  for (const at of input.whooshes) {
    // noise through a sweeping band-pass, rising into the cut and tailing after it
    const pre = 0.45;
    const post = 0.4;
    const start = Math.floor((at - pre) * SR);
    let low = 0;
    let band = 0;
    for (let j = 0; j < (pre + post) * SR; j++) {
      const idx = start + j;
      const x = rnd() * 2 - 1;
      if (idx < 0 || idx >= n) continue;
      const tt = j / SR - pre;
      const env = tt < 0 ? Math.pow(1 + tt / pre, 2.2) : Math.exp(-tt / 0.14);
      const fc = tt < 0 ? 400 + 2600 * Math.pow(1 + tt / pre, 2) : 3000 * Math.exp(-tt / 0.2) + 300;
      const fco = 2 * Math.sin((Math.PI * fc) / SR);
      low += fco * band;
      const high = x - low - 0.6 * band;
      band += fco * high;
      const v = level * 0.55 * env * band;
      const pan = 0.5 + 0.35 * Math.max(-1, Math.min(1, tt / pre));
      outL[idx]! += v * (1 - pan) * 1.4;
      outR[idx]! += v * pan * 1.4;
    }
  }
  for (const at of input.chimes) {
    const start = Math.floor(at * SR);
    for (let j = 0; j < 1.0 * SR && start + j < n; j++) {
      const tt = j / SR;
      const env = Math.min(1, tt / 0.004) * Math.exp(-tt / 0.28);
      const v = level * 0.16 * env * (Math.sin(TAU * 1318.5 * tt) + 0.5 * Math.sin(TAU * 1975.5 * tt) + 0.25 * Math.sin(TAU * 2637 * tt));
      outL[start + j]! += v;
      outR[start + j]! += v;
    }
  }

  // ---- write ----
  const out = Buffer.alloc(44 + n * 4);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, outL[i]!)) * 32767), 44 + i * 4);
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, outR[i]!)) * 32767), 44 + i * 4 + 2);
  }
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + n * 4, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 4, 40);
  return out;
}

/** Kinds whose reveal gets a chime (a value or a check). */
const CHIME_KINDS = new Set(["bullet", "pie-slice", "bar", "counter", "line-point"]);

/** Music bed input from the compiled timeline and captions (speech spans, scene changes, key reveals). */
export function musicInputFor(timeline: Timeline, captions: CaptionTrack): MusicInput {
  const fps = timeline.fps;
  const words = captions.captions.flatMap((c) => c.words);
  const spans: [number, number][] = [];
  for (const w of words) {
    const a = w.startFrame / fps;
    const b = w.endFrame / fps;
    const last = spans[spans.length - 1];
    if (last && a - last[1] < 0.35) last[1] = Math.max(last[1], b);
    else spans.push([a, b]);
  }
  const chimes = timeline.scenes.flatMap((s) => s.events.filter((e) => CHIME_KINDS.has(s.objects.find((o) => o.id === e.target)?.kind ?? "")).map((e) => e.startFrame / fps));
  const lastWord = Math.max(0, ...words.map((w) => w.endFrame));
  return {
    durationSeconds: timeline.totalFrames / fps,
    speech: spans,
    impacts: [0],
    whooshes: timeline.scenes.slice(1).map((s) => s.startFrame / fps),
    chimes,
    fadeOutAt: lastWord / fps + 0.4,
  };
}
