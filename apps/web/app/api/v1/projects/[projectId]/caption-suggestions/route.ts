import {
  API_RATE_LIMITS,
  CaptionSuggestionBodySchema,
  countCaptionRequest,
  finishProviderUsage,
  releaseCaptionSuggestion,
  reserveProviderUsage,
  saveAiCaptionDraft,
  toCaptionDraftResource,
} from "@bytereel/db";
import { ObjectId } from "mongodb";
import { apiRoute } from "@/lib/api/server";
import { runCaptionSuggestion } from "@/lib/post-caption/handler";
import { postCaptionProviderFromEnv } from "@/lib/post-caption/provider";
import { loadCaptionTarget } from "@/lib/post-caption/server";

// H1 POST /api/v1/projects/{projectId}/caption-suggestions (docs/API.md H1, F29): "✨ Suggest again" on
// Step 4 (and the page's automatic first suggestion, `onlyIfEmpty: true`). The approved storyboard → a
// short hook-first Instagram caption + 3–5 hashtags from Gemini, answered directly (synchronous, 30 s
// limit), saved as the project's `captionDraft` (source "ai") and returned with it.
// Pipeline (lib/api/v1.ts): Origin → session → 10 per hour per user → strict body → the work in
// lib/post-caption/handler.ts (checks, ONE atomic update that counts 1 of the project's 20 AI
// requests and takes the 60 s suggestion lease, Gemini, conditional save, lease released).
// No Idempotency-Key: it starts no job; the lease stops a second request while one runs.

/** Well above the 30 s limit, so the host never cuts the answer off. */
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.captionSuggestionsPerUser,
    body: CaptionSuggestionBodySchema,
    handle: ({ db, user, body, requestId }) => {
      // Used only after the owner check (load), so projectId is the user's 24-hex id there.
      const projectObjectId = () => new ObjectId(projectId);
      return runCaptionSuggestion(
        { body, requestId },
        {
          load: () => loadCaptionTarget(db, user.id, projectId),
          provider: () => postCaptionProviderFromEnv(process.env),
          countRequest: async (renderId, onlyIfEmpty) => {
            const counted = await countCaptionRequest(db, { ownerId: user.id, projectId: projectObjectId(), renderId: new ObjectId(renderId), onlyIfEmpty });
            return "draft" in counted ? { ok: false, reason: "draft_exists", draft: toCaptionDraftResource(counted.draft) } : counted;
          },
          saveDraft: async (text, onlyIfEmpty) => {
            const saved = await saveAiCaptionDraft(db, { ownerId: user.id, projectId: projectObjectId(), text, onlyIfEmpty });
            return saved ? { applied: saved.applied, draft: toCaptionDraftResource(saved.draft) } : null;
          },
          releaseLease: (leaseId) => releaseCaptionSuggestion(db, { ownerId: user.id, projectId: projectObjectId(), leaseId }),
          reserveUsage: (input) => reserveProviderUsage(db, { ...input, ownerId: user.id, projectId, provider: "gemini", operation: "caption" }),
          finishUsage: (handle, input) => finishProviderUsage(db, handle as ObjectId, input),
        },
      );
    },
  })(request);
}
