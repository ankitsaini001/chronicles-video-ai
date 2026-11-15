import {
  beginRender,
  claimSpeech,
  completeGenerateJob,
  endGenerateJob,
  getDb,
  loadGenerateAttempt,
  markSpeechFailed,
  markSpeechReady,
  ownerTimezone,
  readDbConfig,
  readySpeech,
  reserveVoice,
  saveSpeechResponse,
  setGenerateProgress,
  startGenerateAttempt,
} from "@bytereel/db";
import { RetryAfterError, type Inngest } from "inngest";
import { z } from "zod";
import { projectRoot, startRenderProcess } from "@/lib/video/render-process";
import { runGenerateJob, type GenerateJobStore } from "@/lib/video/run-generate-job";
import { storageFromEnv } from "@/lib/video/storage";
import { voiceSetupFromEnv } from "@/lib/video/voice";
import { VIDEO_CONCURRENCY, VIDEO_GENERATE_REQUESTED } from "../client";

// `generate-video` (ARCHITECTURE §13.1, F23): video.generate.requested → narration per scene →
// timing and captions → render on this computer → MP4 checks → thumbnail → R2 → `video_ready`.
// The work itself is lib/video/run-generate-job.ts; this file connects it to Inngest, MongoDB and R2.
// - Concurrency: ONE step at a time across the app (VIDEO_CONCURRENCY): a render never overlaps
//   another; other videos wait ("Waiting to start…").
// - Retries: 3 per step (Inngest). A recording held by another job waits through RetryAfterError.
// - Timeouts: a run may wait up to 2 h for its turn and take up to 2 h once started (renders of other
//   videos may come between its steps); the stuck-job rule (packages/db/src/stuck-jobs.ts) fails a
//   video job only when the whole video queue has been still for 15 min.
// - No cancelOn: every step checks `cancelRequestedAt` itself (E3), so the job always ends in a
//   known state, and a waiting run that was cancelled ends at its first step.
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

function store(): GenerateJobStore {
  const db = database();
  return {
    start: (input) => startGenerateAttempt(db, input),
    load: (input) => loadGenerateAttempt(db, input),
    timezone: (ownerId) => ownerTimezone(db, ownerId),
    readySpeech: (ownerId, keys) => readySpeech(db, ownerId, keys),
    reserveVoice: (input) => reserveVoice(db, input),
    claimSpeech: (input) => claimSpeech(db, input),
    saveSpeechResponse: (input) => saveSpeechResponse(db, input),
    markSpeechReady: (input) => markSpeechReady(db, input),
    markSpeechFailed: (input) => markSpeechFailed(db, input),
    progress: (input) => setGenerateProgress(db, input),
    beginRender: (input) => beginRender(db, input),
    complete: (input) => completeGenerateJob(db, input),
    end: (input) => endGenerateJob(db, input),
  };
}

function files() {
  const setup = storageFromEnv(process.env);
  if (!setup.ok) throw new Error(`File storage (R2) is not set up: ${setup.problem}`);
  return setup.store;
}

export function createGenerateVideoFunction(inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "generate-video",
      name: "Make the video",
      triggers: [{ event: VIDEO_GENERATE_REQUESTED }],
      concurrency: VIDEO_CONCURRENCY,
      retries: 3,
      timeouts: { start: "2h", finish: "2h" },
    },
    async ({ event, step, runId }) => {
      const data = EventData.safeParse(event.data);
      if (!data.success) return { outcome: "ignored", reason: "bad event data" };
      const outcome = await runGenerateJob(
        { event: { jobId: data.data.jobId, attempt: data.data.attempt }, runId, step: { run: (id, fn) => step.run(id, fn) as never } },
        {
          store: store(),
          files,
          voice: () => voiceSetupFromEnv(process.env),
          render: startRenderProcess,
          root: projectRoot(),
          retryLater: (message, waitMs) => new RetryAfterError(message, waitMs),
        },
      );
      return { outcome };
    },
  );
}
