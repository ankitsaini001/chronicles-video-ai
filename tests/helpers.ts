import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlanSchema, type Plan } from "../src/contracts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

/** Raw fixture JSON exactly as stored on disk. */
export function loadFixture(name: string): any {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

/** The valid water-cycle fixture, parsed through the schema (defaults applied). */
export function validPlan(): Plan {
  return PlanSchema.parse(loadFixture("water-cycle.plan.json"));
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bytereel-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
