// "Ask for changes" (F18 on the storyboard, F26 on the video page): what differs between the two
// places, as plain functions (no React, safe for the browser). The panel itself is
// components/storyboard/ChangesPanel.tsx.
// - On the storyboard (`stage: storyboard`) a finished change reloads the page (the new version with
//   its "Changed" tags).
// - On the video page (`stage: video`) a change that made a new version opens the storyboard, where
//   the changed scenes are tagged and the new version is approved ("Approve & make new video"). An
//   unclear request (no new version) or a failed one stays on the video page with the reply.

export type ChangeStage = "storyboard" | "video";

/** The first choice of the scope menu. */
export function wholeLabel(stage: ChangeStage): string {
  return stage === "video" ? "Whole video" : "Whole storyboard";
}

/** The request box's example. */
export function changePlaceholder(stage: ChangeStage): string {
  return stage === "video" ? "e.g. make the ending punchier, or scene 3: say it more simply" : "e.g. make it shorter, or scene 3: show this as a comparison";
}

/** D5 body. `scope` is the menu's value: "project" or a scene id. */
export function revisionBody(input: { stage: ChangeStage; scope: string; message: string; baseVersionId: string; stateVersion: number }) {
  const whole = input.scope === "project";
  return {
    stage: input.stage,
    scope: whole ? ("project" as const) : ("scene" as const),
    ...(whole ? {} : { sceneId: input.scope }),
    message: input.message,
    basePlanVersionId: input.baseVersionId,
    expectedStateVersion: input.stateVersion,
  };
}

/** D6 history of this place: only its own stage. */
export function historyUrl(projectId: string, stage: ChangeStage): string {
  return `/api/v1/projects/${projectId}/revisions?stage=${stage}`;
}

/** The job (E1) as the panel reads it when the change ended. */
export type EndedChange = { state: string; error: { message: string } | null; needsInput: { message: string } | null };

/** What the page does when the change ended: open the storyboard (a new version from the video page) or reload here. */
export function afterChange(stage: ChangeStage, job: Pick<EndedChange, "state"> | null): "open_storyboard" | "reload" {
  return stage === "video" && job?.state === "succeeded" ? "open_storyboard" : "reload";
}

/** The status line read out when the change ended. */
export function changeEndedMessage(stage: ChangeStage, job: EndedChange): string {
  if (job.state === "succeeded") return stage === "video" ? "Your storyboard is updated. Review the changes, then make your new video." : "Your storyboard is updated.";
  if (job.state === "needs_input") return job.needsInput?.message ?? "Nothing was changed.";
  return job.error?.message ?? "The change couldn't be made.";
}

/** The note under the progress line while a change runs. */
export function runningNote(stage: ChangeStage): string {
  return stage === "video"
    ? "This usually takes about a minute. Your video stays as it is; you can watch and download it meanwhile."
    : "This usually takes about a minute. You can leave this page; the change keeps going.";
}
