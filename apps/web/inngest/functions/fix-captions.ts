import {
  beginCaptionRender,
  completeCaptionJob,
  endCaptionJob,
  getDb,
  loadCaptionAttempt,
  readDbConfig,
  setCaptionProgress,
  speechArtifactsByIds,
  startCaptionAttempt,
} from "@bytereel/db";
import type { Inngest } from "inngest";
import { z } from "zod";
import { projectRoot, startRenderProcess } from "@/lib/video/render-process";
import { runCaptionJob, type CaptionJobStore } from "@/lib/video/run-caption-job";
import { storageFromEnv } from "@/lib/video/storage";
import { VIDEO_CONCURRENCY, VIDEO_RECAPTION_REQUESTED } from "../client";

// `fix-captions` (F25; API.md F4, PIPELINE_DESIGN §9): video.recaption.requested → the video rendered
// again with the creator's caption fixes and the SAME recorded narration (zero voice calls) → MP4
// checks → thumbnail → R2 → the new video is the project's video. The work itself is
// lib/video/run-caption-job.ts; this file connects it to Inngest, MongoDB and R2. No voice setup is
// passed in at all.
// - Concurrency: the SAME one-at-a-time render queue as `generate-video` (VIDEO_CONCURRENCY), so a
//   caption render never overlaps a video render; it waits its turn ("Waiting to start…").
// - Retries: 3 per step (Inngest). Timeouts like `generate-video` (it may wait behind other videos);
//   the stuck-job rule (packages/db/src/stuck-jobs.ts) covers caption jobs with the same queue rule.
// - Events carry ids only: { jobId, projectId, ownerId, attempt }.

const EventData = z.object({
  jobId: z.string().regex(/^[0-9a-f]{24}$/),
  projectId: z.string().regex(/^[0-9a-f]{24}$/),
  ownerId: z.string().regex(/^[0-9a-f]{24}$/),
  attempt: z.number().int().min(1),
});

function store(): CaptionJobStore {
  const settings = readDbConfig(process.env);
  if (!settings.ok) throw new Error(`Database settings problem: ${settings.problems.join(" ")}`);
  const db = getDb(settings.config);
  return {
    start: (input) => startCaptionAttempt(db, input),
    load: (input) => loadCaptionAttempt(db, input),
    speechByIds: (ownerId, ids) => speechArtifactsByIds(db, ownerId, ids),
    progress: (input) => setCaptionProgress(db, input),
    beginRender: (input) => beginCaptionRender(db, input),
    complete: (input) => completeCaptionJob(db, input),
    end: (input) => endCaptionJob(db, input),
  };
}

function files() {
  const setup = storageFromEnv(process.env);
  if (!setup.ok) throw new Error(`File storage (R2) is not set up: ${setup.problem}`);
  return setup.store;
}

export function createFixCaptionsFunction(inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "fix-captions",
      name: "Fix the captions",
      triggers: [{ event: VIDEO_RECAPTION_REQUESTED }],
      concurrency: VIDEO_CONCURRENCY,
      retries: 3,
      timeouts: { start: "2h", finish: "2h" },
    },
    async ({ event, step, runId }) => {
      const data = EventData.safeParse(event.data);
      if (!data.success) return { outcome: "ignored", reason: "bad event data" };
      const outcome = await runCaptionJob(
        { event: { jobId: data.data.jobId, attempt: data.data.attempt }, runId, step: { run: (id, fn) => step.run(id, fn) as never } },
        { store: store(), files, render: startRenderProcess, root: projectRoot() },
      );
      return { outcome };
    },
  );
}
