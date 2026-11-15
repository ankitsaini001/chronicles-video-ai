import type { Plan } from "../contracts";
import type { SpeechCacheRecord } from "../storage/speech-cache";
import type { QaReport } from "../validation/mp4";
import type { SpeechConfig } from "./speech";

/**
 * The messages between the web app's generate worker and the render child process (F23).
 * Types only (no Remotion import), so the web app can use them without loading the renderer.
 *
 * Why a child process: rendering needs Remotion's bundler, Chrome and ffmpeg. Running them in their
 * own Node process keeps them out of the Next.js server bundle, lets the worker give them a project
 * temp folder (TMPDIR) explicitly, and makes Cancel simple (a "cancel" message → Remotion's cancel
 * signal). The child works only on local files in `workDir`; the worker downloads the narration
 * before and uploads the results to R2 after.
 */

export interface RenderSceneInput {
  sceneId: string;
  /** Absolute path of the scene's narration MP3 (downloaded by the worker, SHA-256 checked). */
  audioFile: string;
  /** The recording's request, alignments and costs (alignment.json in R2). */
  record: SpeechCacheRecord;
}

export interface RenderJobSpec {
  /** This render attempt's own folder inside the project (runs/.tmp/generate/<renderId>). */
  workDir: string;
  plan: Plan;
  planHash: string;
  speechConfig: SpeechConfig;
  scenes: RenderSceneInput[];
  /** Add the code-generated music bed (BACKGROUND_MUSIC). */
  music: boolean;
  /** The thumbnail frame, in seconds from the start (the hook: title or picture on screen). */
  thumbnailSeconds: number;
}

/** Where the render is: Timing animations → Adding captions → Rendering → Checking. */
export type RenderPhase = "timing" | "captions" | "rendering" | "checking";

export interface RenderedFiles {
  video: string;
  thumbnail: string;
  timeline: string;
  captions: string;
  qa: string;
}

export type RenderJobResult =
  | {
      status: "ready";
      files: RenderedFiles;
      qa: QaReport;
      durationMs: number;
      frames: number;
      renderMs: number;
      bundleMs: number;
    }
  | { status: "needs_input"; reason: "duration_out_of_range" | "alignment_uncertain"; message: string; sceneId: string | null; detail: string }
  | { status: "failed"; stage: "compile" | "render" | "validate"; detail: string }
  | { status: "cancelled" };

/** Worker → child. */
export type RenderParentMessage = { type: "start"; spec: RenderJobSpec } | { type: "cancel" };

/** Child → worker. */
export type RenderChildMessage = { type: "progress"; phase: RenderPhase; percent: number } | { type: "result"; result: RenderJobResult };

/** The thumbnail: 1.5 s in, when the hook's question or picture is on screen (F23). */
export const THUMBNAIL_SECONDS = 1.5;
