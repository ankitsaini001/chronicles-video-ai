import {
  completePlanJob,
  failPlanJob,
  finishProviderUsage,
  getDb,
  loadPlanAttempt,
  readDbConfig,
  reservePlanRequest,
  reserveProviderUsage,
  savePlannerAnswer,
  setPlanProgress,
  startPlanAttempt,
} from "@bytereel/db";
import { RetryAfterError, type Inngest } from "inngest";
import type { ObjectId } from "mongodb";
import { z } from "zod";
import { plannerProviderFromEnv } from "@/lib/plan/provider";
import { runPlanJob, type PlanJobStore } from "@/lib/plan/run-plan-job";
import { PLAN_REQUESTED } from "../client";

// `plan-video` (ARCHITECTURE §13.1): plan.requested → the AI writes the storyboard → plan version 1.
// The work itself is lib/plan/run-plan-job.ts; this file connects it to Inngest and MongoDB.
// - Concurrency: at most 2 storyboards per creator and 5 in total at the same time.
// - Retries: 2 per step (Inngest). A busy Gemini answer is retried by the step itself through
//   RetryAfterError (Retry-After honoured); answers already saved are never asked for again.
// - Timeouts: a run waiting more than 15 min to start, or running more than 20 min, is cancelled
//   by Inngest; the stuck-job rule (packages/db/src/plan-jobs.ts) then fails the job as retryable.
// - Events carry ids only: { jobId, projectId, ownerId, attempt }.

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
    start: (input) => startPlanAttempt(db, input),
    load: (input) => loadPlanAttempt(db, input),
    reserveRequest: (input) => reservePlanRequest(db, input),
    saveAnswer: (input) => savePlannerAnswer(db, input),
    setProgress: (input) => setPlanProgress(db, input),
    complete: (input) => completePlanJob(db, input),
    fail: (input) => failPlanJob(db, input),
    reserveUsage: (input) => reserveProviderUsage(db, { ...input, provider: "gemini", operation: "plan", estCostInr: 0 }),
    finishUsage: (handle, input) => finishProviderUsage(db, handle as ObjectId, { ...input, estCostInr: 0 }),
  };
}

export function createPlanVideoFunction(inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "plan-video",
      name: "Write the storyboard",
      triggers: [{ event: PLAN_REQUESTED }],
      concurrency: [
        { key: "event.data.ownerId", limit: 2 },
        { limit: 5 },
      ],
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
          provider: () => plannerProviderFromEnv(process.env),
          retryLater: (message, waitMs) => new RetryAfterError(message, waitMs),
        },
      );
      return { outcome };
    },
  );
}
