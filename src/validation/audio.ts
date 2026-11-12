import { RenderInternals } from "@remotion/renderer";
import { z } from "zod";

/**
 * Probe a narration MP3 by decoding it (PIPELINE_DESIGN.md §6: scene length comes from the actual
 * audio duration, never from the last caption character). Uses Remotion's bundled ffprobe.
 */

export interface AudioProbe {
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  /** Duration from the decoded stream (decoded MP3 frames × samples per frame / sample rate) when available. */
  decodedSeconds: number;
}

const ProbeOutput = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string().optional(),
      codec_name: z.string().optional(),
      sample_rate: z.string().optional(),
      channels: z.number().optional(),
      nb_read_frames: z.string().optional(),
      duration: z.string().optional(),
    }),
  ),
  format: z.object({ duration: z.string().optional() }).optional(),
});

export class AudioProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioProbeError";
  }
}

export async function probeAudioFile(filePath: string): Promise<AudioProbe> {
  const result = await RenderInternals.callFf({
    bin: "ffprobe",
    args: [
      "-v", "error",
      "-count_frames",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,nb_read_frames,duration:format=duration",
      "-of", "json",
      filePath,
    ],
    indent: false,
    logLevel: "error",
    binariesDirectory: null,
    cancelSignal: undefined,
  });
  return parseAudioProbe(result.stdout);
}

/** Samples per MP3 (MPEG-1 Layer III) frame. */
const MP3_SAMPLES_PER_FRAME = 1152;

export function parseAudioProbe(stdout: string): AudioProbe {
  const parsed = ProbeOutput.parse(JSON.parse(stdout));
  const stream = parsed.streams.find((s) => s.codec_type === "audio");
  if (!stream) throw new AudioProbeError("the file has no audio stream (corrupt or not audio)");
  const num = (v: string | undefined) => (v === undefined || v === "N/A" ? null : Number(v));
  const sampleRate = num(stream.sample_rate);
  const frames = num(stream.nb_read_frames);
  const decoded =
    stream.codec_name === "mp3" && frames && sampleRate && sampleRate >= 32_000
      ? (frames * MP3_SAMPLES_PER_FRAME) / sampleRate
      : (num(stream.duration) ?? num(parsed.format?.duration));
  if (decoded === null || !Number.isFinite(decoded) || decoded <= 0) {
    throw new AudioProbeError("could not decode a positive audio duration (corrupt or empty audio)");
  }
  return { codec: stream.codec_name ?? null, sampleRate, channels: stream.channels ?? null, decodedSeconds: Math.round(decoded * 10_000) / 10_000 };
}
