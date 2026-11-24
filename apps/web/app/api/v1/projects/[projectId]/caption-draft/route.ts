import { API_RATE_LIMITS, CaptionDraftBodySchema, getOwnedProject, saveCaptionDraft, toCaptionDraftResource } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { runCaptionDraftSave } from "@/lib/post-caption/handler";
import { publishableRender } from "@/lib/post-caption/server";

// H7 PUT /api/v1/projects/{projectId}/caption-draft (docs/API.md H7, F29): saves the creator's caption
// as typed on Step 4 (autosave ~1.5 s after the last key, and when the box loses focus), so it survives
// a reload or another device. Body { text } (0–2,200 characters after cleaning; hashtags included).
// Owner only (another user's project, a missing one, a bad id → 404); only while the video can be
// published from Step 4 (else 409 INVALID_STATE). Saves `captionDraft` with source "edited"; the
// project's stateVersion and updatedAt are not changed. Rate: 60 a minute (its own counter).
// No Idempotency-Key: saving the same text twice is harmless.

export async function PUT(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const { projectId } = await params;
  return apiRoute({
    rateLimit: API_RATE_LIMITS.captionDraftPerUser,
    body: CaptionDraftBodySchema,
    handle: async ({ db, user, body }) => {
      const project = await getOwnedProject(db, user.id, projectId);
      return runCaptionDraftSave(
        { body },
        {
          load: async () => (project ? { videoReady: (await publishableRender(db, project)) !== null } : null),
          save: async (text) => {
            const draft = project ? await saveCaptionDraft(db, { ownerId: user.id, projectId: project._id, text, source: "edited" }) : null;
            return draft ? toCaptionDraftResource(draft) : null;
          },
        },
      );
    },
  })(request);
}
