import type { NarrationCost } from "@bytereel/db";

// A new video of a changed storyboard (F26; plain functions, safe for the browser). The storyboard
// page shows what it will cost before the creator approves: which scenes get new narration (and
// about how many voice characters), and that the other scenes reuse their recording. The numbers
// come from the server (lib/video/narration-cost.ts, the same rule D8 checks the limits with).

/** The approve button: "Approve & make new video" when the project already has a video. */
export function approveLabel(hasVideo: boolean): string {
  return hasVideo ? "Approve & make new video" : "Approve & generate video";
}

const number = (value: number) => value.toLocaleString("en-IN");

/** "scene 3", "scenes 2 and 3", "scenes 1, 2 and 4" (scene numbers from 1). */
function scenesWord(indexes: readonly number[]): string {
  const n = indexes.map((i) => i + 1);
  if (n.length === 1) return `scene ${n[0]}`;
  return `scenes ${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** The note on the storyboard page before a new video is approved. */
export function newVideoNote(cost: NarrationCost, videosPerDay: number): string {
  const total = cost.newScenes.length + cost.reusedScenes.length;
  const counts = `It counts as 1 of your ${videosPerDay} videos today.`;
  if (cost.newScenes.length === 0) return `Your new video reuses the recorded narration of every scene: no voice characters needed. ${counts}`;
  const characters = `about ${number(cost.characters)} voice characters`;
  if (cost.reusedScenes.length === 0) return `Your new video records new narration for ${total === 1 ? "its scene" : `all ${total} scenes`} (${characters}). ${counts}`;
  const verb = cost.newScenes.length === 1 ? "gets" : "get";
  const others = cost.reusedScenes.length === 1 ? "The other scene reuses its recording." : `The other ${cost.reusedScenes.length} scenes reuse their recordings.`;
  return `In your new video, ${scenesWord(cost.newScenes)} ${verb} new narration (${characters}). ${others} ${counts}`;
}
