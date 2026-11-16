import {
  findProjectRender,
  getOwnedProject,
  InvalidCursorError,
  listProjectRenders,
  toRenderSummary,
  type ProjectDocument,
  type RenderDocument,
  type RenderSummaryResource,
} from "@bytereel/db";
import { isStorageKey, removeInvisible, StorageError } from "@bytereel/storage";
import type { Db } from "mongodb";
import { ApiProblem } from "../api/v1";
import { pageQuery } from "../storyboard/api";
import { storageFromEnv } from "./storage";

// ③ Video (F24, docs/API.md §14.6): F1 the project's video versions and F3 a private link to one
// video's MP4 or thumbnail. Kept free of Next.js and of the real database (`VideoMediaDeps`) so the
// tests run them with fakes; the route files only wire the real ones.
//
// Rules: the owner check comes first (another user's project or video, a missing one and a malformed
// id are all 404, never 403); only then is a presigned R2 link made (15 minutes, ARCHITECTURE §9).
// A presigned link contains the token's key id: it is returned to the owner and NEVER logged.

export const MEDIA_KINDS = ["video", "download", "thumbnail"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const VIDEO_MESSAGES = {
  PROJECT_NOT_FOUND: "We couldn't find this project.",
  VIDEO_NOT_FOUND: "We couldn't find this video.",
  NOT_READY: "This video is still being made.",
  FAILED: "This video wasn't finished.",
} as const;

export interface VideoMediaDeps {
  /** The signed-in user's own project, or null (also for a malformed id). */
  findProject(userId: string, projectId: string): Promise<ProjectDocument | null>;
  listRenders(project: ProjectDocument, page: { limit: number; cursor: string | null }): Promise<{ items: RenderDocument[]; nextCursor: string | null }>;
  /** One video of this project (`renderId` may be "current"), or null. */
  findRender(project: ProjectDocument, renderId: string): Promise<RenderDocument | null>;
  /** A 15-minute private GET link. With `downloadFilename` the browser downloads instead of playing. */
  presign(key: string, options?: { downloadFilename?: string }): Promise<{ url: string; expiresAt: Date }>;
}

/** The real dependencies: MongoDB (owner-scoped queries) and the private R2 bucket. */
export function videoMediaDeps(db: Db): VideoMediaDeps {
  return {
    findProject: (userId, projectId) => getOwnedProject(db, userId, projectId),
    listRenders: (project, page) => listProjectRenders(db, project, page),
    findRender: (project, renderId) => findProjectRender(db, project, renderId),
    presign: async (key, options = {}) => {
      const setup = storageFromEnv();
      if (!setup.ok) throw new MediaLinkError(`File storage (R2) is not set up: ${setup.problem}`);
      if (!isStorageKey(key)) throw new MediaLinkError("A stored video file key is not a valid storage key.");
      return setup.store.presignedGet(key, options.downloadFilename !== undefined ? { downloadFilename: options.downloadFilename } : {});
    },
  };
}

/** A plain reason why a link couldn't be made (safe to log: no link, no key id). */
export class MediaLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaLinkError";
  }
}

/**
 * Makes the link; a failure is passed on (to the 500 log line) with a plain reason only: our own
 * MediaLinkError, a StorageError (plain and redacted, F22), or "unknown storage error". Any other
 * error text could contain a signed address, so it is never passed on.
 */
async function presignSafely(deps: VideoMediaDeps, key: string, options?: { downloadFilename?: string }): Promise<{ url: string; expiresAt: Date }> {
  try {
    return await deps.presign(key, options);
  } catch (error) {
    const reason = error instanceof MediaLinkError || error instanceof StorageError ? error.message : "unknown storage error";
    throw new MediaLinkError(`Could not make a private video link: ${reason}`);
  }
}

// ---------- F1 GET /api/v1/projects/{projectId}/renders ----------

/** F1: the project's videos, newest first, each with a 15-minute thumbnail link. */
export async function listRenderSummaries(deps: VideoMediaDeps, userId: string, projectId: string, url: URL): Promise<{ items: RenderSummaryResource[]; nextCursor: string | null }> {
  const page = pageQuery(url);
  const project = await deps.findProject(userId, projectId);
  if (!project) throw new ApiProblem(404, "NOT_FOUND", VIDEO_MESSAGES.PROJECT_NOT_FOUND);
  let listed: { items: RenderDocument[]; nextCursor: string | null };
  try {
    listed = await deps.listRenders(project, page);
  } catch (error) {
    if (error instanceof InvalidCursorError) throw new ApiProblem(400, "INVALID_INPUT", error.message, { issues: [{ path: "cursor", message: "invalid cursor" }] });
    throw error;
  }
  const items = await Promise.all(
    listed.items.map(async (render) => {
      // A missing thumbnail link never hides the video from the list.
      const thumbnailUrl = render.status === "ready" ? await presignSafely(deps, render.thumbnailKey).then((link) => link.url, () => null) : null;
      return toRenderSummary(render, project, thumbnailUrl);
    }),
  );
  return { items, nextCursor: listed.nextCursor };
}

// ---------- F3 GET /api/v1/projects/{projectId}/renders/{renderId}/media ----------

/** F3 query: `kind` (required) and `redirect` ("true" / "false", default false), each at most once. */
export function mediaQuery(url: URL): { kind: MediaKind; redirect: boolean } {
  const issues: { path: string; message: string }[] = [];
  for (const name of ["kind", "redirect"]) if (url.searchParams.getAll(name).length > 1) issues.push({ path: name, message: "must be given once" });
  const kind = url.searchParams.get("kind");
  if (!MEDIA_KINDS.includes(kind as MediaKind)) issues.push({ path: "kind", message: `must be one of ${MEDIA_KINDS.join(", ")}` });
  const redirect = url.searchParams.get("redirect");
  if (redirect !== null && redirect !== "true" && redirect !== "false") issues.push({ path: "redirect", message: "must be true or false" });
  if (issues.length) throw new ApiProblem(400, "INVALID_INPUT", "Please reload the page and try again.", { issues });
  return { kind: kind as MediaKind, redirect: redirect === "true" };
}

/**
 * F3: a private link to the video (inline, for the player), the MP4 as a download named after the
 * project title, or the thumbnail. `renderId` may be "current". Not ready → 409 INVALID_STATE.
 * `redirect=true` → 302 to the link (for a plain <a href> download). Returns a JSON value or a Response.
 */
export async function renderMedia(deps: VideoMediaDeps, userId: string, projectId: string, renderId: string, url: URL): Promise<{ kind: MediaKind; url: string; expiresAt: string } | Response> {
  const query = mediaQuery(url);
  const project = await deps.findProject(userId, projectId);
  if (!project) throw new ApiProblem(404, "NOT_FOUND", VIDEO_MESSAGES.PROJECT_NOT_FOUND);
  const render = await deps.findRender(project, renderId);
  if (!render) throw new ApiProblem(404, "NOT_FOUND", VIDEO_MESSAGES.VIDEO_NOT_FOUND, renderId === "current" && !project.currentRenderId ? { reason: "no_video_yet" } : undefined);
  if (render.status !== "ready") {
    throw new ApiProblem(409, "INVALID_STATE", render.status === "failed" ? VIDEO_MESSAGES.FAILED : VIDEO_MESSAGES.NOT_READY, { renderStatus: render.status });
  }
  const link =
    query.kind === "thumbnail"
      ? await presignSafely(deps, render.thumbnailKey)
      : await presignSafely(deps, render.mp4Key, query.kind === "download" ? { downloadFilename: downloadFilename(project.title) } : {});
  if (query.redirect) return new Response(null, { status: 302, headers: { Location: link.url } });
  return { kind: query.kind, url: link.url, expiresAt: link.expiresAt.toISOString() };
}

// ---------- The download's file name ----------

const MAX_NAME_CHARS = 80;
const FALLBACK_NAME = "video";

/** A lone surrogate becomes U+FFFD (String.prototype.toWellFormed, not in our TypeScript lib yet). */
function toWellFormed(value: string): string {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/**
 * The downloaded MP4's name, from the project title: control and invisible characters out (bidi
 * controls too; the joiners ZWJ/ZWNJ stay only between two visible characters, for emoji sequences
 * and Devanagari half-forms: removeInvisible), double quotes and backticks out, slashes and
 * backslashes become "-", the characters Windows refuses in names (: * ? < > |) become a space;
 * spaces, apostrophes, accents, Hindi and emoji stay. No leading dots or dashes (no hidden files,
 * no "../"), at most 80 characters, always ending in ".mp4" ("video.mp4" when nothing is left).
 * The storage layer adds the ASCII fallback + UTF-8 `filename*` header.
 */
export function downloadFilename(title: string): string {
  let name = removeInvisible(toWellFormed(title).normalize("NFC"))
    .replace(/["`\u201C\u201D]/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/[:*?<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(\.mp4)+$/i, "");
  name = [...name].slice(0, MAX_NAME_CHARS).join("");
  // Tidy both ends until nothing changes (trimming can leave a joiner at an end, and the other way round).
  for (let before = ""; before !== name; ) {
    before = name;
    name = removeInvisible(name).replace(/^[\s.-]+/, "").replace(/[\s.]+$/, "");
  }
  return `${name || FALLBACK_NAME}.mp4`;
}
