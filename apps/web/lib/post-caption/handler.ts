import { USAGE_LIMITS, type CaptionDraftBody, type CaptionDraftResource, type CaptionRequestCount, type CaptionSuggestionBody } from "@bytereel/db";
import { isLanguageEnabled, languageUnavailableMessage, type Language } from "@bytereel/db/languages";
import { joinPostCaption, POST_CAPTION_MESSAGES } from "@bytereel/db/post-caption";
import { PostCaptionError, suggestPostCaption, type PostCaptionInput, type PostCaptionScript, type PostCaptionUsageSink, type TokenUsage } from "@bytereel/pipeline/post-caption";
import { ApiProblem } from "../api/v1";
import { GEMINI_FREE_TIER_COST_INR } from "../brainstorm/handler";
import type { PostCaptionProviderResult } from "./provider";

// F29 "AI caption + hashtags": the work of H1 (POST …/caption-suggestions) and H7 (PUT …/caption-draft)
// (docs/API.md H1, H7). Kept free of Next.js and of the real database (the route files pass them in),
// so the tests run it with fakes.
// H1 order: the owner's project (404) → its language is switched on (422) → the video is ready, current
// and made from the current storyboard (409 INVALID_STATE) → the renderId sent is that video (409) →
// Instagram connected (409 INSTAGRAM_NOT_CONNECTED, decision 5) → `onlyIfEmpty` and a caption already
// saved (409 `draft_exists`, no AI) → the AI is set up (500) → count 1 of the project's 20 AI requests,
// atomically (429 QUOTA_EXCEEDED) → Gemini (30 s) → save the draft → 200. A refused request never
// reaches Gemini. No Gemini spend ceiling exists yet (API.md §10.2, F27: free tier), so no SPEND_CEILING.

/** What H1 needs about the project, read by the route with the owner check. */
export interface CaptionTarget {
  language: Language;
  /** The project's video id when it is ready to publish (video_ready, render ready, storyboard unchanged), else null. */
  readyRenderId: string | null;
  /** The approved storyboard the video was made from (null only if its version is missing). */
  script: PostCaptionScript | null;
  instagramActive: boolean;
  draft: CaptionDraftResource | null;
}

export interface CaptionUsageFinish {
  status: "final" | "failed";
  outcome: string;
  model: string;
  units: { promptTokens: number; outputTokens: number };
  estCostInr: number;
  latencyMs: number;
  errorCode?: string;
}

export interface CaptionSuggestionDeps {
  load: () => Promise<CaptionTarget | null>;
  provider: () => PostCaptionProviderResult;
  countRequest: (renderId: string) => Promise<CaptionRequestCount>;
  saveDraft: (text: string) => Promise<CaptionDraftResource | null>;
  reserveUsage: (input: { model: string; estCostInr: number }) => Promise<unknown>;
  finishUsage: (handle: unknown, input: CaptionUsageFinish) => Promise<void>;
  log?: (level: "warn" | "error", message: string) => void;
  /** Tests: shorter time limit, fake sleep. */
  run?: Pick<PostCaptionInput, "timeoutMs" | "sleep" | "retry">;
}

export type CaptionSuggestionResponse = { caption: string; hashtags: string[]; language: Language; draft: CaptionDraftResource };

export const PROJECT_NOT_FOUND = "We couldn't find this project.";

function unitsOf(usage: TokenUsage | null): CaptionUsageFinish["units"] {
  return { promptTokens: usage?.promptTokens ?? 0, outputTokens: (usage?.outputTokens ?? 0) + (usage?.thinkingTokens ?? 0) };
}

const notReady = (reason: string) => new ApiProblem(409, "INVALID_STATE", POST_CAPTION_MESSAGES.NOT_READY, { reason });

export async function runCaptionSuggestion(context: { body: CaptionSuggestionBody; requestId: string }, deps: CaptionSuggestionDeps): Promise<CaptionSuggestionResponse> {
  const { body, requestId } = context;
  const log = deps.log ?? ((level, message) => console[level](message));

  const target = await deps.load();
  if (!target) throw new ApiProblem(404, "NOT_FOUND", PROJECT_NOT_FOUND);
  if (!isLanguageEnabled(target.language)) throw new ApiProblem(422, "LANGUAGE_UNAVAILABLE", languageUnavailableMessage(), { language: target.language });
  const renderId = target.readyRenderId;
  if (!renderId) throw notReady("video_not_ready");
  if (body.renderId !== "current" && body.renderId !== renderId) throw notReady("render_not_current");
  if (!target.instagramActive) throw new ApiProblem(409, "INSTAGRAM_NOT_CONNECTED", POST_CAPTION_MESSAGES.NOT_CONNECTED);
  if (body.onlyIfEmpty === true && target.draft) throw new ApiProblem(409, "INVALID_STATE", POST_CAPTION_MESSAGES.DRAFT_EXISTS, { reason: "draft_exists", draft: target.draft });

  const ai = deps.provider();
  if (!ai.ok) throw new Error(`Caption suggestions are not set up: ${ai.problem}`);
  if (!target.script) throw new Error("The storyboard version of this video is missing.");

  const counted = await deps.countRequest(renderId);
  if (!counted.ok && counted.reason === "quota") {
    throw new ApiProblem(429, "QUOTA_EXCEEDED", POST_CAPTION_MESSAGES.QUOTA_EXCEEDED, { quota: "plan_requests_per_project", limit: USAGE_LIMITS.planRequestsPerProject, used: counted.used, resetsAt: null });
  }
  if (!counted.ok) throw notReady("video_not_ready");

  const usage: PostCaptionUsageSink = {
    begin: () => deps.reserveUsage({ model: ai.provider.model, estCostInr: GEMINI_FREE_TIER_COST_INR }),
    end: (handle, report) =>
      deps.finishUsage(handle, {
        status: report.status,
        outcome: report.outcome,
        model: report.model,
        units: unitsOf(report.usage),
        estCostInr: GEMINI_FREE_TIER_COST_INR,
        latencyMs: report.latencyMs,
        ...(report.errorCode ? { errorCode: report.errorCode } : {}),
      }),
  };

  let suggestion;
  try {
    const result = await suggestPostCaption({
      ...deps.run,
      provider: ai.provider,
      script: target.script,
      language: target.language,
      usage,
      onUsageError: (error) => log("error", `Caption usage log failed (request ${requestId}): ${error instanceof Error ? error.message : String(error)}`),
    });
    suggestion = result.suggestion;
  } catch (error) {
    if (!(error instanceof PostCaptionError)) throw error;
    if (error.reason === "rejected") throw new ApiProblem(422, "PROVIDER_REJECTED", POST_CAPTION_MESSAGES.PROVIDER_REJECTED);
    if (error.reason === "busy") {
      log("warn", `Caption suggestion busy (request ${requestId}): ${error.detail}`);
      throw new ApiProblem(503, "PROVIDER_BUSY", POST_CAPTION_MESSAGES.PROVIDER_BUSY, undefined, { "Retry-After": "60" });
    }
    throw new Error(`Caption provider problem (${error.detail}): ${error.message}`);
  }

  const draft = await deps.saveDraft(joinPostCaption(suggestion.caption, suggestion.hashtags));
  // The video changed (or the project was archived) while the AI was writing: nothing is saved.
  if (!draft) throw notReady("video_not_ready");
  return { caption: suggestion.caption, hashtags: suggestion.hashtags, language: target.language, draft };
}

export interface CaptionDraftDeps {
  /** The owner's project (null: not found / not theirs) and whether its video is ready to publish. */
  load: () => Promise<{ videoReady: boolean } | null>;
  save: (text: string) => Promise<CaptionDraftResource | null>;
}

/** H7: save the creator's caption as typed (cleaned by the body schema), `source: "edited"`. */
export async function runCaptionDraftSave(context: { body: CaptionDraftBody }, deps: CaptionDraftDeps): Promise<{ draft: CaptionDraftResource }> {
  const project = await deps.load();
  if (!project) throw new ApiProblem(404, "NOT_FOUND", PROJECT_NOT_FOUND);
  if (!project.videoReady) throw notReady("video_not_ready");
  const draft = await deps.save(context.body.text);
  if (!draft) throw notReady("video_not_ready");
  return { draft };
}
