import {
  assertCaptionsFixable,
  CAPTION_MESSAGES,
  findProjectRender,
  getOwnedProject,
  toRenderSummary,
  type CaptionOverrideItem,
  type CaptionOverridesBody,
  type ProjectDocument,
  type RenderDocument,
  type RenderSummaryResource,
} from "@bytereel/db";
import { CaptionTrackSchema, VIDEO_FORMAT, type CaptionTrack } from "@bytereel/pipeline/contracts";
import { captionFixProblem, indexCaptions } from "@bytereel/pipeline/timing";
import { isStorageKey } from "@bytereel/storage";
import type { Db } from "mongodb";
import { ApiProblem } from "../api/v1";
import { storageFromEnv } from "./storage";
import { VIDEO_MESSAGES, videoMediaDeps } from "./media";

// ③ Video, caption fixes (F25, docs/API.md F2 and F4), kept free of Next.js and of the real
// database (`CaptionDeps`) so the tests run them with fakes; the route files wire the real ones.
// - F2: one video with its caption phrases, read from the video's captions.json in R2 (owner check
//   first: another user's video, a missing one and a malformed id are all 404).
// - F4 (before its transaction, packages/db/src/caption-fixes.ts saveCaptionFixes): the owner's video,
//   the state checks, then every fix against THAT video's captions: the phrase exists, and the text
//   fits on screen with the compiler's own line breaking (at most 2 lines at the normal size, and
//   inside the caption box as the renderer draws it). A fix that doesn't fit is refused here, so it
//   can never fail later in the render or run into the Reels buttons.

/** API.md §11.3 `CaptionPhrase`. */
export type CaptionPhrase = { sceneId: string; phraseIndex: number; text: string; originalText: string; startMs: number; endMs: number; overridden: boolean };
/** API.md §11.3 `Render` = RenderSummary + its caption phrases. */
export type RenderDetailResource = RenderSummaryResource & { captions: CaptionPhrase[] };

export interface CaptionDeps {
  findProject(userId: string, projectId: string): Promise<ProjectDocument | null>;
  /** One video of this project (`renderId` may be "current"), or null. */
  findRender(project: ProjectDocument, renderId: string): Promise<RenderDocument | null>;
  /** The video's captions.json from R2 (throws when it can't be read). */
  readCaptions(key: string): Promise<CaptionTrack>;
  /** A 15-minute thumbnail link, or null. */
  thumbnailUrl(key: string): Promise<string | null>;
}

export function captionDeps(db: Db): CaptionDeps {
  const media = videoMediaDeps(db);
  return {
    findProject: (userId, projectId) => getOwnedProject(db, userId, projectId),
    findRender: (project, renderId) => findProjectRender(db, project, renderId),
    readCaptions: async (key) => {
      const setup = storageFromEnv();
      if (!setup.ok) throw new Error(`File storage (R2) is not set up: ${setup.problem}`);
      if (!isStorageKey(key)) throw new Error("A stored captions file key is not a valid storage key.");
      const bytes = await setup.store.get(key);
      if (!bytes) throw new Error("This video's captions file is missing from storage.");
      return CaptionTrackSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    },
    thumbnailUrl: (key) => media.presign(key).then((link) => link.url, () => null),
  };
}

const msOf = (frame: number) => Math.round((frame * 1000) / VIDEO_FORMAT.fps);

/** Pure: captions.json → the phrases the Captions tab lists (with each fix's compiled text). */
export function captionPhrasesOf(track: Pick<CaptionTrack, "captions">): CaptionPhrase[] {
  return indexCaptions(track).map(({ caption, sceneId, phraseIndex }) => ({
    sceneId,
    phraseIndex,
    text: caption.text,
    originalText: caption.originalText ?? caption.text,
    startMs: msOf(caption.startFrame),
    endMs: msOf(caption.endFrame),
    overridden: caption.originalText !== undefined && caption.originalText !== caption.text,
  }));
}

async function ownedRender(deps: CaptionDeps, userId: string, projectId: string, renderId: string): Promise<{ project: ProjectDocument; render: RenderDocument }> {
  const project = await deps.findProject(userId, projectId);
  if (!project) throw new ApiProblem(404, "NOT_FOUND", VIDEO_MESSAGES.PROJECT_NOT_FOUND);
  const render = await deps.findRender(project, renderId);
  if (!render) throw new ApiProblem(404, "NOT_FOUND", VIDEO_MESSAGES.VIDEO_NOT_FOUND, renderId === "current" && !project.currentRenderId ? { reason: "no_video_yet" } : undefined);
  return { project, render };
}

// ---------- F2 GET /api/v1/projects/{projectId}/renders/{renderId} ----------

/** F2: the video (RenderSummary) with its caption phrases (`[]` until it is ready). */
export async function renderDetail(deps: CaptionDeps, userId: string, projectId: string, renderId: string): Promise<RenderDetailResource> {
  const { project, render } = await ownedRender(deps, userId, projectId, renderId);
  const ready = render.status === "ready";
  const [track, thumbnailUrl] = await Promise.all([ready ? deps.readCaptions(render.captionsKey) : null, ready ? deps.thumbnailUrl(render.thumbnailKey) : null]);
  return { ...toRenderSummary(render, project, thumbnailUrl), captions: track ? captionPhrasesOf(track) : [] };
}

// ---------- F4 POST /api/v1/projects/{projectId}/renders/{renderId}/caption-overrides ----------

/**
 * F4's checks before its transaction: the owner's project and video (404), the state (409; 422 for a
 * switched-off language), then every fix against the video's captions (400: an unknown phrase, or a
 * text too long to fit on screen; each with its path). Returns the fixes with each phrase's
 * compiled text, for saveCaptionFixes.
 */
export async function checkCaptionFixes(deps: CaptionDeps, userId: string, projectId: string, renderId: string, body: CaptionOverridesBody): Promise<{ project: ProjectDocument; render: RenderDocument; edits: CaptionOverrideItem[] }> {
  const { project, render } = await ownedRender(deps, userId, projectId, renderId);
  // A refusal here is a ProjectActionError (the route maps it to its API error).
  assertCaptionsFixable(project, render, body.expectedStateVersion);
  const indexed = indexCaptions(await deps.readCaptions(render.captionsKey));
  const issues: { path: string; message: string }[] = [];
  const edits: CaptionOverrideItem[] = [];
  body.edits.forEach((edit, i) => {
    const found = indexed.find((c) => c.sceneId === edit.sceneId && c.phraseIndex === edit.phraseIndex);
    if (!found) {
      const count = indexed.filter((c) => c.sceneId === edit.sceneId).length;
      issues.push({
        path: `edits[${i}].phraseIndex`,
        message: count === 0 ? `this video has no scene "${edit.sceneId}"` : `scene "${edit.sceneId}" has phrases 0-${count - 1}; ${edit.phraseIndex} does not exist`,
      });
      return;
    }
    if (captionFixProblem(found.caption, edit.text)) {
      issues.push({ path: `edits[${i}].text`, message: CAPTION_MESSAGES.TOO_LONG });
      return;
    }
    edits.push({ sceneId: edit.sceneId, phraseIndex: edit.phraseIndex, text: edit.text, originalText: found.caption.originalText ?? found.caption.text });
  });
  if (issues.length > 0) {
    const allTooLong = issues.every((issue) => issue.message === CAPTION_MESSAGES.TOO_LONG);
    throw new ApiProblem(400, "INVALID_INPUT", allTooLong ? CAPTION_MESSAGES.TOO_LONG : "Please check the highlighted captions.", { issues });
  }
  return { project, render, edits };
}
