import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { hashPlan } from "../packages/pipeline/src/planning";
import { runFixture } from "../packages/pipeline/src/pipeline";
import { LocalArtifactStore, RunLockedError } from "../packages/pipeline/src/storage";
import { loadFixture, validPlan, withTempDir } from "./helpers";

const fixedClock = () => new Date("2026-11-12T10:00:00.000Z");

describe("fixture run", () => {
  it("creates the run folder, plan.json and an awaiting-approval manifest", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const result = await runFixture({ input: loadFixture("water-cycle.plan.json"), store, now: fixedClock });
      if (result.status !== "created") throw new Error(`unexpected status ${result.status}`);

      expect(result.planHash).toBe(hashPlan(validPlan()));
      expect(result.manifest).toMatchObject({
        fixture: true,
        state: "awaiting-approval",
        planHash: result.planHash,
        stages: { preflight: { status: "skipped" }, plan: { status: "succeeded", attempts: 1 }, approve: { status: "pending" } },
      });
      expect(await readdir(result.runDir)).toEqual(["manifest.json", "plan.json"]);
      expect(await store.verify(result.run, "plan.json", result.manifest.artifacts["plan.json"]!.sha256)).toBe(true);
    }));

  it("is deterministic: the same fixture always gives the same result", () =>
    withTempDir(async (dir) => {
      const a = await runFixture({ input: loadFixture("water-cycle.plan.json"), store: new LocalArtifactStore(`${dir}/a`), now: fixedClock });
      const b = await runFixture({ input: loadFixture("water-cycle.plan.json"), store: new LocalArtifactStore(`${dir}/b`), now: fixedClock });
      if (a.status !== "created" || b.status !== "created") throw new Error("expected both runs to be created");
      expect(a.manifest).toEqual(b.manifest);
    }));

  it("leaves an existing run unchanged when re-run with the same plan", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      await runFixture({ input: loadFixture("water-cycle.plan.json"), store, now: fixedClock });
      const again = await runFixture({ input: loadFixture("water-cycle.plan.json"), store });
      expect(again.status).toBe("unchanged");
    }));

  it("refuses to overwrite a version with a different plan (versions are immutable)", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      await runFixture({ input: loadFixture("water-cycle.plan.json"), store, now: fixedClock });
      const edited = loadFixture("water-cycle.plan.json");
      edited.topic = "The water cycle, explained";
      expect((await runFixture({ input: edited, store })).status).toBe("conflict");
    }));

  it("writes nothing for an invalid plan", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const result = await runFixture({ input: loadFixture("invalid-bad-target.plan.json"), store });
      expect(result.status).toBe("invalid");
      expect(await readdir(dir)).toEqual([]);
    }));

  it("refuses to run while another writer holds the run", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const plan = validPlan();
      const writer = await store.acquireWriter({ ownerId: plan.ownerId, projectId: plan.projectId, versionId: plan.versionId });
      await expect(runFixture({ input: loadFixture("water-cycle.plan.json"), store })).rejects.toThrow(RunLockedError);
      await writer.release();
    }));
});
