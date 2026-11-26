import {
  claimPublishCall,
  completePublishJob,
  endPublishJob,
  findReaderConnection,
  getDb,
  loadPublishContext,
  logPublishAttempt,
  markOutcomeUnknown,
  readDbConfig,
  recheckPublishApproval,
  releasePublishClaim,
  savePublishContainer,
  setPublishProgress,
  startPublishAttempt,
} from "@bytereel/db";
import { isStorageKey } from "@bytereel/storage";
import type { Inngest } from "inngest";
import { z } from "zod";
import { instagramPublisherFromEnv, isFakeInstagram } from "@/lib/instagram/provider";
import { FAKE_DELAYS, REAL_DELAYS, runPublishJob, type PublishJobStore } from "@/lib/publish/run-publish-job";
import { connectionToken } from "@/lib/publish/token";
import { storageFromEnv } from "@/lib/video/storage";
import { POST_PUBLISH_REQUESTED } from "../client";

// `publish-post` (F30; API.md H2, H6; ARCHITECTURE §17.3–17.4): post.publish.requested → the approved
// video goes to Instagram as a Reel. The work itself is lib/publish/run-publish-job.ts; this file
// connects it to Inngest, MongoDB, R2 (a private 1-hour link to the MP4) and Instagram (the real API,
// or the stand-in on the test server).
// - Concurrency: one run per post at a time, which keeps runs tidy but is NOT what makes publishing
//   safe: every write checks "this job, this attempt, still running", and media_publish is sent only
//   after the post's claim (publishAttemptedAt, taken only while null, by the current attempt) succeeds.
//   An older run that wakes up late finds its attempt gone and changes nothing.
// - Retries: 3 per step (Inngest). A step that may have sent media_publish is never re-sent blindly:
//   the post's claim makes the repeat go to reconcile.
// - Events carry ids only: { jobId, projectId, ownerId, attempt, postId }.

const EventData = z.object({
  jobId: z.string().regex(/^[0-9a-f]{24}$/),
  projectId: z.string().regex(/^[0-9a-f]{24}$/),
  ownerId: z.string().regex(/^[0-9a-f]{24}$/),
  attempt: z.number().int().min(1),
});

/** The presigned link Meta fetches the MP4 from: 1 hour (it fetches within minutes). */
const VIDEO_LINK_TTL_SECONDS = 3600;

function database() {
  const settings = readDbConfig(process.env);
  if (!settings.ok) throw new Error(`Database settings problem: ${settings.problems.join(" ")}`);
  return getDb(settings.config);
}

function store(db: ReturnType<typeof getDb>): PublishJobStore {
  return {
    start: (input) => startPublishAttempt(db, input),
    load: (input) => loadPublishContext(db, input),
    recheck: (post, now) => recheckPublishApproval(db, post, now),
    progress: (input) => setPublishProgress(db, input),
    saveContainer: (input) => savePublishContainer(db, input),
    claim: (input) => claimPublishCall(db, input),
    unknown: (input) => markOutcomeUnknown(db, input),
    release: (input) => releasePublishClaim(db, input),
    complete: (input) => completePublishJob(db, input),
    end: (input) => endPublishJob(db, input),
    log: (entry) => logPublishAttempt(db, entry),
    reader: (post, now) => findReaderConnection(db, post, now),
  };
}

async function videoUrl(mp4Key: string): Promise<string> {
  const setup = storageFromEnv(process.env);
  if (!setup.ok) throw new Error("File storage (R2) is not set up.");
  if (!isStorageKey(mp4Key)) throw new Error("The video's file key is not a valid storage key.");
  return (await setup.store.presignedGet(mp4Key, { ttlSeconds: VIDEO_LINK_TTL_SECONDS })).url;
}

export function createPublishPostFunction(inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "publish-post",
      name: "Publish to Instagram",
      triggers: [{ event: POST_PUBLISH_REQUESTED }],
      // Tidiness only: the safety comes from the claim's attempt check (claimPublishCall), not from this.
      concurrency: [{ key: "event.data.postId", limit: 1 }],
      retries: 3,
      timeouts: { start: "30m", finish: "1h" },
    },
    async ({ event, step, runId }) => {
      const data = EventData.safeParse(event.data);
      if (!data.success) return { outcome: "ignored", reason: "bad event data" };
      const db = database();
      const outcome = await runPublishJob(
        { event: { jobId: data.data.jobId, attempt: data.data.attempt }, runId, step: { run: (id, fn) => step.run(id, fn) as never, sleep: (id, ms) => step.sleep(id, ms) } },
        {
          store: store(db),
          publisher: () => {
            const setup = instagramPublisherFromEnv(db, process.env);
            return setup.ok ? { ok: true, publisher: setup.publisher } : { ok: false, problems: setup.problems };
          },
          token: connectionToken,
          videoUrl,
          delays: isFakeInstagram(process.env) ? FAKE_DELAYS : REAL_DELAYS,
        },
      );
      return { outcome };
    },
  );
}
