import {
  PUBLISH_MESSAGES,
  type InstagramConnectionDocument,
  type PostDocument,
  type PublishAttemptLog,
  type PublishContext,
  type PublishFailure,
  type PublishStage,
  type PublishStart,
  type RecheckResult,
} from "@bytereel/db";
import { ObjectId } from "mongodb";
import { InstagramPublishError, meaningOf, type InstagramPublisher, type RecentMedia } from "../instagram/publish-client";

// The publish job (Inngest function `publish-post`, F30; ARCHITECTURE §17.3–17.4, API.md §9, H2, H6).
// Kept free of Inngest and of the real database (the store and Instagram are passed in), so the tests
// run it with fakes.
//
// Durable steps, each saved by Inngest as it finishes (step results hold no token and no link):
//   start             the job becomes running for this attempt (deadline: about 10 minutes)
//   approve           the FULL approval re-check (§9); anything different → no publish
//   create_container  the re-check again RIGHT BEFORE the container; a private 1-hour R2 link to the
//                     exact approved MP4; POST /media (REELS). A good container from an earlier
//                     attempt (< 23 h, not ERROR/EXPIRED) is reused.
//   poll              GET /{container}?fields=status_code until FINISHED (ERROR → failed)
//   publish           the re-check again RIGHT BEFORE media_publish; the ONE call is claimed in the
//                     database first; no clear answer → `outcome_unknown` → reconcile
//   reconcile         looks at Instagram: the container's status and the account's recent media
//                     (same caption, after the publish was sent). Found → published. The container
//                     still unpublished twice in a row → the claim is released and the SAME container
//                     is published (Instagram publishes a container only once). Never a new container
//                     after a publish was sent.
// Instagram hiccups (5xx, timeouts, still processing) are retried with waits until the deadline, then
// the post fails with a plain reason and Try again (H6). The daily limit, an expired token and a
// refused post fail at once. An attempt that starts after a publish was sent (Try again after an
// unconfirmed outcome) goes straight to reconcile.

/** One job step: Inngest's step.run / step.sleep in production, plain calls in tests. */
export interface PublishStepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, ms: number): Promise<void>;
}

/** What the worker needs from the database (packages/db/src/posts.ts). */
export interface PublishJobStore {
  start(input: { jobId: string; attempt: number; runId: string | null }): Promise<PublishStart | null>;
  load(input: { jobId: string; attempt: number }): Promise<PublishContext | null>;
  recheck(post: PostDocument, now: Date): Promise<RecheckResult>;
  progress(input: { jobId: ObjectId; attempt: number; stage: PublishStage; percent: number; message: string }): Promise<boolean>;
  saveContainer(input: { postId: ObjectId; jobId: ObjectId; containerId?: string | null; status?: string | null }): Promise<boolean>;
  claim(input: { postId: ObjectId; jobId: ObjectId; attempt: number }): Promise<boolean>;
  unknown(input: { postId: ObjectId; jobId: ObjectId }): Promise<boolean>;
  release(input: { postId: ObjectId; jobId: ObjectId }): Promise<boolean>;
  complete(input: { jobId: ObjectId; attempt: number; mediaId: string | null; permalink: string | null }): Promise<boolean>;
  /** Ends the job with the fixed plain reason (no detail is stored; it goes only to the server log). */
  end(input: { jobId: ObjectId; attempt: number; failure: PublishFailure; stage: PublishStage }): Promise<boolean>;
  log(entry: PublishAttemptLog): Promise<void>;
  /** An active connection for `approval.igUserId` with a valid token (reconcile only reads), or null. */
  reader(post: PostDocument, now: Date): Promise<InstagramConnectionDocument | null>;
}

export type PublisherSetup = { ok: true; publisher: InstagramPublisher } | { ok: false; problems: string[] };

export interface PublishJobDeps {
  store: PublishJobStore;
  publisher: () => PublisherSetup;
  /** The connection's token in plain text (decrypted with its record binding). Throws when it can't be read. */
  token: (connection: InstagramConnectionDocument) => string;
  /** A private GET link to the MP4, valid about 1 hour (never logged or stored). */
  videoUrl: (mp4Key: string) => Promise<string>;
  /** Waits (ms). Production: about 10 s before the first check, then 20 s; the stand-in: 1 s. */
  delays: PublishDelays;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export type PublishDelays = { firstCheckMs: number; checkMs: number; retryMs: number; reconcileMs: number };
export const REAL_DELAYS: PublishDelays = { firstCheckMs: 10_000, checkMs: 20_000, retryMs: 15_000, reconcileMs: 20_000 };
export const FAKE_DELAYS: PublishDelays = { firstCheckMs: 1000, checkMs: 1000, retryMs: 1000, reconcileMs: 1000 };

/** Reconcile: the container still unpublished this many times in a row → safe to publish it again. */
const NOT_PUBLISHED_CHECKS = 2;
/**
 * Media posted up to this long before the FIRST media_publish still counts as ours (Instagram's clock
 * and ours differ a little). Anything older can't be this post (F30 code review nit 8: was 5 minutes).
 */
export const RECONCILE_SLACK_MS = 60_000;
/** Safety net for the step loop (well above 10 minutes of checks). */
const MAX_STEPS = 120;

export type PublishJobOutcome = "published" | "failed" | "skipped";

type Phase = "container" | "poll" | "publish" | "reconcile";
type StepAnswer = { next: Phase; waitMs: number; notPublished?: number } | { done: "published" | "failed" | "stale" };

const sameCaption = (a: string | null, b: string) => a !== null && a.normalize("NFC").trim() === b.normalize("NFC").trim();

/**
 * Our reel among the account's recent media (reconcile and "Check again"): the same caption, posted at
 * or after the FIRST media_publish minus RECONCILE_SLACK_MS. When Instagram leaves captions out of the
 * list but says the container is PUBLISHED, the newest recent media in the window is ours.
 */
export function findPublishedMedia(
  post: Pick<PostDocument, "caption" | "createdAt" | "publishAttemptedAt" | "firstPublishAttemptedAt">,
  media: readonly RecentMedia[] | null,
  statusCode: string | null,
): RecentMedia | undefined {
  const first = post.firstPublishAttemptedAt ?? post.publishAttemptedAt ?? post.createdAt;
  const since = first.getTime() - RECONCILE_SLACK_MS;
  const recent = (media ?? []).filter((m) => m.timestamp !== null && new Date(m.timestamp).getTime() >= since);
  const captionsKnown = recent.some((m) => m.caption !== null);
  return recent.find((m) => sameCaption(m.caption, post.caption)) ?? (statusCode === "PUBLISHED" && !captionsKnown ? recent[0] : undefined);
}

export async function runPublishJob(input: { event: { jobId: string; attempt: number }; runId: string | null; step: PublishStepRunner }, deps: PublishJobDeps): Promise<PublishJobOutcome> {
  const { event, step } = input;
  const { store } = deps;
  const log = deps.log ?? ((level, message) => console[level](message));
  const now = deps.now ?? (() => new Date());
  if (!/^[0-9a-f]{24}$/.test(event.jobId)) return "skipped";
  const jobId = new ObjectId(event.jobId);
  const attempt = event.attempt;
  const label = `Publish job ${event.jobId} (attempt ${attempt})`;

  const start = await step.run("start", () => store.start({ jobId: event.jobId, attempt, runId: input.runId }));
  if (!start) return "skipped";
  const postId = new ObjectId(start.postId);
  const deadline = new Date(start.deadline).getTime();
  const late = () => now().getTime() > deadline;

  // The creator sees only the fixed plain line (PUBLISH_FAILURES); `detail` goes to the server log only.
  const end = async (failure: PublishFailure, stage: PublishStage, detail?: string): Promise<StepAnswer> => {
    await store.end({ jobId, attempt, failure, stage });
    log("warn", `${label}: ended (${failure}) at ${stage}${detail ? `: ${detail}` : ""}.`);
    return { done: "failed" };
  };
  const record = (entry: Omit<PublishAttemptLog, "postId" | "ownerId" | "jobAttempt">, ownerId: ObjectId) =>
    store.log({ postId, ownerId, jobAttempt: attempt, ...entry }).catch((error: unknown) => log("error", `${label}: couldn't log a publish attempt: ${error instanceof Error ? error.message : String(error)}`));
  const errorFields = (error: InstagramPublishError) => ({ kind: error.kind, status: error.status, code: error.code, subcode: error.subcode });

  /** The setup a Meta call needs: the job still runs this attempt, Instagram is set up, the token reads. */
  const prepare = async (): Promise<{ ctx: PublishContext; api: InstagramPublisher } | StepAnswer> => {
    const ctx = await store.load({ jobId: event.jobId, attempt });
    if (!ctx) return { done: "stale" };
    const setup = deps.publisher();
    if (!setup.ok) return end("internal", ctx.job.progress.stage as PublishStage, `Instagram is not set up: ${setup.problems.join(" ")}`.slice(0, 280));
    return { ctx, api: setup.publisher };
  };
  /** The full re-check (API.md §9) and the token. */
  const approved = async (ctx: PublishContext, stage: PublishStage): Promise<{ token: string; check: Extract<RecheckResult, { ok: true }> } | StepAnswer> => {
    const check = await store.recheck(ctx.post, now());
    if (!check.ok) return end(check.failure, stage, `Approval re-check: ${check.reason}`);
    try {
      return { token: deps.token(check.connection), check };
    } catch {
      // A token that can't be read (another key, a changed record) needs a new connect.
      return end("token_expired", stage, "The Instagram token could not be read");
    }
  };
  /** A clear refusal from Instagram → the plain reason. */
  const refusal = (error: InstagramPublishError, stage: PublishStage): Promise<StepAnswer> => {
    const meaning = meaningOf(error);
    const failure: PublishFailure = meaning === "limit" ? "limit" : meaning === "token" ? "token_expired" : meaning === "unreachable" ? "video_unreachable" : "rejected";
    return end(failure, stage, error.message);
  };

  // approve: the full re-check before anything is sent.
  const approval = await step.run("approve", async (): Promise<StepAnswer> => {
    const ctx = await store.load({ jobId: event.jobId, attempt });
    if (!ctx) return { done: "stale" };
    const check = await store.recheck(ctx.post, now());
    if (!check.ok) return end(check.failure, "approve", `Approval re-check: ${check.reason}`);
    return { next: start.publishSent ? "reconcile" : "container", waitMs: 0 };
  });
  if ("done" in approval) return approval.done === "stale" ? "skipped" : approval.done;

  const containerStep = async (): Promise<StepAnswer> => {
    const ready = await prepare();
    if ("done" in ready || "next" in ready) return ready;
    const { ctx, api } = ready;
    const { post } = ctx;
    if (late()) return end("too_slow", "create_container", "Gave up after about 10 minutes of retries");
    const reusable = post.igContainerId !== null && post.containerStatus !== "ERROR" && post.containerStatus !== "EXPIRED";
    if (reusable) {
      await store.progress({ jobId, attempt, stage: "poll", percent: 40, message: PUBLISH_MESSAGES.PROCESSING });
      return { next: "poll", waitMs: 0 };
    }
    const ok = await approved(ctx, "create_container");
    if ("done" in ok || "next" in ok) return ok;
    await store.progress({ jobId, attempt, stage: "create_container", percent: 20, message: PUBLISH_MESSAGES.SENDING });
    let videoUrl: string;
    try {
      videoUrl = await deps.videoUrl(ok.check.render.mp4Key);
    } catch (error) {
      log("error", `${label}: couldn't make the video link: ${error instanceof Error ? error.name : "unknown error"}`);
      return end("internal", "create_container", "The private video link could not be made (see the server log)");
    }
    try {
      const { containerId } = await api.createReelsContainer({ igUserId: ok.check.connection.igUserId, accessToken: ok.token, videoUrl, caption: post.caption.trim() });
      await store.saveContainer({ postId, jobId, containerId });
      await record({ step: "create_container", request: { mediaType: "REELS", captionChars: post.caption.length }, response: { containerId }, outcome: "ok" }, post.ownerId);
      await store.progress({ jobId, attempt, stage: "poll", percent: 35, message: PUBLISH_MESSAGES.PROCESSING });
      return { next: "poll", waitMs: deps.delays.firstCheckMs };
    } catch (error) {
      if (!(error instanceof InstagramPublishError)) throw error;
      await record({ step: "create_container", request: { mediaType: "REELS", captionChars: post.caption.length }, response: errorFields(error), outcome: "error" }, post.ownerId);
      if (meaningOf(error) === "transient") {
        await store.progress({ jobId, attempt, stage: "create_container", percent: 20, message: PUBLISH_MESSAGES.RETRYING });
        return { next: "container", waitMs: deps.delays.retryMs };
      }
      return refusal(error, "create_container");
    }
  };

  const pollStep = async (): Promise<StepAnswer> => {
    const ready = await prepare();
    if ("done" in ready || "next" in ready) return ready;
    const { ctx, api } = ready;
    const { post } = ctx;
    if (!post.igContainerId) return { next: "container", waitMs: 0 };
    if (late()) return end("too_slow", "poll", "Instagram was still processing after about 10 minutes");
    const ok = await approved(ctx, "poll");
    if ("done" in ok || "next" in ok) return ok;
    let statusCode: string;
    try {
      const status = await api.containerStatus({ containerId: post.igContainerId, accessToken: ok.token });
      statusCode = status.statusCode;
      await store.saveContainer({ postId, jobId, status: statusCode });
      await record({ step: "poll", request: { containerId: post.igContainerId }, response: { statusCode, status: status.status }, outcome: statusCode.toLowerCase() }, post.ownerId);
    } catch (error) {
      if (!(error instanceof InstagramPublishError)) throw error;
      await record({ step: "poll", request: { containerId: post.igContainerId }, response: errorFields(error), outcome: "error" }, post.ownerId);
      if (meaningOf(error) === "transient") return { next: "poll", waitMs: deps.delays.checkMs };
      return refusal(error, "poll");
    }
    if (statusCode === "FINISHED") return { next: "publish", waitMs: 0 };
    if (statusCode === "PUBLISHED") return { next: "reconcile", waitMs: 0 };
    if (statusCode === "ERROR") return end("processing_error", "poll", "The container ended in ERROR");
    if (statusCode === "EXPIRED") {
      await store.saveContainer({ postId, jobId, containerId: null });
      return { next: "container", waitMs: 0 };
    }
    await store.progress({ jobId, attempt, stage: "poll", percent: 60, message: PUBLISH_MESSAGES.PROCESSING });
    return { next: "poll", waitMs: deps.delays.checkMs };
  };

  /** media id found → the permalink (best effort) → published. */
  const finish = async (api: InstagramPublisher, token: string, ownerId: ObjectId, mediaId: string | null, known: string | null): Promise<StepAnswer> => {
    let permalink = known;
    if (mediaId && !permalink) {
      try {
        permalink = await api.permalink({ mediaId, accessToken: token });
        await record({ step: "permalink", request: { mediaId }, response: { found: permalink !== null }, outcome: "ok" }, ownerId);
      } catch (error) {
        if (error instanceof InstagramPublishError) await record({ step: "permalink", request: { mediaId }, response: errorFields(error), outcome: "error" }, ownerId);
        permalink = null; // the Published screen links to the profile instead
      }
    }
    const saved = await store.complete({ jobId, attempt, mediaId, permalink });
    if (saved) log("info", `${label}: published${mediaId ? ` as media ${mediaId}` : ""}.`);
    return saved ? { done: "published" } : { done: "stale" };
  };

  const publishStep = async (): Promise<StepAnswer> => {
    const ready = await prepare();
    if ("done" in ready || "next" in ready) return ready;
    const { ctx, api } = ready;
    const { post } = ctx;
    // A publish was already sent (this step ran before and stopped): look at Instagram first.
    if (post.publishAttemptedAt) return { next: "reconcile", waitMs: 0 };
    if (!post.igContainerId) return { next: "container", waitMs: 0 };
    if (late()) return end("too_slow", "publish", "Gave up after about 10 minutes of retries");
    // The re-check RIGHT BEFORE media_publish (API.md §9).
    const ok = await approved(ctx, "publish");
    if ("done" in ok || "next" in ok) return ok;
    await store.progress({ jobId, attempt, stage: "publish", percent: 85, message: PUBLISH_MESSAGES.PUBLISHING });
    if (!(await store.claim({ postId, jobId, attempt }))) {
      const again = await store.load({ jobId: event.jobId, attempt });
      return again?.post.publishAttemptedAt ? { next: "reconcile", waitMs: 0 } : { done: "stale" };
    }
    try {
      const { mediaId } = await api.publishContainer({ igUserId: ok.check.connection.igUserId, accessToken: ok.token, containerId: post.igContainerId });
      await record({ step: "publish", request: { containerId: post.igContainerId }, response: { mediaId }, outcome: "ok" }, post.ownerId);
      return finish(api, ok.token, post.ownerId, mediaId, null);
    } catch (error) {
      if (!(error instanceof InstagramPublishError)) {
        // We don't know what happened at Instagram: never publish again without looking.
        await store.unknown({ postId, jobId });
        throw error;
      }
      const meaning = meaningOf(error);
      await record({ step: "publish", request: { containerId: post.igContainerId }, response: errorFields(error), outcome: meaning === "transient" ? "unknown" : "error" }, post.ownerId);
      if (meaning === "transient") {
        // No clear answer: the reel may be live. Reconcile before anything else.
        await store.unknown({ postId, jobId });
        await store.progress({ jobId, attempt, stage: "reconcile", percent: 90, message: PUBLISH_MESSAGES.CHECKING });
        return { next: "reconcile", waitMs: deps.delays.reconcileMs };
      }
      // A clear refusal: nothing was published, so the claim is released.
      await store.release({ postId, jobId });
      if (meaning === "not_ready") return { next: "poll", waitMs: deps.delays.checkMs };
      return refusal(error, "publish");
    }
  };

  const reconcileStep = async (notPublishedBefore: number): Promise<StepAnswer> => {
    const ready = await prepare();
    if ("done" in ready || "next" in ready) return ready;
    const { ctx, api } = ready;
    const { post } = ctx;
    await store.progress({ jobId, attempt, stage: "reconcile", percent: 92, message: PUBLISH_MESSAGES.CHECKING });
    // Reconcile only READS (it never publishes): any working token of the account the post was approved
    // for will do, even if something else changed since (F30 code review SHOULD 4). The full approval
    // re-check still guards create_container and media_publish.
    const reader = await store.reader(post, now());
    if (!reader) return end("unconfirmed", "reconcile", "No working token for the approved Instagram account");
    let token: string;
    try {
      token = deps.token(reader);
    } catch {
      return end("unconfirmed", "reconcile", "The Instagram token could not be read");
    }
    const igUserId = post.approval.igUserId;
    let statusCode: string | null = null;
    let media: RecentMedia[] | null = null;
    if (post.igContainerId) {
      try {
        statusCode = (await api.containerStatus({ containerId: post.igContainerId, accessToken: token })).statusCode;
      } catch (error) {
        if (!(error instanceof InstagramPublishError)) throw error;
      }
    }
    try {
      media = await api.recentMedia({ igUserId, accessToken: token });
    } catch (error) {
      if (!(error instanceof InstagramPublishError)) throw error;
    }
    const match = findPublishedMedia(post, media, statusCode);
    await record(
      { step: "reconcile", request: { containerId: post.igContainerId }, response: { statusCode, recentMedia: media?.length ?? null, matched: match !== undefined }, outcome: match ? "published" : statusCode ?? "unknown" },
      post.ownerId,
    );
    if (match) return finish(api, token, post.ownerId, match.id, match.permalink);
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      // Instagram never published this container.
      await store.release({ postId, jobId });
      if (statusCode === "EXPIRED") await store.saveContainer({ postId, jobId, containerId: null });
      return end(statusCode === "ERROR" ? "processing_error" : "too_slow", "reconcile", `The container is ${statusCode} and nothing was posted`);
    }
    if (statusCode === "FINISHED" && media !== null) {
      const notPublished = notPublishedBefore + 1;
      if (notPublished >= NOT_PUBLISHED_CHECKS) {
        // Twice: not live and the container still unpublished → publish the SAME container.
        await store.release({ postId, jobId });
        return { next: "publish", waitMs: 0 };
      }
      if (late()) return end("unconfirmed", "reconcile", "Still not sure after about 10 minutes");
      return { next: "reconcile", waitMs: deps.delays.reconcileMs, notPublished };
    }
    if (late()) {
      // PUBLISHED but the media wasn't in the list: it is live; save it without its link.
      if (statusCode === "PUBLISHED") return finish(api, token, post.ownerId, null, null);
      return end("unconfirmed", "reconcile", "Instagram didn't answer clearly for about 10 minutes");
    }
    return { next: "reconcile", waitMs: deps.delays.reconcileMs, notPublished: 0 };
  };

  let phase: Phase = approval.next;
  let notPublished = 0;
  for (let n = 1; n <= MAX_STEPS; n++) {
    const id = `${phase === "container" ? "create_container" : phase}-${n}`;
    const answer: StepAnswer = await step.run(id, () =>
      phase === "container" ? containerStep() : phase === "poll" ? pollStep() : phase === "publish" ? publishStep() : reconcileStep(notPublished),
    );
    if ("done" in answer) return answer.done === "stale" ? "skipped" : answer.done;
    notPublished = answer.next === "reconcile" ? (answer.notPublished ?? notPublished) : 0;
    phase = answer.next;
    if (answer.waitMs > 0) await step.sleep(`wait-${n}`, answer.waitMs);
  }
  await step.run("give-up", () => end(phase === "reconcile" ? "unconfirmed" : "too_slow", phase === "container" ? "create_container" : phase));
  return "failed";
}
