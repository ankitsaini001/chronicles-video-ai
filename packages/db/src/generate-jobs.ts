import { createHash } from "node:crypto";
import { type ClientSession, type Db, ObjectId } from "mongodb";
import { finishIdempotencyInTransaction, type IdempotencyLock } from "./idempotency";
import { isLanguageEnabled, languageUnavailableMessage } from "./languages";
import { getJob, JOBS_COLLECTION, retryEventId, type JobDocument, type JobNeedsInput, type JobStage } from "./jobs";
import { PLAN_VERSIONS_COLLECTION, type PlanVersionDocument, type StoredPlan } from "./plan-versions";
import { assertLanguageEnabled, ProjectActionError, PROJECTS_COLLECTION, type ProjectDocument } from "./projects";
import { RENDER_SCHEMA_VERSION, RENDERS_COLLECTION, latestReadyRenderOf, type RenderDocument } from "./renders";
import { paidSpeechKeys, releaseSpeechClaims } from "./speech-artifacts";
import { APPROVABLE_STATES, findOrCreateApproval, STORYBOARD_APPROVALS_COLLECTION, type StoryboardApprovalBody, type StoryboardApprovalDocument } from "./storyboard-approvals";
import { videosPerDayMessage, voiceCeilingMessage, voiceQuotaMessage } from "./limit-messages";
import { addUsageWithinLimit, APP_USAGE_OWNER_ID, APP_USAGE_TIMEZONE, readUsageCount, usageCounterPeriod, wouldExceed } from "./usage-counters";
import { APP_VOICE_CHARACTERS_PER_MONTH, DEFAULT_TIMEZONE, USAGE_LIMITS } from "./usage";

// The `generate` job: making the video (F23; docs/API.md D8, E2, E3, §8; DATABASE.md §4.9, §7.2).
// - D8 "Approve & generate video" (approveAndGenerate): approval #1 + the queued job in ONE
//   transaction, after the limits in this order: language → videos/day → voice characters (the
//   creator's 3,000 a month, then the app-wide 9,000 a month). Only the narration that is not
//   recorded yet counts: recordings this owner already has are free.
// - F27: the refusals say why and when the limit resets, in the creator's timezone
//   (limit-messages.ts); the storyboard checks the same limits read-only before Approve
//   (approveLimitCheck), and a job stopped by a voice limit fails with the same words.
// - The Inngest worker (apps/web/lib/video/run-generate-job.ts) calls the start/load/progress/
//   finish functions here. Every write is conditional on "this job is still running this attempt".
// - The worker reserves the voice characters of ALL the narration it still has to record in one
//   transaction BEFORE its first ElevenLabs call (reserveVoice), so a video never fails on the limit
//   after narration was paid for. Then EVERY request is counted right before it is sent
//   (reserveVoiceSend): the first request of a recording uses its up-front reservation (once, in the
//   same month); any other request (a provider retry, a Try again after a failed or timed-out call,
//   a changed voice or model, a new month) is counted again, with the same limits. Over-counting a
//   request ElevenLabs didn't bill is fine; nothing is ever refunded.
// - Finishing (succeeded / failed / needs_input / cancelled) is ONE short transaction: job + project
//   (+ the render document on success).

export const GENERATE_STAGES = ["approve", "speech", "compile", "render", "validate"] as const;
export type GenerateStage = (typeof GENERATE_STAGES)[number];
const STAGE_INDEX = Object.fromEntries(GENERATE_STAGES.map((name, i) => [name, i])) as Record<GenerateStage, number>;

/** What the creator reads (API.md §4.3, F23). Shown as is. */
export const GENERATE_MESSAGES = {
  WAITING: "Waiting to start…",
  RECORDING: "Recording narration…",
  TIMING: "Timing animations…",
  CAPTIONS: "Adding captions…",
  RENDERING: "Rendering…",
  CHECKING: "Checking the video…",
  SAVING: "Saving your video…",
  DONE: "Your video is ready.",
  CANCELLED: "Cancelled. Your storyboard and any recorded narration are saved.",
  VOICE_LIMIT: "Voice limit reached this month.",
} as const;

export const recordingMessage = (scene: number, total: number) => `Recording narration · scene ${scene} of ${total}`;
export const renderingMessage = (percent: number) => `Rendering · ${percent}%`;

export type GenerateErrorCode = "PROVIDER_BUSY" | "PROVIDER_UNAVAILABLE" | "RENDER_FAILED" | "QUOTA_EXCEEDED" | "SPEND_CEILING" | "LANGUAGE_UNAVAILABLE" | "APPROVAL_STALE" | "INTERNAL";

/** The error a failed generate job shows, and whether Try again (E2) is offered. */
export const GENERATE_ERRORS: Record<GenerateErrorCode, { message: string; retryable: boolean }> = {
  PROVIDER_BUSY: { message: "Voice service busy. Please try again in a few minutes.", retryable: true },
  PROVIDER_UNAVAILABLE: { message: "Voice service unavailable right now. We've been notified.", retryable: false },
  RENDER_FAILED: { message: "Rendering failed. Your narration is saved, so retrying is quick.", retryable: true },
  // The monthly limits: Try again works again next month (E2 checks the limit first). F27: a job
  // that hits one fails with the full sentence (limitFailureMessage); this short line is the fallback.
  QUOTA_EXCEEDED: { message: GENERATE_MESSAGES.VOICE_LIMIT, retryable: true },
  SPEND_CEILING: { message: GENERATE_MESSAGES.VOICE_LIMIT, retryable: true },
  LANGUAGE_UNAVAILABLE: { message: languageUnavailableMessage(), retryable: false },
  APPROVAL_STALE: { message: "Something changed since you reviewed it. Please review again.", retryable: false },
  INTERNAL: { message: "Something went wrong on our side. Please try again.", retryable: true },
};

/** The job's idempotency key and first event id (DATABASE.md Q6). */
export function generateJobKey(planVersionId: ObjectId): string {
  return `gen:${planVersionId.toHexString()}`;
}

function pendingStages(): JobStage[] {
  return GENERATE_STAGES.map((name) => ({ name, status: "pending" as const, startedAt: null, endedAt: null, attempts: 0, error: null }));
}

const WAITING_PROGRESS = { stage: "approve", percent: 0, message: GENERATE_MESSAGES.WAITING };

/** A new queued generate job (D8). Inserted in the same transaction as the approval. */
export function newGenerateJob(input: { ownerId: ObjectId; projectId: ObjectId; version: Pick<PlanVersionDocument, "_id" | "planHash">; now: Date }): JobDocument {
  const key = generateJobKey(input.version._id);
  return {
    _id: new ObjectId(),
    ownerId: input.ownerId,
    projectId: input.projectId,
    schemaVersion: 1,
    type: "generate",
    inputRef: { planVersionId: input.version._id },
    inputHash: input.version.planHash.replace(/^sha256:/, ""),
    state: "queued",
    attempt: 1,
    stages: pendingStages(),
    progress: WAITING_PROGRESS,
    error: null,
    needsInput: null,
    result: null,
    idempotencyKey: key,
    inngestRunId: null,
    cancelRequestedAt: null,
    event: { id: key, sentAt: null, lastTriedAt: null },
    planner: null,
    voice: { cacheKeys: [], characters: 0, sentKeys: [], period: null },
    render: null,
    queuedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
    startedAt: null,
    finishedAt: null,
  };
}

/** The fields that put an existing generate job back in the queue (D8 again, E2): attempt + 1. */
function requeueFields(job: JobDocument, now: Date): Partial<JobDocument> {
  const attempt = job.attempt + 1;
  return {
    state: "queued",
    attempt,
    stages: pendingStages(),
    progress: WAITING_PROGRESS,
    error: null,
    needsInput: null,
    result: null,
    cancelRequestedAt: null,
    event: { id: retryEventId(job._id, attempt), sentAt: null, lastTriedAt: null },
    render: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  };
}

// ---------- voice characters ----------

/** One recording a plan needs: its speech cache key and the characters it sends to ElevenLabs. */
export type VoiceScene = { cacheKey: string; characters: number };
/** Built by the web app from the plan and the server's voice settings (lib/video/voice.ts). */
export type VoiceEstimator = (plan: StoredPlan) => VoiceScene[];

/**
 * The recordings still to pay for: one per distinct cache key (two scenes with the same words and
 * voice share one recording), without those this owner already has (ready, or a paid answer saved
 * with its audio: free) and those this job reserved and hasn't sent yet in this month (`reserved`,
 * from voiceCredits: a retry never counts twice).
 */
export async function voiceStillNeeded(
  db: Db,
  input: { ownerId: ObjectId; scenes: readonly VoiceScene[]; reserved?: readonly string[] },
  session?: ClientSession,
): Promise<{ items: VoiceScene[]; characters: number }> {
  const unique = new Map<string, number>();
  for (const s of input.scenes) if (!unique.has(s.cacheKey)) unique.set(s.cacheKey, s.characters);
  const ready = new Set(await paidSpeechKeys(db, input.ownerId, [...unique.keys()], session));
  const reserved = new Set(input.reserved ?? []);
  const items = [...unique].filter(([key]) => !ready.has(key) && !reserved.has(key)).map(([cacheKey, characters]) => ({ cacheKey, characters }));
  return { items, characters: items.reduce((sum, i) => sum + i.characters, 0) };
}

/** F26: what a new video of a storyboard would record, scene by scene (the note on the storyboard page). */
export type NarrationCost = {
  /** Scene indexes (from 0) whose narration isn't recorded yet: the new video records it. */
  newScenes: number[];
  /** Scene indexes that reuse a recording this owner already has (no voice characters). */
  reusedScenes: number[];
  /** About how many voice characters the new narration uses (one per distinct recording, as D8 counts). */
  characters: number;
};

/**
 * F26: the cost of a new video, from the SAME rule D8/E2 check the voice limits with
 * (voiceStillNeeded: the owner's recordings by cache key; two scenes with the same words and voice
 * share one recording). `scenes` = the VoiceEstimator's list, one per scene, in scene order. Reads
 * the database only: no provider call.
 */
export async function narrationCost(db: Db, input: { ownerId: ObjectId; scenes: readonly VoiceScene[] }, session?: ClientSession): Promise<NarrationCost> {
  const needed = await voiceStillNeeded(db, { ownerId: input.ownerId, scenes: input.scenes }, session);
  const missing = new Set(needed.items.map((i) => i.cacheKey));
  const newScenes: number[] = [];
  const reusedScenes: number[] = [];
  input.scenes.forEach((scene, index) => (missing.has(scene.cacheKey) ? newScenes : reusedScenes).push(index));
  return { newScenes, reusedScenes, characters: needed.characters };
}

/**
 * Pure: which monthly voice limit would `needed` more characters break? The creator's own limit
 * (3,000) is checked first, then the app-wide guard (9,000, APP_VOICE_CHARACTERS_PER_MONTH).
 * Nothing needed (everything recorded already) never breaks a limit.
 */
export function voiceLimitProblem(input: { needed: number; userUsed: number; appUsed: number; userLimit?: number; appLimit?: number }): "user" | "app" | null {
  if (input.needed <= 0) return null;
  if (input.userUsed + input.needed > (input.userLimit ?? USAGE_LIMITS.voiceCharactersPerMonth)) return "user";
  if (input.appUsed + input.needed > (input.appLimit ?? APP_VOICE_CHARACTERS_PER_MONTH)) return "app";
  return null;
}

/**
 * The refusal for a voice limit (API.md §10.1, §10.2). F27: the message is the full sentence for the
 * creator, with the reset date in `timezone` (the creator's): "This video needs about 1,050 voice
 * characters, but you have 794 left this month. The limit resets on 1 December." / "Video making is
 * paused for everyone until 1 December (…)". The numbers stay in `details`.
 */
export function voiceLimitError(which: "user" | "app", input: { used: number; needed: number; timezone: string; now: Date }): ProjectActionError {
  if (which === "user") {
    const { resetsAt } = usageCounterPeriod("voiceChars", input.timezone, input.now);
    const limit = USAGE_LIMITS.voiceCharactersPerMonth;
    return new ProjectActionError("QUOTA_EXCEEDED", voiceQuotaMessage({ needed: input.needed, used: input.used, limit, resetsAt, timezone: input.timezone }), {
      quota: "voice_characters_per_month",
      limit,
      used: input.used,
      needed: input.needed,
      resetsAt: resetsAt.toISOString(),
    });
  }
  const { resetsAt } = usageCounterPeriod("appVoiceChars", APP_USAGE_TIMEZONE, input.now);
  return new ProjectActionError("SPEND_CEILING", voiceCeilingMessage({ resetsAt, timezone: input.timezone }), { ceiling: "voice_characters_per_month", resetsAt: resetsAt.toISOString() });
}

/**
 * F27: the refusal for videos per day (API.md §10.1): "You've made 3 videos today, the most for one
 * day. You can make more after 12:00 am (midnight) your time." The numbers stay in `details`.
 */
export function videosPerDayError(input: { used: number; limit: number; resetsAt: Date; timezone: string }): ProjectActionError {
  return new ProjectActionError("QUOTA_EXCEEDED", videosPerDayMessage({ limit: input.limit, resetsAt: input.resetsAt, timezone: input.timezone }), {
    quota: "videos_per_day",
    limit: input.limit,
    used: input.used,
    resetsAt: input.resetsAt.toISOString(),
  });
}

/** The months voice characters are counted in: the creator's (their timezone) and the app's (UTC). */
export type VoicePeriod = { user: string; app: string };
export type JobVoice = NonNullable<JobDocument["voice"]>;

export function voicePeriodOf(timezone: string, now: Date): VoicePeriod {
  return { user: usageCounterPeriod("voiceChars", timezone, now).period, app: usageCounterPeriod("appVoiceChars", APP_USAGE_TIMEZONE, now).period };
}

const samePeriod = (a: VoicePeriod | null | undefined, b: VoicePeriod) => a?.user === b.user && a.app === b.app;

/** Pure: the recordings this job reserved and hasn't sent yet, still valid in `period` (else none). */
export function voiceCredits(voice: JobDocument["voice"], period: VoicePeriod): string[] {
  return voice && samePeriod(voice.period, period) ? [...voice.cacheKeys] : [];
}

/**
 * Pure: the up-front reservation (reserveVoice). Every recording still needed gets one credit; those
 * that already have one in this period are not counted again. Credits from another month are dropped
 * (they were counted in that month). Returns what to count and the job's `voice` afterwards.
 */
export function planVoiceReservation(voice: JobDocument["voice"], items: readonly VoiceScene[], period: VoicePeriod): { count: VoiceScene[]; total: number; next: JobVoice } {
  const credits = voiceCredits(voice, period);
  const count = [...new Map(items.filter((i) => !credits.includes(i.cacheKey)).map((i) => [i.cacheKey, i])).values()];
  const total = count.reduce((sum, i) => sum + i.characters, 0);
  return { count, total, next: { cacheKeys: [...credits, ...count.map((i) => i.cacheKey)], characters: (voice?.characters ?? 0) + total, sentKeys: [...(voice?.sentKeys ?? [])], period } };
}

/**
 * Pure: ONE request about to be sent (reserveVoiceSend). It uses the recording's credit when there is
 * one in this period (nothing more counted; the credit is gone); otherwise its characters are counted
 * now. Either way the recording is noted in `sentKeys`.
 */
export function planVoiceSend(voice: JobDocument["voice"], item: VoiceScene, period: VoicePeriod): { count: number; next: JobVoice } {
  const credits = voiceCredits(voice, period);
  const covered = credits.includes(item.cacheKey);
  const sentKeys = [...new Set([...(voice?.sentKeys ?? []), item.cacheKey])];
  if (covered) return { count: 0, next: { cacheKeys: credits.filter((k) => k !== item.cacheKey), characters: voice?.characters ?? 0, sentKeys, period } };
  // No credit: counted now. Credits of another month are dropped (they no longer cover anything).
  return { count: item.characters, next: { cacheKeys: credits, characters: (voice?.characters ?? 0) + item.characters, sentKeys, period } };
}

type VoiceFitInput = { ownerId: ObjectId; timezone: string; scenes: readonly VoiceScene[]; job: JobDocument | null; now: Date };

/**
 * Check (without counting) that the narration still to record fits both monthly limits: the refusal,
 * or null. Read-only. D8/E2 call it in their transaction (assertVoiceFits); the storyboard's pre-check
 * (approveLimitCheck, F27) without one, so both use the very same rule.
 */
export async function voiceRefusal(db: Db, input: VoiceFitInput, session?: ClientSession): Promise<ProjectActionError | null> {
  const reserved = voiceCredits(input.job?.voice, voicePeriodOf(input.timezone, input.now));
  const needed = await voiceStillNeeded(db, { ownerId: input.ownerId, scenes: input.scenes, reserved }, session);
  if (needed.characters === 0) return null;
  const userUsed = await readUsageCount(db, input.ownerId.toHexString(), "voiceChars", input.timezone, input.now, session);
  const appUsed = await readUsageCount(db, APP_USAGE_OWNER_ID, "appVoiceChars", APP_USAGE_TIMEZONE, input.now, session);
  const problem = voiceLimitProblem({ needed: needed.characters, userUsed, appUsed });
  return problem ? voiceLimitError(problem, { used: problem === "user" ? userUsed : appUsed, needed: needed.characters, timezone: input.timezone, now: input.now }) : null;
}

/** voiceRefusal inside a transaction: throws the refusal. */
async function assertVoiceFits(db: Db, session: ClientSession, input: VoiceFitInput): Promise<void> {
  const refusal = await voiceRefusal(db, input, session);
  if (refusal) throw refusal;
}

// ---------- F27: the limits, checked before Approve ----------

/** What approving this exact version would do (D8): show its existing video, queue its job again, or start a new one. */
export type ApprovePath = "reuse" | "requeue" | "new";

/**
 * F27 (decision 2): would D8 refuse this exact version because of a LIMIT right now? Read-only
 * (nothing counted, no provider call), with the SAME functions and order as D8:
 * - its `gen:` job succeeded and its video is ready → `reuse`: approving costs nothing, never refused;
 * - it has a job (failed, cancelled: D8 queues the same job again) → `requeue`: no videos/day count;
 * - no job yet → `new`: videos/day first (wouldExceed, the rule addUsageWithinLimit counts with);
 * then, for both queue paths, the voice characters still needed (voiceRefusal, as assertVoiceFits).
 * `scenes` null (the voice isn't set up here): the voice part is skipped (D8 then answers 500).
 * D8 still checks everything in its transaction; this only warns earlier.
 */
export async function approveLimitCheck(
  db: Db,
  input: { ownerId: ObjectId; projectId: ObjectId; planVersionId: ObjectId; timezone: string; scenes: readonly VoiceScene[] | null; now?: Date },
): Promise<{ path: ApprovePath; refusal: ProjectActionError | null }> {
  const now = input.now ?? new Date();
  const existing = await db.collection<JobDocument>(JOBS_COLLECTION).findOne({ idempotencyKey: generateJobKey(input.planVersionId), ownerId: input.ownerId });
  if (existing?.state === "succeeded" && (await latestReadyRenderOf(db, { ownerId: input.ownerId, projectId: input.projectId, planVersionId: input.planVersionId }))) {
    return { path: "reuse", refusal: null };
  }
  const path: ApprovePath = existing ? "requeue" : "new";
  if (path === "new") {
    const used = await readUsageCount(db, input.ownerId.toHexString(), "videos", input.timezone, now);
    if (wouldExceed(used, 1, USAGE_LIMITS.videosPerDay)) {
      const { resetsAt } = usageCounterPeriod("videos", input.timezone, now);
      return { path, refusal: videosPerDayError({ used, limit: USAGE_LIMITS.videosPerDay, resetsAt, timezone: input.timezone }) };
    }
  }
  if (!input.scenes) return { path, refusal: null };
  return { path, refusal: await voiceRefusal(db, { ownerId: input.ownerId, timezone: input.timezone, scenes: input.scenes, job: existing, now }) };
}

// ---------- D8: approve & generate ----------

export type ApproveAndGenerateResult = {
  /** `queued`: a new or re-queued job (202). `reused`: this exact version already has a video (200). */
  kind: "queued" | "reused";
  approval: StoryboardApprovalDocument;
  job: JobDocument;
  project: ProjectDocument;
};

/**
 * D8 (API.md D8, §9; DATABASE.md §7.2 row 6), ONE transaction. Checks, in this order: the project
 * (404), archived, the LANGUAGE switch (422, before anything is counted), a job running, the
 * stateVersion, the state, the exact version (current, same hash, valid). Then:
 * - this version already has a finished video (its `gen:` job succeeded): no job, no limits; the
 *   project points back to that video (`video_ready`) → `reused`;
 * - its job failed (with a retryable error, as for E2) or was cancelled: the SAME job is queued again
 *   (attempt + 1), no videos/day count;
 * - no job yet (also an approval made in F20): a new job, +1 on today's videos (3 a day).
 * Both queue paths check the voice characters still needed (creator 3,000/month, app 9,000/month).
 * The approval reuses this version's row when it has one (unique per version), else it is created.
 * Project → `generating`, `approvedPlanVersionId`, `activeJobId`, +1 stateVersion. The Inngest event
 * is sent by the caller AFTER the commit.
 */
export async function approveAndGenerate(
  db: Db,
  input: {
    ownerId: string;
    projectId: string;
    timezone: string;
    body: StoryboardApprovalBody;
    voice: VoiceEstimator;
    idempotencyLock?: IdempotencyLock | null;
    respond: (out: ApproveAndGenerateResult) => { status: number; body: unknown };
    now?: Date;
  },
): Promise<ApproveAndGenerateResult> {
  const now = input.now ?? new Date();
  const { body } = input;
  const session = db.client.startSession();
  let result: ApproveAndGenerateResult | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const project =
        /^[0-9a-f]{24}$/.test(input.projectId) && /^[0-9a-f]{24}$/.test(input.ownerId)
          ? await projects.findOne({ _id: new ObjectId(input.projectId), ownerId: new ObjectId(input.ownerId) }, { session })
          : null;
      if (!project) throw new ProjectActionError("NOT_FOUND", "We couldn't find this project.");
      if (project.state === "archived") throw new ProjectActionError("INVALID_STATE", "This project is archived.", { state: project.state });
      assertLanguageEnabled(project.language);
      if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.", { activeJobId: project.activeJobId.toHexString() });
      if (project.stateVersion !== body.expectedStateVersion) {
        throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.", { expectedStateVersion: body.expectedStateVersion, currentStateVersion: project.stateVersion });
      }
      if (!APPROVABLE_STATES.includes(project.state) || !project.currentPlanVersionId) {
        throw new ProjectActionError("INVALID_STATE", "This storyboard can't be approved right now.", { state: project.state });
      }
      const current = project.currentPlanVersionId.toHexString();
      if (body.planVersionId !== current) {
        throw new ProjectActionError("APPROVAL_STALE", "Something changed since you reviewed it. Please review again.", { reason: "not_current", currentPlanVersionId: current });
      }
      const version = await db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: project.currentPlanVersionId, projectId: project._id, ownerId: project.ownerId }, { session });
      if (!version) throw new Error(`Project ${project._id.toHexString()} points to a missing plan version.`);
      if (version.planHash !== body.planHash) {
        throw new ProjectActionError("APPROVAL_STALE", "Something changed since you reviewed it. Please review again.", { reason: "plan_hash_mismatch", currentPlanVersionId: current });
      }
      if (!version.validation.valid) throw new ProjectActionError("PLAN_INVALID", "Some scenes need fixing before you can approve.", { issues: version.validation.issues });

      const existing = await jobs.findOne({ idempotencyKey: generateJobKey(version._id), ownerId: project.ownerId }, { session });
      if (existing && (existing.state === "queued" || existing.state === "running")) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.");
      if (existing?.state === "needs_input") {
        throw new ProjectActionError("INVALID_STATE", "Please change the storyboard first.", { reason: "needs_input", message: existing.needsInput?.message ?? null });
      }
      // Like E2: a failure that can't be retried as it is (e.g. the voice service refused) needs a storyboard change.
      if (existing?.state === "failed" && existing.error?.retryable !== true) {
        throw new ProjectActionError("INVALID_STATE", "This step can't be retried. Please edit your storyboard instead.", { jobState: existing.state, retryable: false });
      }

      // This exact version already has a finished video (e.g. after an undo): point back to it.
      if (existing?.state === "succeeded") {
        const render = await latestReadyRenderOf(db, { ownerId: project.ownerId, projectId: project._id, planVersionId: version._id }, session);
        if (render) {
          const approval = await findOrCreateApproval(db, session, project, version, now);
          const moved = await projects.findOneAndUpdate(
            { _id: project._id, stateVersion: project.stateVersion, activeJobId: null, currentPlanVersionId: version._id },
            { $set: { state: "video_ready", approvedPlanVersionId: version._id, currentRenderId: render._id, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
            { session, returnDocument: "after" },
          );
          if (!moved) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
          result = { kind: "reused", approval, job: existing, project: moved };
          if (input.idempotencyLock) {
            const answer = input.respond(result);
            await finishIdempotencyInTransaction(db, input.idempotencyLock, answer.status, answer.body, session);
          }
          return;
        }
      }

      // Limits, in order: (language: above) → videos/day (new job only) → voice characters.
      if (!existing) {
        const counted = await addUsageWithinLimit(db, session, { ownerId: input.ownerId, kind: "videos", timezone: input.timezone, limit: USAGE_LIMITS.videosPerDay, now });
        if (!counted.ok) throw videosPerDayError({ used: counted.used, limit: counted.limit, resetsAt: counted.resetsAt, timezone: input.timezone });
      }
      await assertVoiceFits(db, session, { ownerId: project.ownerId, timezone: input.timezone, scenes: input.voice(version.plan), job: existing, now });

      const approval = await findOrCreateApproval(db, session, project, version, now);
      let job: JobDocument;
      if (existing) {
        const requeued = await jobs.findOneAndUpdate({ _id: existing._id, attempt: existing.attempt, state: existing.state }, { $set: requeueFields(existing, now) }, { session, returnDocument: "after" });
        if (!requeued) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
        job = requeued;
      } else {
        job = newGenerateJob({ ownerId: project.ownerId, projectId: project._id, version, now });
        await jobs.insertOne(job, { session });
      }
      const moved = await projects.findOneAndUpdate(
        { _id: project._id, stateVersion: project.stateVersion, activeJobId: null, currentPlanVersionId: version._id },
        // currentRenderId is kept: an older video stays the project's video until the new one is ready.
        { $set: { state: "generating", approvedPlanVersionId: version._id, activeJobId: job._id, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session, returnDocument: "after" },
      );
      if (!moved) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      result = { kind: "queued", approval, job, project: moved };
      if (input.idempotencyLock) {
        const answer = input.respond(result);
        await finishIdempotencyInTransaction(db, input.idempotencyLock, answer.status, answer.body, session);
      }
    });
  } finally {
    await session.endSession();
  }
  return result!;
}

// ---------- E2: Try again ----------

/** May this generate job be retried as it is (E2)? Only a failure whose error is retryable. */
export function canRetryGenerateJob(job: JobDocument): boolean {
  return job.type === "generate" && job.state === "failed" && job.error?.retryable === true;
}

/**
 * E2 on a failed generate job (API.md E2, §8.4), ONE transaction: language first (422), archived,
 * a job running, retryable, the storyboard approval still matches (else 409 APPROVAL_REQUIRED), the
 * voice characters still needed fit (recordings already made are reused for free). The same job goes
 * back to `queued` (attempt + 1); project → `generating`. Never counts toward videos/day again.
 */
export async function retryGenerateJob(
  db: Db,
  input: { ownerId: string; jobId: string; timezone: string; voice: VoiceEstimator; idempotencyLock?: IdempotencyLock | null; respond: (job: JobDocument) => { status: number; body: unknown }; now?: Date },
): Promise<JobDocument> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.jobId) || !/^[0-9a-f]{24}$/.test(input.ownerId)) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
  const ownerId = new ObjectId(input.ownerId);
  const session = db.client.startSession();
  let result: JobDocument | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const job = await jobs.findOne({ _id: new ObjectId(input.jobId), ownerId, type: "generate" }, { session });
      if (!job) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
      const project = await projects.findOne({ _id: job.projectId, ownerId }, { session });
      if (!project) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
      assertLanguageEnabled(project.language);
      if (project.state === "archived") throw new ProjectActionError("INVALID_STATE", "This project is archived.", { state: project.state });
      if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.");
      if (!canRetryGenerateJob(job)) {
        throw new ProjectActionError("INVALID_STATE", "This step can't be retried. Please edit your storyboard instead.", { jobState: job.state, retryable: job.error?.retryable ?? false });
      }
      const planVersionId = job.inputRef.planVersionId;
      if (!planVersionId || !project.currentPlanVersionId?.equals(planVersionId) || !project.approvedPlanVersionId?.equals(planVersionId)) {
        throw new ProjectActionError("APPROVAL_REQUIRED", "Your storyboard changed since you approved it. Please approve it again.", { currentPlanVersionId: project.currentPlanVersionId?.toHexString() ?? null });
      }
      const version = await db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: planVersionId, projectId: project._id, ownerId }, { session });
      if (!version) throw new ProjectActionError("APPROVAL_REQUIRED", "Your storyboard changed since you approved it. Please approve it again.");
      await assertVoiceFits(db, session, { ownerId, timezone: input.timezone, scenes: input.voice(version.plan), job, now });
      const moved = await projects.updateOne(
        { _id: project._id, activeJobId: null, stateVersion: project.stateVersion },
        { $set: { state: "generating", activeJobId: job._id, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      if (moved.matchedCount !== 1) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      const updated = await jobs.findOneAndUpdate({ _id: job._id, attempt: job.attempt, state: job.state }, { $set: requeueFields(job, now) }, { session, returnDocument: "after" });
      if (!updated) throw new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.");
      if (input.idempotencyLock) {
        const answer = input.respond(updated);
        await finishIdempotencyInTransaction(db, input.idempotencyLock, answer.status, answer.body, session);
      }
      result = updated;
    });
  } finally {
    await session.endSession();
  }
  return result!;
}

// ---------- E3: Cancel ----------

/**
 * E3 Cancel (API.md E3, F23: generate jobs). A job still waiting for its turn is cancelled at once
 * (nothing ran); a running one gets `cancelRequestedAt` and stops before its next step, or within a
 * few seconds while rendering (the worker passes Remotion's cancel signal). Characters already
 * spent stay counted. Calling it again is harmless. Returns the job as it is now.
 */
export async function cancelGenerateJob(db: Db, input: { ownerId: string; jobId: string; now?: Date }): Promise<JobDocument> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.jobId) || !/^[0-9a-f]{24}$/.test(input.ownerId)) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
  const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
  const job = await jobs.findOne({ _id: new ObjectId(input.jobId), ownerId: new ObjectId(input.ownerId) });
  if (!job) throw new ProjectActionError("NOT_FOUND", "We couldn't find this job.");
  if (job.type !== "generate") throw new ProjectActionError("INVALID_STATE", "This step can't be cancelled.", { jobType: job.type });
  if (job.state !== "queued" && job.state !== "running") throw new ProjectActionError("INVALID_STATE", "This job has already finished.", { jobState: job.state });
  if (job.state === "queued" && (await endGenerateJob(db, { jobId: job._id, attempt: job.attempt, outcome: "cancelled", onlyIfQueued: true, now }))) {
    return (await getJob(db, job._id)) ?? job;
  }
  await jobs.updateOne({ _id: job._id, state: { $in: ["queued", "running"] }, cancelRequestedAt: null }, { $set: { cancelRequestedAt: now, updatedAt: now } });
  return (await getJob(db, job._id)) ?? job;
}

// ---------- the worker ----------

export type GenerateJobContext = { job: JobDocument; project: ProjectDocument; version: PlanVersionDocument };

/**
 * The run's first step: the job becomes `running` for this attempt. Null when there is nothing to do
 * (finished, a newer attempt, the project no longer waits for it). Ends the job at once when Cancel
 * was pressed, when the language is switched off (LANGUAGE_UNAVAILABLE, before any voice call), or
 * when the approved version is no longer the one the job was made for (APPROVAL_STALE).
 */
export async function startGenerateAttempt(db: Db, input: { jobId: string; attempt: number; runId?: string | null; now?: Date }): Promise<GenerateJobContext | null> {
  const now = input.now ?? new Date();
  if (!/^[0-9a-f]{24}$/.test(input.jobId)) return null;
  const job = await getJob(db, new ObjectId(input.jobId));
  if (!job || job.type !== "generate" || job.attempt !== input.attempt || (job.state !== "queued" && job.state !== "running")) return null;
  const project = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: job.projectId, ownerId: job.ownerId });
  if (!project || !project.activeJobId?.equals(job._id) || project.state !== "generating") return null;
  if (job.cancelRequestedAt) {
    await endGenerateJob(db, { jobId: job._id, attempt: job.attempt, outcome: "cancelled", now });
    return null;
  }
  if (!isLanguageEnabled(project.language)) {
    await endGenerateJob(db, { jobId: job._id, attempt: job.attempt, outcome: "failed", code: "LANGUAGE_UNAVAILABLE", now });
    return null;
  }
  const planVersionId = job.inputRef.planVersionId;
  const version = planVersionId ? await db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: planVersionId, projectId: project._id, ownerId: job.ownerId }) : null;
  const approval = version ? await db.collection<StoryboardApprovalDocument>(STORYBOARD_APPROVALS_COLLECTION).findOne({ planVersionId: version._id, ownerId: job.ownerId }) : null;
  if (!version || !approval || approval.planHash !== version.planHash || !project.approvedPlanVersionId?.equals(version._id) || !project.currentPlanVersionId?.equals(version._id)) {
    await endGenerateJob(db, { jobId: job._id, attempt: job.attempt, outcome: "failed", code: "APPROVAL_STALE", now });
    return null;
  }
  const updated = await db.collection<JobDocument>(JOBS_COLLECTION).findOneAndUpdate(
    { _id: job._id, attempt: input.attempt, state: { $in: ["queued", "running"] } },
    {
      $set: {
        state: "running",
        startedAt: job.startedAt ?? now,
        "stages.0.status": "succeeded",
        "stages.0.startedAt": job.stages[0]?.startedAt ?? now,
        "stages.0.endedAt": now,
        "stages.0.attempts": 1,
        "stages.1.status": "running",
        "stages.1.startedAt": job.stages[1]?.startedAt ?? now,
        progress: { stage: "speech", percent: 5, message: GENERATE_MESSAGES.RECORDING },
        ...(input.runId ? { inngestRunId: input.runId } : {}),
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  return updated ? { job: updated, project, version } : null;
}

/** Read-only: the job, project and version while the job is running this attempt (else null). */
export async function loadGenerateAttempt(db: Db, input: { jobId: string; attempt: number }): Promise<GenerateJobContext | null> {
  if (!/^[0-9a-f]{24}$/.test(input.jobId)) return null;
  const job = await getJob(db, new ObjectId(input.jobId));
  if (!job || job.type !== "generate" || job.state !== "running" || job.attempt !== input.attempt || !job.inputRef.planVersionId) return null;
  const project = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: job.projectId, ownerId: job.ownerId, activeJobId: job._id });
  if (!project) return null;
  const version = await db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: job.inputRef.planVersionId, projectId: project._id, ownerId: job.ownerId });
  return version ? { job, project, version } : null;
}

/** The creator's timezone (their monthly voice limit is counted in it). */
export async function ownerTimezone(db: Db, ownerId: ObjectId, session?: ClientSession): Promise<string> {
  const user = await db.collection<{ _id: ObjectId; timezone?: string }>("user").findOne({ _id: ownerId }, { projection: { timezone: 1 }, ...(session ? { session } : {}) });
  return typeof user?.timezone === "string" && user.timezone ? user.timezone : DEFAULT_TIMEZONE;
}

/**
 * F27 (decision 3): a video job stopped by a monthly voice limit fails with the SAME sentence D8/E2
 * would answer (voiceLimitError), in the creator's timezone. `needed`: the characters the refused
 * count asked for. Without it (e.g. ElevenLabs refused on its own: SPEND_CEILING from the provider)
 * the app's sentence still works; the creator's falls back to "Voice limit reached this month.".
 */
async function limitFailureMessage(db: Db, session: ClientSession, input: { ownerId: ObjectId; code: "QUOTA_EXCEEDED" | "SPEND_CEILING"; needed?: number; now: Date }): Promise<string> {
  const timezone = await ownerTimezone(db, input.ownerId, session);
  if (input.code === "SPEND_CEILING") return voiceLimitError("app", { used: 0, needed: input.needed ?? 0, timezone, now: input.now }).message;
  if (input.needed === undefined) return GENERATE_ERRORS.QUOTA_EXCEEDED.message;
  const used = await readUsageCount(db, input.ownerId.toHexString(), "voiceChars", timezone, input.now, session);
  return voiceLimitError("user", { used, needed: input.needed, timezone, now: input.now }).message;
}

class VoiceLimitReached extends Error {
  constructor(readonly which: "quota" | "ceiling") {
    super(which);
  }
}

export type VoiceReservation = "ok" | "quota" | "ceiling" | "stale" | "cancelled";

/**
 * Count voice characters in ONE transaction on both counters (the creator's month and the app's
 * month) and save the job's new `voice`, only while the job runs this attempt. Two runs at the same
 * moment both write the job document, so MongoDB lets one commit and re-runs the other, which then
 * sees the first one's change (a credit can be used only once).
 * "quota" = the creator's 3,000; "ceiling" = the app's 9,000; "cancelled" = Cancel was pressed (no
 * request is sent after Cancel, not even a provider retry); nothing is counted then.
 */
async function countVoice(
  db: Db,
  input: { jobId: ObjectId; attempt: number; timezone: string; now: Date },
  plan: (job: JobDocument, period: VoicePeriod) => { total: number; next: JobVoice },
): Promise<VoiceReservation> {
  const session = db.client.startSession();
  let outcome: VoiceReservation = "stale";
  try {
    await session.withTransaction(async () => {
      outcome = "stale";
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = await jobs.findOne({ _id: input.jobId, attempt: input.attempt, state: "running" }, { session });
      if (!job) return;
      if (job.cancelRequestedAt) {
        outcome = "cancelled";
        return;
      }
      const { total, next } = plan(job, voicePeriodOf(input.timezone, input.now));
      if (total > 0) {
        const user = await addUsageWithinLimit(db, session, { ownerId: job.ownerId.toHexString(), kind: "voiceChars", timezone: input.timezone, limit: USAGE_LIMITS.voiceCharactersPerMonth, amount: total, now: input.now });
        if (!user.ok) throw new VoiceLimitReached("quota");
        const app = await addUsageWithinLimit(db, session, { ownerId: APP_USAGE_OWNER_ID, kind: "appVoiceChars", timezone: APP_USAGE_TIMEZONE, limit: APP_VOICE_CHARACTERS_PER_MONTH, amount: total, now: input.now });
        if (!app.ok) throw new VoiceLimitReached("ceiling");
      }
      await jobs.updateOne({ _id: job._id, attempt: input.attempt, state: "running" }, { $set: { voice: next, updatedAt: input.now } }, { session });
      outcome = "ok";
    });
  } catch (error) {
    if (error instanceof VoiceLimitReached) return error.which;
    throw error;
  } finally {
    await session.endSession();
  }
  return outcome;
}

/**
 * The up-front reservation, BEFORE the first ElevenLabs call: every recording still needed (`items`:
 * not ready, no saved paid answer) gets one credit, counted now; recordings that already have a
 * credit in this month are not counted again (planVoiceReservation).
 */
export async function reserveVoice(db: Db, input: { jobId: ObjectId; attempt: number; items: readonly VoiceScene[]; timezone: string; now?: Date }): Promise<VoiceReservation> {
  return countVoice(db, { ...input, now: input.now ?? new Date() }, (job, period) => planVoiceReservation(job.voice, input.items, period));
}

/**
 * Right before EVERY ElevenLabs request (each attempt, retries included): use the recording's credit,
 * or count the request now with the same limits (planVoiceSend). Not "ok" = do not send it
 * ("cancelled": Cancel was pressed; the worker ends the job as cancelled).
 */
export async function reserveVoiceSend(db: Db, input: { jobId: ObjectId; attempt: number; item: VoiceScene; timezone: string; now?: Date }): Promise<VoiceReservation> {
  return countVoice(db, { ...input, now: input.now ?? new Date() }, (job, period) => {
    const planned = planVoiceSend(job.voice, input.item, period);
    return { total: planned.count, next: planned.next };
  });
}

/**
 * Progress while the job runs (only this attempt). `stages` moves stages along (by name). Returns
 * whether Cancel was pressed meanwhile (the worker then stops), or null when the job is no longer
 * running this attempt. Every call also keeps `updatedAt` fresh (the stuck-job rule's heartbeat).
 */
export async function setGenerateProgress(
  db: Db,
  input: { jobId: ObjectId; attempt: number; stage: GenerateStage; percent: number; message: string; stages?: Partial<Record<GenerateStage, "running" | "succeeded">>; now?: Date },
): Promise<{ cancelRequested: boolean } | null> {
  const now = input.now ?? new Date();
  const set: Record<string, unknown> = { progress: { stage: input.stage, percent: Math.max(0, Math.min(100, Math.round(input.percent))), message: input.message }, updatedAt: now };
  for (const [name, status] of Object.entries(input.stages ?? {}) as [GenerateStage, "running" | "succeeded"][]) {
    const i = STAGE_INDEX[name];
    set[`stages.${i}.status`] = status;
    if (status === "running") set[`stages.${i}.startedAt`] = now;
    else set[`stages.${i}.endedAt`] = now;
    if (status === "running") set[`stages.${i}.attempts`] = 1;
  }
  const job = await db
    .collection<JobDocument>(JOBS_COLLECTION)
    .findOneAndUpdate({ _id: input.jobId, attempt: input.attempt, state: "running" }, { $set: set }, { returnDocument: "after", projection: { cancelRequestedAt: 1 } });
  return job ? { cancelRequested: job.cancelRequestedAt !== null && job.cancelRequestedAt !== undefined } : null;
}

/** The render attempt starts: a NEW renderId (its own R2 folder), the narration stage is done. */
export async function beginRender(db: Db, input: { jobId: ObjectId; attempt: number; renderId: ObjectId; now?: Date }): Promise<{ cancelRequested: boolean } | null> {
  const now = input.now ?? new Date();
  const job = await db.collection<JobDocument>(JOBS_COLLECTION).findOneAndUpdate(
    { _id: input.jobId, attempt: input.attempt, state: "running" },
    {
      $set: {
        render: { renderId: input.renderId, startedAt: now },
        "stages.1.status": "succeeded",
        "stages.1.endedAt": now,
        "stages.2.status": "running",
        "stages.2.startedAt": now,
        "stages.2.attempts": 1,
        "stages.3.status": "pending",
        "stages.4.status": "pending",
        progress: { stage: "compile", percent: 40, message: GENERATE_MESSAGES.TIMING },
        updatedAt: now,
      },
    },
    { returnDocument: "after", projection: { cancelRequestedAt: 1 } },
  );
  return job ? { cancelRequested: Boolean(job.cancelRequestedAt) } : null;
}

/** What the worker saves when the video is ready (the files are already in R2). */
export interface RenderToSave {
  renderId: ObjectId;
  speech: { sceneId: string; speechArtifactId: ObjectId }[];
  keys: { timeline: string; captions: string; mp4: string; thumbnail: string; qa: string };
  mp4Sha256: string;
  qa: Record<string, unknown>;
  metrics: RenderDocument["metrics"];
  cacheKeys: string[];
  music: boolean;
}

/**
 * sha256 of what went into the video: the plan, the recordings and the music switch, and (F25) the
 * caption fixes. Without fixes the hash is exactly the F23 one.
 */
export function renderInputHash(input: { planHash: string; cacheKeys: readonly string[]; music: boolean; captionOverrides?: readonly { sceneId: string; phraseIndex: number; text: string }[] }): string {
  const parts: unknown[] = [input.planHash, [...input.cacheKeys], input.music];
  if (input.captionOverrides?.length) parts.push(input.captionOverrides.map((o) => [o.sceneId, o.phraseIndex, o.text]));
  return `sha256:${createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex")}`;
}

/**
 * The video is ready (DATABASE.md §7.2 #18), ONE transaction: insert the render (`ready`, the next
 * video number), project → `video_ready` with `currentRenderId`, `activeJobId` cleared, +1
 * stateVersion; job → `succeeded` with `result.renderId`. False when the job no longer runs this attempt.
 */
export async function completeGenerateJob(db: Db, input: { jobId: ObjectId; attempt: number; render: RenderToSave; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let saved = false;
  try {
    await session.withTransaction(async () => {
      saved = false;
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = await jobs.findOne({ _id: input.jobId, attempt: input.attempt, state: "running" }, { session });
      if (!job?.inputRef.planVersionId || !job.render?.renderId.equals(input.render.renderId)) return;
      const projects = db.collection<ProjectDocument>(PROJECTS_COLLECTION);
      const project = await projects.findOne({ _id: job.projectId, ownerId: job.ownerId, activeJobId: job._id }, { session });
      if (!project) return;
      const version = await db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION).findOne({ _id: job.inputRef.planVersionId, ownerId: job.ownerId }, { session, projection: { planHash: 1 } });
      if (!version) return;
      const renders = db.collection<RenderDocument>(RENDERS_COLLECTION);
      const last = await renders.findOne({ projectId: project._id }, { session, sort: { renderNumber: -1 }, projection: { renderNumber: 1 } });
      const { render } = input;
      await renders.insertOne(
        {
          _id: render.renderId,
          ownerId: job.ownerId,
          projectId: project._id,
          schemaVersion: RENDER_SCHEMA_VERSION,
          planVersionId: job.inputRef.planVersionId,
          planHash: version.planHash,
          renderNumber: (last?.renderNumber ?? 0) + 1,
          speech: render.speech,
          captionOverrideSetId: null,
          timelineKey: render.keys.timeline,
          captionsKey: render.keys.captions,
          mp4Key: render.keys.mp4,
          thumbnailKey: render.keys.thumbnail,
          qaKey: render.keys.qa,
          previewFrameKeys: [],
          renderInputHash: renderInputHash({ planHash: version.planHash, cacheKeys: render.cacheKeys, music: render.music }),
          mp4Sha256: render.mp4Sha256,
          qa: render.qa,
          status: "ready",
          metrics: render.metrics,
          error: null,
          createdAt: job.render.startedAt,
          readyAt: now,
        },
        { session },
      );
      await projects.updateOne(
        { _id: project._id, activeJobId: job._id },
        { $set: { state: "video_ready", currentRenderId: render.renderId, activeJobId: null, lastError: null, updatedAt: now }, $inc: { stateVersion: 1 } },
        { session },
      );
      await jobs.updateOne(
        { _id: job._id, attempt: input.attempt, state: "running" },
        {
          $set: {
            state: "succeeded",
            stages: job.stages.map((s) => ({ ...s, status: "succeeded" as const, startedAt: s.startedAt ?? now, endedAt: s.endedAt ?? now, attempts: Math.max(1, s.attempts), error: null })),
            progress: { stage: "validate", percent: 100, message: GENERATE_MESSAGES.DONE },
            error: null,
            result: { planVersionId: job.inputRef.planVersionId, renderId: render.renderId },
            finishedAt: now,
            updatedAt: now,
          },
        },
        { session },
      );
      saved = true;
    });
  } finally {
    await session.endSession();
  }
  return saved;
}

/**
 * The job ends without a video (DATABASE.md §7.2 #18), ONE transaction (API.md §8.3):
 * - `failed`: job failed with the plain error (retryable per GENERATE_ERRORS); project →
 *   `generate_failed` with `lastError`;
 * - `needs_input`: the storyboard must change (video outside 60–90 s, words that can't be timed);
 *   project → `storyboard_ready` with `lastError` NEEDS_INPUT; the approval is kept;
 * - `cancelled`: project → `storyboard_ready` (approval kept: "Generate video" queues the same job).
 * In every case `activeJobId` is cleared, an older video stays the project's video (`currentRenderId`
 * untouched) and the job's pending speech claims are released (saved answers and bytes kept). Only
 * while the job is queued/running (and the given attempt; for the stuck-job rule: not updated since
 * `staleBefore` / queued since `queuedBefore`). False = nothing changed.
 * `detail` is shown in the job's stage error (E1/C6): ONLY a fixed plain line written by our code,
 * never a provider's text, a stack trace or a link (those go to the server log).
 * F27: a QUOTA_EXCEEDED / SPEND_CEILING failure says why and when it resets (limitFailureMessage;
 * `needed` = the characters the refused count asked for).
 */
export async function endGenerateJob(
  db: Db,
  input: {
    jobId: ObjectId;
    attempt?: number;
    outcome: "failed" | "needs_input" | "cancelled";
    code?: GenerateErrorCode;
    stage?: GenerateStage;
    detail?: string;
    needed?: number;
    needsInput?: JobNeedsInput;
    staleBefore?: Date;
    queuedBefore?: Date;
    onlyIfQueued?: boolean;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let ended = false;
  try {
    await session.withTransaction(async () => {
      ended = false;
      const filter = {
        _id: input.jobId,
        type: "generate" as const,
        state: { $in: (input.onlyIfQueued ? ["queued"] : ["queued", "running"]) as JobDocument["state"][] },
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        ...(input.staleBefore ? { updatedAt: { $lt: input.staleBefore } } : {}),
        ...(input.queuedBefore ? { state: "queued" as const, queuedAt: { $lt: input.queuedBefore } } : {}),
      };
      const jobs = db.collection<JobDocument>(JOBS_COLLECTION);
      const job = await jobs.findOne(filter, { session });
      if (!job) return;
      const runningStage = job.stages.find((s) => s.status === "running")?.name as GenerateStage | undefined;
      const stageName = input.stage ?? runningStage ?? "approve";
      let set: Partial<JobDocument>;
      let projectSet: Partial<ProjectDocument>;
      if (input.outcome === "failed") {
        const code = input.code ?? "INTERNAL";
        const { retryable } = GENERATE_ERRORS[code];
        const message =
          code === "QUOTA_EXCEEDED" || code === "SPEND_CEILING"
            ? await limitFailureMessage(db, session, { ownerId: job.ownerId, code, ...(input.needed !== undefined ? { needed: input.needed } : {}), now })
            : GENERATE_ERRORS[code].message;
        const stageError = { code, message: (input.detail ?? message).slice(0, 300) };
        set = {
          state: "failed",
          stages: job.stages.map((s) => (s.name === stageName ? { ...s, status: "failed" as const, startedAt: s.startedAt ?? now, endedAt: now, error: stageError } : s)),
          progress: { ...job.progress, message },
          error: { code, message, retryable },
        };
        projectSet = { state: "generate_failed", lastError: { code, message, at: now } };
      } else if (input.outcome === "needs_input") {
        const needsInput = input.needsInput ?? { reason: "alignment_uncertain" as const, message: "Please adjust the wording of your storyboard.", sceneId: null };
        set = {
          state: "needs_input",
          stages: job.stages.map((s) => (s.name === stageName ? { ...s, status: "failed" as const, endedAt: now, error: { code: "NEEDS_INPUT", message: needsInput.message.slice(0, 300) } } : s)),
          progress: { ...job.progress, message: needsInput.message },
          needsInput,
          error: null,
        };
        projectSet = { state: "storyboard_ready", lastError: { code: "NEEDS_INPUT", message: needsInput.message, at: now } };
      } else {
        set = {
          state: "cancelled",
          stages: job.stages.map((s) => (s.status === "running" || s.status === "pending" ? { ...s, status: "cancelled" as const, endedAt: s.status === "running" ? now : s.endedAt } : s)),
          progress: { ...job.progress, message: GENERATE_MESSAGES.CANCELLED },
          error: { code: "CANCELLED", message: GENERATE_MESSAGES.CANCELLED, retryable: false },
        };
        projectSet = { state: "storyboard_ready", lastError: null };
      }
      await jobs.updateOne({ _id: job._id, attempt: job.attempt, state: job.state }, { $set: { ...set, render: null, finishedAt: now, updatedAt: now } }, { session });
      await db
        .collection<ProjectDocument>(PROJECTS_COLLECTION)
        .updateOne({ _id: job.projectId, activeJobId: job._id }, { $set: { ...projectSet, activeJobId: null, updatedAt: now }, $inc: { stateVersion: 1 } }, { session });
      await releaseSpeechClaims(db, { ownerId: job.ownerId, jobId: job._id, now }, session);
      ended = true;
    });
  } finally {
    await session.endSession();
  }
  return ended;
}

// ---------- the queue (one video at a time) ----------

/**
 * The jobs that render a video and share the ONE render queue (Inngest VIDEO_CONCURRENCY): making a
 * video (`generate`, F23) and re-rendering it after caption fixes (`caption`, F25).
 */
export const VIDEO_JOB_TYPES: readonly JobDocument["type"][] = ["generate", "caption"];

/** How many other video jobs are being made or wait before this one (shown as "Waiting to start…"). */
export async function generateJobsAhead(db: Db, job: Pick<JobDocument, "_id" | "queuedAt">): Promise<number> {
  return db.collection<JobDocument>(JOBS_COLLECTION).countDocuments({
    type: { $in: [...VIDEO_JOB_TYPES] },
    _id: { $ne: job._id },
    $or: [{ state: "running" }, { state: "queued", queuedAt: { $lt: job.queuedAt } }],
  });
}

/** When any OTHER video job (generate or caption) last moved (progress, start, finish), or null: the queue's heartbeat. */
export async function lastGenerateActivity(db: Db, exceptJobId: ObjectId): Promise<Date | null> {
  const other = await db
    .collection<JobDocument>(JOBS_COLLECTION)
    .findOne({ type: { $in: [...VIDEO_JOB_TYPES] }, _id: { $ne: exceptJobId } }, { sort: { updatedAt: -1 }, projection: { updatedAt: 1 } });
  return other?.updatedAt ?? null;
}
