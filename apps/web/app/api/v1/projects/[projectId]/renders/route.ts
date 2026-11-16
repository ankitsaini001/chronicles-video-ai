import { API_RATE_LIMITS } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { listRenderSummaries, videoMediaDeps } from "@/lib/video/media";

// F1 GET /api/v1/projects/{projectId}/renders (docs/API.md F1, F24): the project's video versions for
// the "Video version N ▾" picker, newest first (`renderNumber` desc). Query: `limit` 1–50 (20),
// `cursor` (from `nextCursor`). Each item has `isCurrent` and a 15-minute thumbnail link, made only
// after the owner check. Owner only (404). Rate: the shared 300 reads per minute.

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.readsPerUser,
    handle: ({ db, user }) => listRenderSummaries(videoMediaDeps(db), user.id, projectId, new URL(request.url)),
  })(request);
}
