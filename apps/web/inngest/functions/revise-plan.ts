import {
  completeReviseJob,
  failReviseJob,
  finishProviderUsage,
  getDb,
  loadReviseAttempt,
  readDbConfig,
  reservePlanRequest,
  reserveProviderUsage,
  savePlannerAnswer,
  setPlanProgress,
  startReviseAttempt,
} from "@bytereel/db";
import { RetryAfterError, type Inngest } from "inngest";
import type { ObjectId } from "mongodb";
import { z } from "zod";
import { plannerProviderFromEnv } from "@/lib/plan/provider";
import { runPlanJob, type PlanJobStore } from "@/lib/plan/run-plan-job";
import { prepareRevisionRequest } from "@/lib/storyboard/revise-job";
import { PLANNER_CONCURRENCY, REVISION_REQUESTED } from "../client";

// `revise-plan` (ARCHITECTURE §13.1, F18): revision.requested → Gemini writes the storyboard with
// the creator's change → a new `ai_revision` version (packages/db/src/revisions.ts).
// The steps are the storyboard job's own (lib/plan/run-plan-job.ts): each Gemini request counted
// on the job before it is sent (the attempt's first one also counts 1 of the project's 20), each
// answer saved at once, ONE repair, 2 retries per step; only the prompt differs.
// Concurrency: ONE shared limit with plan-video (PLANNER_CONCURRENCY): at most 2 per creator and 5
// in total across both functions (cost safety); one per project anyway (one active job). Every Gemini request is logged in providerUsage
// (operation "revise"). Events carry ids only.

const EventData = z.object({
  jobId: z.string().regex(/^[0-9a-f]{24}$/),
  projectId: z.string().regex(/^[0-9a-f]{24}$/),
  ownerId: z.string().regex(/^[0-9a-f]{24}$/),
  attempt: z.number().int().min(1),
});

function database() {
  const settings = readDbConfig(process.env);
  if (!settings.ok) throw new Error(`Database settings problem: ${settings.problems.join(" ")}`);
  return getDb(settings.config);
}

function store(): PlanJobStore {
  const db = database();
  return {
    start: (input) => startReviseAttempt(db, input),
    load: (input) => loadReviseAttempt(db, input),
    reserveRequest: (input) => reservePlanRequest(db, input),
    saveAnswer: (input) => savePlannerAnswer(db, input),
    setProgress: (input) => setPlanProgress(db, input),
    complete: (input) => completeReviseJob(db, input),
    fail: (input) => failReviseJob(db, input),
    reserveUsage: (input) => reserveProviderUsage(db, { ...input, provider: "gemini", operation: "revise", estCostInr: 0 }),
    finishUsage: (handle, input) => finishProviderUsage(db, handle as ObjectId, { ...input, estCostInr: 0 }),
  };
}

export function createRevisePlanFunction(inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "revise-plan",
      name: "Change the storyboard",
      triggers: [{ event: REVISION_REQUESTED }],
      concurrency: PLANNER_CONCURRENCY,
      retries: 2,
      timeouts: { start: "15m", finish: "20m" },
    },
    async ({ event, step, runId, attempt }) => {
      const data = EventData.safeParse(event.data);
      if (!data.success) return { outcome: "ignored", reason: "bad event data" };
      const outcome = await runPlanJob(
        {
          event: { jobId: data.data.jobId, attempt: data.data.attempt },
          runId,
          stepAttempt: () => attempt,
          step: { run: (id, fn) => step.run(id, fn) as never },
        },
        {
          store: store(),
          prepare: prepareRevisionRequest,
          provider: () => plannerProviderFromEnv(process.env),
          retryLater: (message, waitMs) => new RetryAfterError(message, waitMs),
        },
      );
      return { outcome };
    },
  );
}
