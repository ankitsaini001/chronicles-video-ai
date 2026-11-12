import { RenderInternals } from "@remotion/renderer";
import { z } from "zod";
import type { Timeline } from "../contracts";
import { MAX_TOTAL_FRAMES, MIN_TOTAL_FRAMES } from "../timing/frames";

/**
 * MP4 validation (PIPELINE_DESIGN.md §8 "Validate" stage): probe the actual encoded file, never
 * assume. Uses the ffprobe binary that ships with Remotion (@remotion/compositor-*), counting
 * decoded frames. Writes qa.json; invalid output can never be marked ready-for-review.
 */

export interface Mp4Probe {
  codec: string | null;
  width: number | null;
  height: number | null;
  /** Exact frame rate as a fraction, e.g. "30/1". */
  frameRate: string | null;
  /** Frames counted by decoding the stream. */
  decodedFrames: number | null;
  durationSeconds: number | null;
  pixelFormat: string | null;
  audioStreams: number;
  audioCodec: string | null;
  audioDurationSeconds: number | null;
  audioSampleRate: number | null;
}

/** Audio track length may differ from the video by at most this much (AAC frames/priming). */
export const AUDIO_DURATION_TOLERANCE_SECONDS = 0.1;

export interface QaCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface QaReport {
  schemaVersion: 1;
  ok: boolean;
  file: string;
  sha256: string;
  bytes: number;
  timingSource: Timeline["timingSource"];
  /** Synthetic fixtures are never live results, even when every check passes. */
  liveResult: boolean;
  probedWith: string;
  measured: Mp4Probe;
  checks: QaCheck[];
}

const FfprobeOutput = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string().optional(),
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      r_frame_rate: z.string().optional(),
      avg_frame_rate: z.string().optional(),
      nb_read_frames: z.string().optional(),
      pix_fmt: z.string().optional(),
      duration: z.string().optional(),
      sample_rate: z.string().optional(),
    }),
  ),
  format: z.object({ duration: z.string().optional() }).optional(),
});

export const PROBED_WITH = "ffprobe bundled with @remotion/renderer (decoded frame count)";

export async function probeMp4(filePath: string): Promise<Mp4Probe> {
  const result = await RenderInternals.callFf({
    bin: "ffprobe",
    args: [
      "-v", "error",
      "-count_frames",
      "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,pix_fmt,duration,sample_rate:format=duration",
      "-of", "json",
      filePath,
    ],
    indent: false,
    logLevel: "error",
    binariesDirectory: null,
    cancelSignal: undefined,
  });
  return parseFfprobe(result.stdout);
}

export function parseFfprobe(stdout: string): Mp4Probe {
  const parsed = FfprobeOutput.parse(JSON.parse(stdout));
  const video = parsed.streams.find((s) => s.codec_type === "video");
  const audio = parsed.streams.find((s) => s.codec_type === "audio");
  const num = (value: string | undefined) => (value === undefined || value === "N/A" ? null : Number(value));
  return {
    codec: video?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    frameRate: video?.r_frame_rate ?? null,
    decodedFrames: num(video?.nb_read_frames),
    durationSeconds: num(video?.duration) ?? num(parsed.format?.duration),
    pixelFormat: video?.pix_fmt ?? null,
    audioStreams: parsed.streams.filter((s) => s.codec_type === "audio").length,
    audioCodec: audio?.codec_name ?? null,
    audioDurationSeconds: num(audio?.duration),
    audioSampleRate: num(audio?.sample_rate),
  };
}

/** Compare a probe with the compiled timeline. Pure, so it is unit-tested without a video. */
export function evaluateProbe(probe: Mp4Probe, timeline: Timeline): QaCheck[] {
  const fps = timeline.fps;
  const expectedSeconds = timeline.totalFrames / fps;
  const check = (name: string, ok: boolean, expected: string, actual: unknown): QaCheck => ({ name, ok, expected, actual: String(actual) });
  const silent = timeline.timingSource === "synthetic-silent-fixture";
  const checks: QaCheck[] = [
    check("codec", probe.codec === "h264", "h264", probe.codec),
    check("resolution", probe.width === timeline.width && probe.height === timeline.height, `${timeline.width}x${timeline.height}`, `${probe.width}x${probe.height}`),
    check("frame rate", probe.frameRate === `${fps}/1`, `${fps}/1`, probe.frameRate),
    check("frame count", probe.decodedFrames === timeline.totalFrames, String(timeline.totalFrames), probe.decodedFrames),
    check(
      "duration matches timeline (±1 frame)",
      probe.durationSeconds !== null && Math.abs(probe.durationSeconds - expectedSeconds) <= 1 / fps + 1e-6,
      `${expectedSeconds.toFixed(3)} s`,
      probe.durationSeconds === null ? null : `${probe.durationSeconds.toFixed(3)} s`,
    ),
    check(
      "duration within 60-90 s",
      probe.decodedFrames !== null && probe.decodedFrames >= MIN_TOTAL_FRAMES && probe.decodedFrames <= MAX_TOTAL_FRAMES,
      `${MIN_TOTAL_FRAMES}-${MAX_TOTAL_FRAMES} frames`,
      probe.decodedFrames,
    ),
    check("pixel format", probe.pixelFormat === "yuv420p", "yuv420p", probe.pixelFormat),
  ];
  if (silent) {
    checks.push(check("audio (silent fixture has none)", probe.audioStreams === 0, "0 audio streams", probe.audioStreams));
    return checks;
  }
  const videoSeconds = probe.durationSeconds;
  const audioSeconds = probe.audioDurationSeconds;
  checks.push(
    check("audio present", probe.audioStreams === 1, "1 audio stream", probe.audioStreams),
    check("audio codec", probe.audioCodec === "aac", "aac", probe.audioCodec),
    check(
      `audio duration matches video (±${AUDIO_DURATION_TOLERANCE_SECONDS} s)`,
      audioSeconds !== null && videoSeconds !== null && Math.abs(audioSeconds - videoSeconds) <= AUDIO_DURATION_TOLERANCE_SECONDS,
      videoSeconds === null ? "video duration" : `${videoSeconds.toFixed(3)} s`,
      audioSeconds === null ? null : `${audioSeconds.toFixed(3)} s`,
    ),
  );
  return checks;
}
