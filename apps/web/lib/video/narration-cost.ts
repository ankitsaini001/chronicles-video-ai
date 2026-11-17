import { narrationCost, type NarrationCost, type ProjectDocument, type StoredPlan } from "@bytereel/db";
import type { Db } from "mongodb";
import { voiceEstimatorFor, voiceSetupFromEnv } from "./voice";

// F26 (server only): what a new video of this storyboard would record. The SAME rule D8 and E2 check
// the voice limits with: the plan's recordings by cache key (VoiceEstimator, from the server's voice
// settings) against this owner's recordings (narrationCost → voiceStillNeeded). It only reads the
// database: no voice or AI call, nothing counted. Null when the voice isn't set up here (the note is
// then left out; approving says what is missing).

export async function newVideoCost(db: Db, project: Pick<ProjectDocument, "ownerId">, plan: StoredPlan, env: NodeJS.ProcessEnv = process.env): Promise<NarrationCost | null> {
  const setup = voiceSetupFromEnv(env);
  if (!setup.ok) return null;
  let scenes;
  try {
    scenes = voiceEstimatorFor(setup)(plan);
  } catch {
    return null; // e.g. a voice id missing from the settings
  }
  return narrationCost(db, { ownerId: project.ownerId, scenes });
}
