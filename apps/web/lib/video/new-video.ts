import type { NarrationCost } from "@bytereel/db";

// A new video of a changed storyboard (F26; plain functions, safe for the browser). The storyboard
// page shows what it will cost before the creator approves: which scenes get new narration (and
// about how many voice characters), and that the other scenes reuse their recording. The numbers
// come from the server (lib/video/narration-cost.ts, the same rule D8 checks the limits with).
// F27: the "counts as 1 of your 3 videos today" line only when approving starts a NEW video job (not
// when it queues a failed or cancelled job again, which doesn't count) and today still has one left;
// when a limit would refuse the video, the page shows that reason in its own note instead.

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

/** What the new video does to today's videos: "It counts as 1 of your 3 videos today (2 left)." (D8 enforces it.) */
export function videosTodayLine(today: { used: number; limit: number }): string {
  const left = Math.max(0, today.limit - today.used);
  // Not shown by the page (F27: at 0 left the limit's own note says why and when it resets).
  if (left === 0) return "You have no videos left today.";
  return `It counts as 1 of your ${today.limit} videos today (${left} left).`;
}

/**
 * The note on the storyboard page before a new video is approved. `today`: the creator's videos
 * today, when this approval counts one (F27: null = no "counts as 1 of your 3" line).
 */
export function newVideoNote(cost: NarrationCost, today: { used: number; limit: number } | null): string {
  const total = cost.newScenes.length + cost.reusedScenes.length;
  const counts = today ? ` ${videosTodayLine(today)}` : "";
  if (cost.newScenes.length === 0) return `Your new video reuses the recorded narration of every scene: no voice characters needed.${counts}`;
  const characters = `about ${number(cost.characters)} voice characters`;
  if (cost.reusedScenes.length === 0) return `Your new video records new narration for ${total === 1 ? "its scene" : `all ${total} scenes`} (${characters}).${counts}`;
  const verb = cost.newScenes.length === 1 ? "gets" : "get";
  const others = cost.reusedScenes.length === 1 ? "The other scene reuses its recording." : `The other ${cost.reusedScenes.length} scenes reuse their recordings.`;
  return `In your new video, ${scenesWord(cost.newScenes)} ${verb} new narration (${characters}). ${others}${counts}`;
}
