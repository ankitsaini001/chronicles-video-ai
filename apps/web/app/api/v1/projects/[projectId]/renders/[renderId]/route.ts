import { API_RATE_LIMITS } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { captionDeps, renderDetail } from "@/lib/video/captions";

// F2 GET /api/v1/projects/{projectId}/renders/{renderId} (docs/API.md F2, F25): one video
// (RenderSummary) with its caption phrases, read from the video's captions.json in R2. `renderId`
// may be `current`. Each phrase: { sceneId, phraseIndex (per scene, from 0), text, originalText,
// startMs, endMs, overridden }. Another user's video, a missing one and a malformed id → 404.
// Rate: the shared 300 reads per minute.

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; renderId: string }> }): Promise<Response> {
  const { projectId, renderId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.readsPerUser,
    handle: ({ db, user }) => renderDetail(captionDeps(db), user.id, projectId, renderId),
  })(request);
}
