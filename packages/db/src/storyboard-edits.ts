import { type ClientSession, type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { cleanIdeaText } from "./idea-text";
import { PLAN_VERSION_SCHEMA_VERSION, PLAN_VERSIONS_COLLECTION, type PlanStatsDoc, type PlanVersionDocument, type StoredPlan } from "./plan-versions";
import { ProjectActionError, PROJECTS_COLLECTION, STORYBOARD_EDIT_STATES, type ProjectDocument, type VoiceGender } from "./projects";
import { STORYBOARD_APPROVALS_COLLECTION, type StoryboardApprovalDocument } from "./storyboard-approvals";

// Changing the storyboard by hand (docs/API.md D3 narration edit, D4 voice switch, D7 undo/restore;
// DATABASE.md §7.2 rows 3 and 5). F17, F19.
// - Every change is a NEW plan version (versions are never changed), so Undo is always possible and
//   an approval always points to one exact storyboard. A new version has no approval: the project's
//   `approvedPlanVersionId` becomes null (approval #1 must be given again, F20).
// - Undo/restore makes an OLDER version current again (same id, same hash): no new version, and if
//   that exact version was approved before, its approval counts again (API.md D7).
// - None of these call the AI and none count toward the project's 20 AI requests.
// - Every change sends the `stateVersion` the browser saw (`expectedStateVersion`); if another tab
//   changed the project meanwhile, nothing is written: 409 STALE_VERSION ("refresh").
// - Each one is ONE transaction: the checks and the writes can't be split by another request.
// Not in `scheduled` / `publish_failed` until F30 (STORYBOARD_EDIT_STATES): there a change must also
// move the post to `approval_invalidated` in the same transaction (API.md §9).

/** A storyboard scene/narration id (SAFE_ID_PATTERN in packages/pipeline/src/contracts/common.ts). */
const SafeId = z.string({ error: "must be text" }).regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { error: "is not a valid id" });
/** A MongoDB id as 24 hex characters. */
export const ObjectIdString = z.string({ error: "must be text" }).regex(/^[0-9a-f]{24}$/, { error: "is not a valid id" });
const StateVersion = z.number({ error: "must be a whole number" }).int({ error: "must be a whole number" }).min(1, { error: "must be at least 1" });

/** Longest narration block (SCENE_LIMITS.maxNarrationBlockLength). */
export const NARRATION_MAX_CHARS = 300;

/** Narration text: cleaned like the idea (API.md §2), then line breaks and runs of spaces become one space. */
export function cleanNarrationText(raw: string): string {
  return cleanIdeaText(raw).replace(/\s+/g, " ");
}

const NarrationText = z
  .string({ error: "must be text" })
  .transform(cleanNarrationText)
  .pipe(z.string().min(1, { error: "can't be empty" }).max(NARRATION_MAX_CHARS, { error: `must be at most ${NARRATION_MAX_CHARS} characters` }));

/** One narration block of a D3 edit. `speech`/`display`: omitted = keep, null = clear. */
const NarrationBlockEdit = z.strictObject({
  narrationId: SafeId,
  text: NarrationText,
  speech: NarrationText.nullable().optional(),
  display: NarrationText.nullable().optional(),
});

/**
 * D3 body (API.md D3; F17 after review): the edited narration blocks of ONE scene (1–4, each block
 * once), saved together as ONE new version, all or nothing, so one Save = one Undo step.
 * Strict: unknown fields → 400.
 */
export const NarrationEditBodySchema = z
  .strictObject({
    basePlanVersionId: ObjectIdString,
    sceneId: SafeId,
    blocks: z.array(NarrationBlockEdit, { error: "must be a list" }).min(1, { error: "must have at least one block" }).max(4, { error: "must have at most 4 blocks" }),
    expectedStateVersion: StateVersion,
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.blocks.forEach((b, i) => {
      if (seen.has(b.narrationId)) ctx.addIssue({ code: "custom", path: ["blocks", i, "narrationId"], message: "is listed twice" });
      seen.add(b.narrationId);
    });
  });
export type NarrationEditBody = z.output<typeof NarrationEditBodySchema>;

/** D4 body (API.md D4, F19): switch the narrator voice (Male ↔ Female). The language can't change. */
export const VoiceSwitchBodySchema = z.strictObject({
  basePlanVersionId: ObjectIdString,
  voiceGender: z.enum(["female", "male"], { error: "must be female or male" }),
  expectedStateVersion: StateVersion,
});
export type VoiceSwitchBody = z.output<typeof VoiceSwitchBodySchema>;

/** D7 body (API.md D7). */
export const RestoreBodySchema = z.strictObject({ expectedStateVersion: StateVersion });
export type RestoreBody = z.output<typeof RestoreBodySchema>;

/** A new plan built from the base version by the caller (the web app, with the pipeline's validator). */
export interface BuiltPlan {
  plan: StoredPlan;
  planHash: string;
  validation: PlanVersionDocument["validation"];
  stats: PlanStatsDoc;
}

const STALE = (expected: number, current: number) =>
  new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.", { expectedStateVersion: expected, currentStateVersion: current });

/**
 * May the storyboard be changed now? (Same order as C4: archived, a running job, another tab,
 * the state.) Throws ProjectActionError; nothing is changed.
 */
export function assertStoryboardEditable(project: ProjectDocument, expectedStateVersion: number): void {
  if (project.state === "archived") throw new ProjectActionError("INVALID_STATE", "This project is archived.", { state: project.state });
  if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on the previous step.", { activeJobId: project.activeJobId.toHexString() });
  if (project.stateVersion !== expectedStateVersion) throw STALE(expectedStateVersion, project.stateVersion);
  if (!STORYBOARD_EDIT_STATES.includes(project.state) || !project.currentPlanVersionId) {
    throw new ProjectActionError("INVALID_STATE", "The storyboard can't be changed right now.", { state: project.state });
  }
}

async function loadOwnedProject(db: Db, ownerId: string, projectId: string, session: ClientSession): Promise<ProjectDocument> {
  const project =
    /^[0-9a-f]{24}$/.test(projectId) && /^[0-9a-f]{24}$/.test(ownerId)
      ? await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ _id: new ObjectId(projectId), ownerId: new ObjectId(ownerId) }, { session })
      : null;
  if (!project) throw new ProjectActionError("NOT_FOUND", "We couldn't find this project.");
  return project;
}

/** The voice gender a plan's voice preset stands for ("indian-english-male" → male). */
export function voiceGenderOfPreset(preset: unknown): VoiceGender | null {
  if (typeof preset !== "string") return null;
  return /-female$/.test(preset) ? "female" : /-male$/.test(preset) ? "male" : null;
}

/**
 * D3 (and D4): save a new `user_edit` version made from the CURRENT version, in ONE transaction:
 * the checks above, `basePlanVersionId` must be the current version (else STALE_VERSION), insert
 * version n+1 (`parentVersionId` = base; saved even when it fails the checks, so no typing is lost:
 * it just can't be approved), point the project at it, `approvedPlanVersionId` = null, state
 * `storyboard_ready`, +1 stateVersion (and the new voice for D4). `build` makes the new plan from the
 * base (it may throw ProjectActionError INVALID_INPUT, e.g. an unknown scene id).
 */
export async function saveUserEditVersion(
  db: Db,
  input: {
    ownerId: string;
    projectId: string;
    basePlanVersionId: string;
    expectedStateVersion: number;
    build: (base: PlanVersionDocument, ids: { versionId: ObjectId; parentVersionId: ObjectId }) => BuiltPlan;
    /** D4: the project's new voice (must match the built plan's voice preset). */
    voiceGender?: VoiceGender;
    now?: Date;
  },
): Promise<{ version: PlanVersionDocument; project: ProjectDocument }> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let result: { version: PlanVersionDocument; project: ProjectDocument } | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const project = await loadOwnedProject(db, input.ownerId, input.projectId, session);
      assertStoryboardEditable(project, input.expectedStateVersion);
      if (!project.currentPlanVersionId!.equals(new ObjectId(input.basePlanVersionId))) {
        throw new ProjectActionError("STALE_VERSION", "This storyboard changed in another tab, refresh.", {
          expectedStateVersion: input.expectedStateVersion,
          currentStateVersion: project.stateVersion,
        });
      }
      const versions = db.collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION);
      const base = await versions.findOne({ _id: project.currentPlanVersionId!, projectId: project._id, ownerId: project.ownerId }, { session });
      if (!base) throw new Error(`Project ${project._id.toHexString()} points to a missing plan version.`);
      const last = await versions.findOne({ projectId: project._id }, { session, sort: { versionNumber: -1 }, projection: { versionNumber: 1 } });
      const versionId = new ObjectId();
      const built = input.build(base, { versionId, parentVersionId: base._id });
      const version: PlanVersionDocument = {
        _id: versionId,
        ownerId: project.ownerId,
        projectId: project._id,
        schemaVersion: PLAN_VERSION_SCHEMA_VERSION,
        versionNumber: (last?.versionNumber ?? 0) + 1,
        parentVersionId: base._id,
        source: "user_edit",
        plan: built.plan,
        planHash: built.planHash,
        validation: built.validation,
        stats: built.stats,
        plannerUsage: null,
        createdAt: now,
      };
      await versions.insertOne(version, { session });
      const updated = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOneAndUpdate(
        { _id: project._id, stateVersion: project.stateVersion, activeJobId: null },
        {
          $set: {
            currentPlanVersionId: versionId,
            approvedPlanVersionId: null,
            state: "storyboard_ready",
            ...(input.voiceGender ? { voiceGender: input.voiceGender } : {}),
            updatedAt: now,
          },
          $inc: { stateVersion: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!updated) throw STALE(input.expectedStateVersion, project.stateVersion + 1);
      result = { version, project: updated };
    });
  } finally {
    await session.endSession();
  }
  return result!;
}

/**
 * D7 Undo / restore (API.md D7, DATABASE.md §7.2 row 5), ONE transaction: an older version of this
 * project becomes current again. No new version, nothing deleted. `approvedPlanVersionId` = that
 * version if it has an approval (the same exact plan), else null; state `storyboard_ready`; the
 * project's voice follows the restored plan's voice; +1 stateVersion.
 */
export async function restorePlanVersion(
  db: Db,
  input: { ownerId: string; projectId: string; planVersionId: string; expectedStateVersion: number; now?: Date },
): Promise<ProjectDocument> {
  const now = input.now ?? new Date();
  const session = db.client.startSession();
  let result: ProjectDocument | null = null;
  try {
    await session.withTransaction(async () => {
      result = null;
      const project = await loadOwnedProject(db, input.ownerId, input.projectId, session);
      const target = /^[0-9a-f]{24}$/.test(input.planVersionId)
        ? await db
            .collection<PlanVersionDocument>(PLAN_VERSIONS_COLLECTION)
            .findOne({ _id: new ObjectId(input.planVersionId), projectId: project._id, ownerId: project.ownerId }, { session, projection: { "plan.voicePreset": 1 } })
        : null;
      if (!target) throw new ProjectActionError("NOT_FOUND", "We couldn't find this storyboard version.");
      assertStoryboardEditable(project, input.expectedStateVersion);
      if (project.currentPlanVersionId!.equals(target._id)) {
        throw new ProjectActionError("INVALID_STATE", "This version is already the current one.", { reason: "already_current" });
      }
      const approval = await db.collection<StoryboardApprovalDocument>(STORYBOARD_APPROVALS_COLLECTION).findOne({ planVersionId: target._id, ownerId: project.ownerId }, { session });
      const voiceGender = voiceGenderOfPreset(target.plan?.voicePreset) ?? project.voiceGender;
      const updated = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOneAndUpdate(
        { _id: project._id, stateVersion: project.stateVersion, activeJobId: null },
        {
          $set: { currentPlanVersionId: target._id, approvedPlanVersionId: approval ? target._id : null, state: "storyboard_ready", voiceGender, updatedAt: now },
          $inc: { stateVersion: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!updated) throw STALE(input.expectedStateVersion, project.stateVersion + 1);
      result = updated;
    });
  } finally {
    await session.endSession();
  }
  return result!;
}
