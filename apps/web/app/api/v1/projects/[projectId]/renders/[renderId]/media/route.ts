import { API_RATE_LIMITS } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { renderMedia, videoMediaDeps } from "@/lib/video/media";

// F3 GET /api/v1/projects/{projectId}/renders/{renderId}/media (docs/API.md F3, F24): a 15-minute
// private R2 link to one video, made only after the owner check. `renderId` may be `current`.
// Query: `kind` = video (inline, for the player) | download (attachment named after the title) |
// thumbnail; `redirect=true` → 302 to the link (the Download MP4 button is a plain link).
// Not ready → 409 INVALID_STATE; another user's or a missing video → 404. Links are never logged.
// Rate: the shared 300 reads per minute.

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; renderId: string }> }): Promise<Response> {
  const { projectId, renderId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.readsPerUser,
    handle: ({ db, user }) => renderMedia(videoMediaDeps(db), user.id, projectId, renderId, new URL(request.url)),
  })(request);
}
