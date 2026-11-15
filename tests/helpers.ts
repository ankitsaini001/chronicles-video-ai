import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { PlanSchema, type Plan } from "../packages/pipeline/src/contracts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

/** Raw fixture JSON exactly as stored on disk. */
export function loadFixture(name: string): any {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

/** The valid water-cycle fixture, parsed through the schema (defaults applied). */
export function validPlan(): Plan {
  return PlanSchema.parse(loadFixture("water-cycle.plan.json"));
}

/**
 * Temporary folders for tests live inside the project, in the git-ignored runs/.tmp/tests (never the
 * system temp folder, which is shared on the founder's machine). Each is removed after its test.
 */
export const TEST_TMP = path.join(import.meta.dirname, "..", "runs", ".tmp", "tests");

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  await mkdir(TEST_TMP, { recursive: true });
  const dir = await mkdtemp(path.join(TEST_TMP, "bytereel-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
