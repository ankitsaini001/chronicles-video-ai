import { API_RATE_LIMITS, CaptionSuggestionBodySchema, countCaptionRequest, finishProviderUsage, reserveProviderUsage, saveCaptionDraft, toCaptionDraftResource } from "@bytereel/db";
import { ObjectId } from "mongodb";
import { apiRoute } from "@/lib/api/server";
import { runCaptionSuggestion } from "@/lib/post-caption/handler";
import { postCaptionProviderFromEnv } from "@/lib/post-caption/provider";
import { loadCaptionTarget } from "@/lib/post-caption/server";

// H1 POST /api/v1/projects/{projectId}/caption-suggestions (docs/API.md H1, F29): "✨ Suggest again" on
// Step 4 (and the page's automatic first suggestion). The approved storyboard → a short hook-first
// Instagram caption + 3–5 hashtags from Gemini, answered directly (synchronous, 30 s limit), saved as
// the project's `captionDraft` (source "ai") and returned with it.
// Pipeline (lib/api/v1.ts): Origin → session → 10 per hour per user → strict body → the work in
// lib/post-caption/handler.ts (checks, 1 of the project's 20 AI requests, Gemini, save).
// No Idempotency-Key: it starts no job; a repeat is a new suggestion (and counts again).

/** Well above the 30 s limit, so the host never cuts the answer off. */
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.captionSuggestionsPerUser,
    body: CaptionSuggestionBodySchema,
    handle: ({ db, user, body, requestId }) =>
      runCaptionSuggestion(
        { body, requestId },
        {
          load: () => loadCaptionTarget(db, user.id, projectId),
          provider: () => postCaptionProviderFromEnv(process.env),
          // Reached only after the owner check (load), so projectId is the user's 24-hex id here.
          countRequest: (renderId) => countCaptionRequest(db, { ownerId: user.id, projectId: new ObjectId(projectId), renderId: new ObjectId(renderId) }),
          saveDraft: async (text) => {
            const draft = await saveCaptionDraft(db, { ownerId: user.id, projectId: new ObjectId(projectId), text, source: "ai" });
            return draft ? toCaptionDraftResource(draft) : null;
          },
          reserveUsage: (input) => reserveProviderUsage(db, { ...input, ownerId: user.id, projectId, provider: "gemini", operation: "caption" }),
          finishUsage: (handle, input) => finishProviderUsage(db, handle as ObjectId, input),
        },
      ),
  })(request);
}
