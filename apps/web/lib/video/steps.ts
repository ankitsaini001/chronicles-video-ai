// What the ③ "Making your video" screen shows (F23; Stitch "Step 3 Making video"; API.md §8.2 "UI
// step mapping"). Plain functions (no React, no database), shared by the page (server) and the
// screen (browser), so both show the same thing.
//   approve + speech → Recording narration
//   compile          → Timing animations, then Adding captions (the progress message says which)
//   render + validate → Rendering (with the percent while it renders)

export type VideoStepStatus = "done" | "active" | "todo" | "failed";
export type VideoStep = { label: string; status: VideoStepStatus; detail: string | null };

export const VIDEO_STEP_LABELS = ["Recording narration", "Timing animations", "Adding captions", "Rendering"] as const;

type StageLike = { name: string; status: string };
export type JobLike = { state: string; stages: StageLike[]; progress: { stage: string; percent: number; message: string } };

const CAPTIONS_MESSAGE = "Adding captions…";

function status(stages: StageLike[], name: string): string {
  return stages.find((s) => s.name === name)?.status ?? "pending";
}

/** The four steps for a video job (null = not started: all to do). */
export function videoSteps(job: JobLike | null): VideoStep[] {
  const steps: VideoStep[] = VIDEO_STEP_LABELS.map((label) => ({ label, status: "todo", detail: null }));
  if (!job || job.state === "queued") return steps;
  if (job.state === "succeeded") return steps.map((s) => ({ ...s, status: "done" }));
  const st = (name: string) => status(job.stages, name);
  const mark = (index: number, value: VideoStepStatus, detail: string | null = null) => {
    steps[index] = { ...steps[index]!, status: value, detail };
  };
  const failed = (name: string) => st(name) === "failed";

  // 1. Recording narration
  if (st("speech") === "succeeded") mark(0, "done");
  else if (failed("approve") || failed("speech")) mark(0, "failed");
  else if (st("approve") === "running" || st("speech") === "running" || st("approve") === "succeeded") mark(0, job.state === "running" ? "active" : "todo");

  // 2 + 3. Timing animations, Adding captions
  const compile = st("compile");
  if (compile === "succeeded") {
    mark(1, "done");
    mark(2, "done");
  } else if (compile === "failed") {
    mark(1, job.progress.message === CAPTIONS_MESSAGE ? "done" : "failed");
    mark(2, job.progress.message === CAPTIONS_MESSAGE ? "failed" : "todo");
  } else if (compile === "running" && job.state === "running") {
    if (job.progress.message === CAPTIONS_MESSAGE) {
      mark(1, "done");
      mark(2, "active");
    } else mark(1, "active");
  }

  // 4. Rendering (+ checking the file)
  const render = st("render");
  const validate = st("validate");
  if (render === "succeeded" && validate === "succeeded") mark(3, "done");
  else if (render === "failed" || validate === "failed") mark(3, "failed");
  else if ((render === "running" || validate === "running") && job.state === "running") {
    mark(3, "active", job.progress.stage === "render" || job.progress.stage === "validate" ? job.progress.message : null);
  }
  return steps;
}

/** F25: the two steps of a caption fix (a re-render with the same narration). */
export const CAPTION_STEP_LABELS = ["Updating captions", "Rendering"] as const;

/**
 * The two steps for a caption job (null = not started: all to do):
 *   compile          → Updating captions
 *   render + validate → Rendering (with the percent while it renders)
 */
export function captionSteps(job: JobLike | null): VideoStep[] {
  const steps: VideoStep[] = CAPTION_STEP_LABELS.map((label) => ({ label, status: "todo", detail: null }));
  if (!job || job.state === "queued") return steps;
  if (job.state === "succeeded") return steps.map((s) => ({ ...s, status: "done" }));
  const st = (name: string) => status(job.stages, name);
  const compile = st("compile");
  if (compile === "succeeded") steps[0] = { ...steps[0]!, status: "done" };
  else if (compile === "failed") steps[0] = { ...steps[0]!, status: "failed" };
  else if (compile === "running" && job.state === "running") steps[0] = { ...steps[0]!, status: "active" };
  const render = st("render");
  const validate = st("validate");
  if (render === "succeeded" && validate === "succeeded") steps[1] = { ...steps[1]!, status: "done" };
  else if (render === "failed" || validate === "failed") steps[1] = { ...steps[1]!, status: "failed" };
  else if ((render === "running" || validate === "running") && job.state === "running") {
    steps[1] = { ...steps[1]!, status: "active", detail: job.progress.stage === "render" || job.progress.stage === "validate" ? job.progress.message : null };
  }
  return steps;
}

/** "Waiting to start…" with how many videos are before this one (only one video is made at a time). */
export function waitingText(ahead: number | null | undefined): string {
  if (!ahead) return "Waiting to start…";
  return `Waiting to start… ${ahead} ${ahead === 1 ? "video is" : "videos are"} being made before yours.`;
}
