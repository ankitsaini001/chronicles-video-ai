import type { PlanJobContext, PlanJobErrorCode, PlannerAnswer, ValidPlanToSave } from "@bytereel/db";
import { voicePresetFor } from "@bytereel/db/voices";
import type { Language, VoicePreset } from "@bytereel/pipeline/contracts";
import {
  classifyPlanRequestError,
  evaluatePlannerResponse,
  hashPlan,
  ideaSources,
  PLAN_JOB_MAX_REQUESTS,
  PLAN_STEP_RETRIES,
  planJobPrompt,
  planRetryWaitMs,
  plannerRequestBase,
  repairTurns,
  validatePlan,
  type CreatorIdea,
  type PlannerEvaluation,
} from "@bytereel/pipeline/planning";
import type { PlannerProvider, PlannerTurn, TokenUsage } from "@bytereel/pipeline/providers";
import { ObjectId } from "mongodb";

// The storyboard job (Inngest function `plan-video`, F15; ARCHITECTURE §13, §16.1), kept free of
// Inngest and of the real database so the tests run it with fakes (inngest/functions/plan-video.ts
// passes the real ones). It REUSES the prototype planner: the same rules, response schema, plan
// validation and ONE repair (packages/pipeline/src/planning), but every Gemini request is its own
// durable step:
//   start → ask-1 (first answer) → [ask-2 (the repair), only if answer 1 is invalid] → save | fail
// - Each step is safe to run twice: an answer already saved on the job is reused, never re-asked.
// - Each request is counted on the job BEFORE it is sent (at most 4 per attempt) and logged in
//   providerUsage (reserved before, finished after), like brainstorm (F14).
// - Busy/network errors: at most 2 retries per answer (Retry-After honoured up to 60 s, via
//   Inngest's RetryAfterError), then the job fails with PROVIDER_BUSY. Safety → PROVIDER_REJECTED.
//   Still invalid after the repair → PLAN_INVALID. Key/model problems → INTERNAL (server log).
// - The creator's idea goes into the prompt only as delimited data (buildCreatorIdeaPrompt).

/** One job step: Inngest's step.run in production, a plain call in tests. */
export interface StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/** Thrown inside a step to ask the step runner for a retry after `waitMs` (Inngest RetryAfterError). */
export type RetryLater = (message: string, waitMs: number) => Error;

export interface PlanJobStore {
  start(input: { jobId: string; attempt: number; runId: string | null }): Promise<PlanJobContext | null>;
  /** Read-only: the job and project while the job is running this attempt, else null. */
  load(input: { jobId: string; attempt: number }): Promise<PlanJobContext | null>;
  /**
   * Count one Gemini request before it is sent. The attempt's FIRST request also counts 1 toward
   * the project's 20 (atomically, only below 20): "quota" when the project is already at 20.
   */
  reserveRequest(input: { jobId: ObjectId; attempt: number; maxRequests: number; message: string; percent: number }): Promise<"ok" | "limit" | "quota" | "stale">;
  saveAnswer(input: { jobId: ObjectId; attempt: number; answer: PlannerAnswer }): Promise<boolean>;
  setProgress(input: { jobId: ObjectId; attempt: number; stage: string; percent: number; message: string }): Promise<void>;
  complete(input: { jobId: ObjectId; attempt: number; result: ValidPlanToSave }): Promise<boolean>;
  fail(input: { jobId: ObjectId; attempt: number; code: PlanJobErrorCode; stage: "plan" | "validate"; detail?: string }): Promise<boolean>;
  reserveUsage(input: { ownerId: string; projectId: string; jobId: string; model: string }): Promise<unknown>;
  finishUsage(handle: unknown, input: { status: "final" | "failed"; outcome: string; model: string; units: { promptTokens: number; outputTokens: number }; latencyMs: number }): Promise<void>;
}

/** What one Gemini request of this job is about: the first prompt, the code-owned plan fields and the language. */
export interface PreparedRequest {
  prompt: string;
  owned: { ownerId: string; projectId: string; versionId: string; parentVersionId: string | null; language: Language; voicePreset: VoicePreset; sources: ReturnType<typeof ideaSources> };
  language: Language;
  /** Progress lines for this request (default: the job's `messages`). */
  messages?: PlanJobMessages;
}

/** Progress lines shown while the job runs (plan job: "Writing your storyboard…"; revise job: "Updating…"). */
export interface PlanJobMessages {
  first: string;
  retrying: string;
  repairing: string;
  saving: string;
}

export const PLAN_JOB_MESSAGES: PlanJobMessages = {
  first: "Writing your storyboard…",
  retrying: "Our AI is busy, trying again…",
  repairing: "Fixing a few details in your storyboard…",
  saving: "Checking your storyboard…",
};

export interface PlanJobDeps {
  store: PlanJobStore;
  /**
   * Builds the request from the loaded job (F18). Default: the F15 storyboard from the creator's
   * idea. Null = the job's data is missing (the step ends without an AI call).
   */
  prepare?: (ctx: PlanJobContext) => PreparedRequest | null;
  messages?: PlanJobMessages;
  /** The planner, or the reason it isn't set up (missing key, test switch where not allowed). */
  provider: () => { ok: true; provider: PlannerProvider } | { ok: false; problem: string };
  retryLater: RetryLater;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  now?: () => number;
  /** Tests: no real waiting between save retries. */
  sleep?: (ms: number) => Promise<void>;
}

export type PlanJobEvent = { jobId: string; attempt: number };
export type PlanJobOutcome = "saved" | "failed" | "skipped";

/** What one ask step reports back (small and JSON-safe: Inngest stores it as the step's result). */
type AskResult = { status: "valid" | "invalid" } | { status: "stale" | "limit" | "quota" | "rejected" | "setup" | "busy" };

/** Saving a paid answer is retried in-process this many times (short waits) before the step fails. */
const SAVE_TRIES = 3;
const SAVE_RETRY_WAIT_MS = 500;

const LANGUAGE_PRESET = (language: string, gender: string): VoicePreset => voicePresetFor(language as Language, gender as "female" | "male").preset as VoicePreset;

/** Billed output = the answer + the model's thinking tokens (as in brainstorm). */
function unitsOf(usage: TokenUsage | null): { promptTokens: number; outputTokens: number } {
  return { promptTokens: usage?.promptTokens ?? 0, outputTokens: (usage?.outputTokens ?? 0) + (usage?.thinkingTokens ?? 0) };
}

/** F15: the first storyboard, planned from the creator's idea (all creator text as delimited data). */
export function prepareIdeaRequest({ job, project }: PlanJobContext): PreparedRequest {
  const language = project.language as Language;
  const idea: CreatorIdea = { type: project.input.type, text: project.input.text, brainstormChoice: project.input.brainstormChoice };
  const voicePreset = LANGUAGE_PRESET(project.language, project.voiceGender);
  return {
    prompt: planJobPrompt(idea, language, voicePreset),
    language,
    owned: {
      ownerId: job.ownerId.toHexString(),
      projectId: job.projectId.toHexString(),
      versionId: job.planner!.planVersionId.toHexString(),
      parentVersionId: null,
      language,
      voicePreset,
      sources: ideaSources(idea),
    },
  };
}

export async function runPlanJob(input: { event: PlanJobEvent; runId: string | null; stepAttempt: () => number; step: StepRunner }, deps: PlanJobDeps): Promise<PlanJobOutcome> {
  const { event, step } = input;
  const { store } = deps;
  const log = deps.log ?? ((level, message) => console[level](message));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const prepare = deps.prepare ?? prepareIdeaRequest;
  const messages = deps.messages ?? PLAN_JOB_MESSAGES;

  // 1. The job becomes running for this attempt (or there is nothing to do).
  const started = await step.run("start", async () => {
    const ctx = await store.start({ jobId: event.jobId, attempt: event.attempt, runId: input.runId });
    return ctx ? { ok: true as const, hasValidAnswer: ctx.job.planner?.answers.some((a) => a.valid) ?? false } : { ok: false as const };
  });
  if (!started.ok) return "skipped";

  /** Everything a step needs, read fresh from the database (steps may run in different requests). */
  const load = async () => {
    const ctx = await store.load({ jobId: event.jobId, attempt: event.attempt });
    if (!ctx?.job.planner) return null;
    const prepared = prepare(ctx);
    return prepared ? { job: ctx.job, ...prepared } : null;
  };

  const ask = async (n: 1 | 2): Promise<AskResult> => {
    const ctx = await load();
    if (!ctx) return { status: "stale" };
    const { job, language, owned, prompt } = ctx;
    const lines = ctx.messages ?? messages;
    const saved = job.planner!.answers.find((a) => a.n === n);
    if (saved) return { status: saved.valid ? "valid" : "invalid" }; // this step ran before: no new request

    const setup = deps.provider();
    if (!setup.ok) {
      log("error", `Storyboard job ${event.jobId}: the planner is not set up: ${setup.problem}`);
      return { status: "setup" };
    }
    const provider = setup.provider;
    let turns: PlannerTurn[] = [{ role: "user", text: prompt }];
    if (n === 2) {
      const first = job.planner!.answers.find((a) => a.n === 1);
      if (!first) return { status: "stale" };
      const evaluated = evaluatePlannerResponse(first, owned);
      if (evaluated.ok) return { status: "stale" };
      turns = repairTurns(prompt, first.text, evaluated.issues, evaluated.stats, language);
    }

    const retry = input.stepAttempt();
    const reserved = await store.reserveRequest({
      jobId: job._id,
      attempt: event.attempt,
      maxRequests: PLAN_JOB_MAX_REQUESTS,
      message: n === 2 ? lines.repairing : retry > 0 ? lines.retrying : lines.first,
      percent: n === 2 ? 60 : 10,
    });
    if (reserved !== "ok") return { status: reserved };

    const usage = await store.reserveUsage({ ownerId: job.ownerId.toHexString(), projectId: job.projectId.toHexString(), jobId: job._id.toHexString(), model: provider.model });
    const sentAt = now();
    // Only the request itself is inside this try: anything after it is our own work on a PAID answer
    // and must never be mistaken for "Gemini is busy" (which would ask, and pay, again).
    let response: Awaited<ReturnType<PlannerProvider["generate"]>>;
    try {
      response = await provider.generate({ ...plannerRequestBase(language), turns });
    } catch (error) {
      const failure = classifyPlanRequestError(error);
      const message = error instanceof Error ? error.message : String(error);
      const outcome = failure.kind === "rejected" ? "rejected" : failure.kind === "setup" ? "error" : /timeout|timed out|abort/i.test(message) ? "timeout" : "busy";
      await finishUsageSafely(usage, { status: "failed", outcome, model: provider.model, units: { promptTokens: 0, outputTokens: 0 }, latencyMs: now() - sentAt });
      if (failure.kind === "rejected") return { status: "rejected" };
      if (failure.kind === "setup") {
        log("error", `Storyboard job ${event.jobId}: Gemini refused the request (key/model/request problem): ${message}`);
        return { status: "setup" };
      }
      const wait = planRetryWaitMs(retry + 1, failure.retryAfterMs);
      if (retry >= PLAN_STEP_RETRIES || wait === null) {
        log("warn", `Storyboard job ${event.jobId}: Gemini still busy after ${retry} retr${retry === 1 ? "y" : "ies"}: ${message}`);
        return { status: "busy" };
      }
      await store.setProgress({ jobId: job._id, attempt: event.attempt, stage: "plan", percent: n === 2 ? 60 : 10, message: lines.retrying });
      throw deps.retryLater(`Gemini busy (answer ${n}, retry ${retry + 1}): ${message}`, wait);
    }
    const latencyMs = now() - sentAt;

    let evaluation: PlannerEvaluation | null = null;
    try {
      evaluation = evaluatePlannerResponse(response, owned);
    } catch (error) {
      // A bug in our checking, not a busy AI: the answer is still kept (as not valid).
      log("error", `Storyboard job ${event.jobId}: checking answer ${n} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const answer: PlannerAnswer = {
      n,
      text: response.text,
      model: response.model,
      finishReason: response.finishReason,
      usage: response.usage ? { promptTokens: response.usage.promptTokens, outputTokens: response.usage.outputTokens, thinkingTokens: response.usage.thinkingTokens } : null,
      valid: evaluation?.ok === true,
      issueCount: evaluation && !evaluation.ok ? evaluation.issues.length : 0,
    };
    // Save the paid answer FIRST (a re-run of this step, or a later Try again, reuses it), with a
    // few quick in-process retries, then finish the usage row.
    try {
      await saveAnswerWithRetries(job._id, answer);
    } finally {
      await finishUsageSafely(usage, { status: "final", outcome: answer.valid ? "ok" : "invalid_output", model: response.model, units: unitsOf(response.usage), latencyMs });
    }
    return { status: answer.valid ? "valid" : "invalid" };
  };

  async function saveAnswerWithRetries(jobId: ObjectId, answer: PlannerAnswer): Promise<void> {
    for (let tryNumber = 1; ; tryNumber++) {
      try {
        await store.saveAnswer({ jobId, attempt: event.attempt, answer });
        return;
      } catch (error) {
        if (tryNumber >= SAVE_TRIES) throw error;
        log("warn", `Storyboard job ${event.jobId}: saving answer ${answer.n} failed (try ${tryNumber} of ${SAVE_TRIES}), trying again`);
        await sleep(SAVE_RETRY_WAIT_MS * tryNumber);
      }
    }
  }

  async function finishUsageSafely(handle: unknown, report: Parameters<PlanJobStore["finishUsage"]>[1]): Promise<void> {
    try {
      await store.finishUsage(handle, report);
    } catch (error) {
      log("error", `Storyboard job ${event.jobId}: usage log failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const save = async (): Promise<"saved" | "stale"> => {
    const ctx = await load();
    if (!ctx) return "stale";
    const { job } = ctx;
    const valid = job.planner!.answers.find((a) => a.valid);
    if (!valid) return "stale";
    await store.setProgress({ jobId: job._id, attempt: event.attempt, stage: "validate", percent: 90, message: (ctx.messages ?? messages).saving });
    const evaluated = evaluatePlannerResponse(valid, ctx.owned);
    if (!evaluated.ok) return "stale";
    const checked = validatePlan(evaluated.plan);
    const answers = job.planner!.answers;
    const sum = (pick: (u: NonNullable<PlannerAnswer["usage"]>) => number | null) => answers.reduce((total, a) => total + (a.usage ? (pick(a.usage) ?? 0) : 0), 0);
    const result: ValidPlanToSave = {
      plan: evaluated.plan as unknown as ValidPlanToSave["plan"],
      planHash: hashPlan(evaluated.plan),
      stats: evaluated.stats,
      warnings: checked.ok ? checked.warnings : [],
      plannerUsage: {
        model: valid.model,
        promptTokens: sum((u) => u.promptTokens),
        outputTokens: sum((u) => u.outputTokens),
        thinkingTokens: sum((u) => u.thinkingTokens),
        attempts: Math.max(job.planner!.requests, answers.length),
      },
    };
    return (await store.complete({ jobId: job._id, attempt: event.attempt, result })) ? "saved" : "stale";
  };

  const fail = async (code: PlanJobErrorCode, stage: "plan" | "validate", detail?: string): Promise<PlanJobOutcome> => {
    const failed = await step.run(`fail-${code.toLowerCase()}`, () =>
      store.fail({ jobId: new ObjectId(event.jobId), attempt: event.attempt, code, stage, ...(detail ? { detail } : {}) }),
    );
    return failed ? "failed" : "skipped";
  };

  const terminal = async (result: AskResult): Promise<PlanJobOutcome | null> => {
    switch (result.status) {
      case "stale":
        return "skipped";
      case "limit":
      case "busy":
        return fail("PROVIDER_BUSY", "plan", result.status === "limit" ? "Request limit for this attempt reached" : "Gemini stayed busy after the allowed retries");
      case "quota":
        return fail("QUOTA_EXCEEDED", "plan", "The project already used its 20 storyboard requests");
      case "rejected":
        return fail("PROVIDER_REJECTED", "plan", "Gemini refused the content (safety)");
      case "setup":
        return fail("INTERNAL", "plan", "Planner setup problem (see the server log)");
      default:
        return null;
    }
  };

  try {
    let outcome: AskResult = { status: started.hasValidAnswer ? "valid" : "invalid" };
    if (!started.hasValidAnswer) {
      outcome = await step.run("ask-1", () => ask(1));
      const stop = await terminal(outcome);
      if (stop) return stop;
      if (outcome.status === "invalid") {
        outcome = await step.run("ask-2", () => ask(2));
        const stopRepair = await terminal(outcome);
        if (stopRepair) return stopRepair;
      }
    }
    if (outcome.status !== "valid") return fail("PLAN_INVALID", "validate", "Still invalid after one repair");
    const saved = await step.run("save", save);
    return saved === "saved" ? "saved" : "skipped";
  } catch (error) {
    // A step failed for good (its retries are used up) or something unexpected broke: the job fails
    // with a retryable error instead of waiting forever. Busy answers were already handled above.
    log("error", `Storyboard job ${event.jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
    const busy = error instanceof Error && /Gemini busy/.test(error.message);
    return fail(busy ? "PROVIDER_BUSY" : "INTERNAL", "plan");
  }
}
