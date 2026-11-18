import { approveLimitCheck, limitShortReason, narrationCost, type ApprovePath, type NarrationCost, type ProjectDocument, type StoredPlan, type VoiceScene } from "@bytereel/db";
import type { Db, ObjectId } from "mongodb";
import { voiceEstimatorFor, voiceSetupFromEnv } from "./voice";

// F26 (server only): what a new video of this storyboard would record. The SAME rule D8 and E2 check
// the voice limits with: the plan's recordings by cache key (VoiceEstimator, from the server's voice
// settings) against this owner's recordings (narrationCost → voiceStillNeeded). It only reads the
// database: no voice or AI call, nothing counted. Null when the voice isn't set up here (the note is
// then left out; approving says what is missing).
// F27: and whether approving would be refused by a limit right now (approveLimitCheck: the same
// functions and order as D8), so the storyboard can say why and grey out Approve before the click.

/** The recordings this plan needs (one per scene), or null when the voice isn't set up on this server. */
export function voiceScenesFor(plan: StoredPlan, env: NodeJS.ProcessEnv = process.env): VoiceScene[] | null {
  const setup = voiceSetupFromEnv(env);
  if (!setup.ok) return null;
  try {
    return voiceEstimatorFor(setup)(plan);
  } catch {
    return null; // e.g. a voice id missing from the settings
  }
}

export async function newVideoCost(db: Db, project: Pick<ProjectDocument, "ownerId">, plan: StoredPlan, env: NodeJS.ProcessEnv = process.env): Promise<NarrationCost | null> {
  const scenes = voiceScenesFor(plan, env);
  return scenes ? narrationCost(db, { ownerId: project.ownerId, scenes }) : null;
}

/** F27: what approving this version would do, and the limit that would refuse it (its full sentence and the short reason for the button). */
export type ApproveLimit = { path: ApprovePath; refusal: { message: string; short: string } | null };

export async function approveLimitFor(
  db: Db,
  input: { project: Pick<ProjectDocument, "_id" | "ownerId">; version: { _id: ObjectId; plan: StoredPlan }; timezone: string; now?: Date },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApproveLimit> {
  const check = await approveLimitCheck(db, {
    ownerId: input.project.ownerId,
    projectId: input.project._id,
    planVersionId: input.version._id,
    timezone: input.timezone,
    scenes: voiceScenesFor(input.version.plan, env),
    ...(input.now ? { now: input.now } : {}),
  });
  const refusal = check.refusal ? { message: check.refusal.message, short: limitShortReason(check.refusal) } : null;
  return { path: check.path, refusal };
}
