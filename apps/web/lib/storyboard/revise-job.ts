import { reviseProgressMessage, REVISE_MESSAGES, type PlanJobContext } from "@bytereel/db";
import type { Language, VoicePreset } from "@bytereel/pipeline/contracts";
import { buildRevisionPrompt } from "@bytereel/pipeline/planning";
import type { PlanJobMessages, PreparedRequest } from "../plan/run-plan-job";

// The revise job (Inngest `revise-plan`, F18): the SAME durable steps as the storyboard job
// (lib/plan/run-plan-job.ts: count each Gemini request first, save each answer at once, ONE repair,
// limits, fencing), with a different first message: the current storyboard plus the creator's
// change request, both as delimited data (packages/pipeline/src/planning/revision.ts).
// The language, voice and sources stay those of the base version (code-owned, never from the AI).

export function prepareRevisionRequest({ job, project, base, revision }: PlanJobContext): PreparedRequest | null {
  if (!base || !revision || !job.planner) return null;
  const language = project.language as Language;
  const voicePreset = base.plan.voicePreset as VoicePreset;
  const sources = Array.isArray(base.plan.sources) ? (base.plan.sources as PreparedRequest["owned"]["sources"]) : [];
  const sceneIndex = revision.sceneId ? base.plan.scenes.findIndex((s) => s.id === revision.sceneId) : -1;
  return {
    language,
    messages: reviseMessages(sceneIndex >= 0 ? sceneIndex + 1 : null),
    prompt: buildRevisionPrompt({ plan: base.plan, request: { scope: revision.scope, sceneId: revision.sceneId, message: revision.message }, language, voicePreset }),
    owned: {
      ownerId: job.ownerId.toHexString(),
      projectId: job.projectId.toHexString(),
      versionId: job.planner.planVersionId.toHexString(),
      parentVersionId: base._id.toHexString(),
      language,
      voicePreset,
      sources,
    },
  };
}

/** Progress lines for a change request ("Updating scene 3…" when it is about one scene). */
export function reviseMessages(sceneNumber: number | null): PlanJobMessages {
  return { first: reviseProgressMessage(sceneNumber), retrying: REVISE_MESSAGES.RETRYING, repairing: REVISE_MESSAGES.REPAIRING, saving: REVISE_MESSAGES.SAVING };
}
