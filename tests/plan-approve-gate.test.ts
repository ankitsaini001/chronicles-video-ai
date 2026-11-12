import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runApproveCommand } from "../src/cli/approve";
import { hashPlan } from "../src/planning";
import { approveRun, checkGenerationGate, generateRun, loadManifest, parseRunId, runPlanStage, speechConfigFor } from "../src/pipeline";
import { renderFixtureRun } from "../src/pipeline/render-fixture";
import { ProviderError } from "../src/providers";
import { ArtifactKeys, LocalArtifactStore, LocalSpeechCache } from "../src/storage";
import { PlanSchema } from "../src/contracts";
import { withTempDir } from "./helpers";
import { MockPlanner, modelOutputFromFixture, TOPIC } from "./planner-helpers";

const NOW = () => new Date("2026-11-12T10:00:00.000Z");

async function planLiveRun(store: LocalArtifactStore, responses: Array<string | Error> = [JSON.stringify({ ...modelOutputFromFixture(), ownerId: "attacker", projectId: "evil" })]) {
  const provider = new MockPlanner(responses);
  const result = await runPlanStage({ store, provider, topic: TOPIC, voicePreset: "indian-english-female", projectId: "water-cycle-abc123", now: NOW });
  return { result, provider };
}

describe("plan stage (mock planner, no network)", () => {
  it("creates a new local-dev run with plan.json, plan-review.html and an awaiting-approval manifest", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const { result } = await planLiveRun(store);
      expect(result.status).toBe("awaiting-approval");
      if (result.status !== "awaiting-approval") return;
      expect(result.runId).toBe("local-dev/water-cycle-abc123/v1");

      const run = parseRunId(result.runId)!;
      const plan = PlanSchema.parse(await store.readJson(run, ArtifactKeys.plan));
      // Ownership comes from code even though the model returned ownerId/projectId.
      expect(plan).toMatchObject({ ownerId: "local-dev", projectId: "water-cycle-abc123", versionId: "v1", parentVersionId: null });
      expect(result.ignoredFields.sort()).toEqual(["ownerId", "projectId"]);
      expect(hashPlan(plan)).toBe(result.planHash);

      const manifest = (await loadManifest(store, run))!;
      expect(manifest).toMatchObject({ state: "awaiting-approval", fixture: false, planHash: result.planHash });
      expect(manifest.stages.plan.status).toBe("succeeded");
      expect(manifest.stages.approve.status).toBe("pending");
      expect(manifest.scenes.map((s) => s.id)).toEqual(plan.scenes.map((s) => s.id));
      expect(Object.keys(manifest.artifacts).sort()).toEqual(["plan-review.html", "plan.json"]);
      expect(manifest.stages.plan.diagnostics.join("\n")).toMatch(/tokens prompt 1000/);

      const html = Buffer.from((await store.read(run, ArtifactKeys.planReview))!).toString("utf8");
      expect(html).toContain("<mark>Where does rain come from<sup>1</sup></mark>"); // anchor phrase highlighted and numbered
      expect(html).toContain(result.planHash);
      expect(html).toContain(`approve --run ${result.runId} --plan-hash ${result.planHash}`);
      expect(html).toContain("indian-english-female");
    }));

  it("still invalid after one repair: needs-input, no plan.json", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const bad = modelOutputFromFixture();
      bad.scenes[0].type = "chart";
      const { result, provider } = await planLiveRun(store, [JSON.stringify(bad), JSON.stringify(bad)]);
      expect(result.status).toBe("needs-input");
      expect(provider.requests).toHaveLength(2);
      const run = parseRunId(result.runId)!;
      expect(await store.exists(run, ArtifactKeys.plan)).toBe(false);
      const manifest = (await loadManifest(store, run))!;
      expect(manifest.state).toBe("needs-input");
      expect(manifest.stages.plan.status).toBe("failed");
      expect(manifest.stages.plan.diagnostics.join("\n")).toContain('the first scene must be "title-hook"');
    }));

  it("fatal provider error: run failed with a clear message, no retry or repair", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const { result, provider } = await planLiveRun(store, [new ProviderError({ provider: "gemini", kind: "model-unavailable", message: 'Gemini model "x" is not available' })]);
      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(provider.requests).toHaveLength(1);
      expect(result.errorKind).toBe("model-unavailable");
      expect(result.message).toContain("preflight --network");
      expect((await loadManifest(store, parseRunId(result.runId)!))!.state).toBe("failed");
    }));
});

describe("approve and generation gating", () => {
  it("approves the correct hash, writes approval.json and opens the gate", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const { result } = await planLiveRun(store);
      if (result.status !== "awaiting-approval") throw new Error("plan failed");
      const run = result.run;

      expect(await checkGenerationGate(store, run)).toMatchObject({ allowed: false, reason: expect.stringMatching(/not been approved/) });

      const approved = await approveRun({ store, run, planHash: result.planHash, now: NOW });
      expect(approved.status).toBe("approved");
      const approval = await store.readJson(run, ArtifactKeys.approval);
      expect(approval).toEqual({ planHash: result.planHash, actor: "local-developer", approvedAt: NOW().toISOString() });
      const manifest = (await loadManifest(store, run))!;
      expect(manifest.state).toBe("plan-approved");
      expect(manifest.stages.approve.status).toBe("succeeded");
      expect(manifest.artifacts[ArtifactKeys.approval]).toBeDefined();

      expect(await checkGenerationGate(store, run)).toMatchObject({ allowed: true, fixture: false, planHash: result.planHash });
      expect((await approveRun({ store, run, planHash: result.planHash, now: NOW })).status).toBe("already-approved");
    }));

  it("rejects a stale hash and writes nothing", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const { result } = await planLiveRun(store);
      if (result.status !== "awaiting-approval") throw new Error("plan failed");
      const stale = `sha256:${"0".repeat(64)}`;
      const rejected = await approveRun({ store, run: result.run, planHash: stale, now: NOW });
      expect(rejected).toMatchObject({ status: "stale", message: expect.stringContaining("stale approval rejected") });
      expect(await store.exists(result.run, ArtifactKeys.approval)).toBe(false);
      expect((await loadManifest(store, result.run))!.state).toBe("awaiting-approval");
      expect((await approveRun({ store, run: result.run, planHash: "not-a-hash" })).status).toBe("invalid");
      expect((await approveRun({ store, run: { ...result.run, projectId: "missing" }, planHash: result.planHash })).status).toBe("not-found");
    }));

  it("refuses generation when plan.json is edited after approval", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const { result } = await planLiveRun(store);
      if (result.status !== "awaiting-approval") throw new Error("plan failed");
      await approveRun({ store, run: result.run, planHash: result.planHash, now: NOW });
      const file = path.join(store.runDir(result.run), ArtifactKeys.plan);
      const plan = JSON.parse(await readFile(file, "utf8"));
      plan.scenes[1].narration[0].text = plan.scenes[1].narration[0].text.replace("faster", "quicker");
      await writeFile(file, JSON.stringify(plan, null, 2));
      const gate = await checkGenerationGate(store, result.run);
      expect(gate.allowed).toBe(false);
      if (!gate.allowed) expect(gate.reason).toMatch(/changed on disk/);
    }));

  it("refuses approval.json edited to another hash", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const { result } = await planLiveRun(store);
      if (result.status !== "awaiting-approval") throw new Error("plan failed");
      await approveRun({ store, run: result.run, planHash: result.planHash, now: NOW });
      const file = path.join(store.runDir(result.run), ArtifactKeys.approval);
      await writeFile(file, JSON.stringify({ planHash: `sha256:${"1".repeat(64)}`, actor: "x", approvedAt: NOW().toISOString() }));
      expect((await checkGenerationGate(store, result.run)).allowed).toBe(false);
    }));

  it("generate refuses without a valid approval and never calls the speech provider", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const { result } = await planLiveRun(store);
      if (result.status !== "awaiting-approval") throw new Error("plan failed");
      let providerCreated = 0;
      const generate = () =>
        generateRun({
          store,
          run: result.run,
          mode: "generate",
          speechCache: new LocalSpeechCache(dir),
          speechConfig: (plan) => speechConfigFor(plan, "voiceF", "eleven_multilingual_v2"),
          speechProvider: () => {
            providerCreated++;
            throw new Error("must not be called");
          },
          now: NOW,
        });
      expect(await generate()).toMatchObject({ status: "refused", message: expect.stringMatching(/not been approved/) });

      const stale = await runApproveCommand({ run: result.runId, planHash: `sha256:${"2".repeat(64)}`, runsDir: dir, projectRoot: dir });
      expect(stale.ok).toBe(false);
      expect(await generate()).toMatchObject({ status: "refused" });
      const ok = await runApproveCommand({ run: `runs/${result.runId}/`, planHash: result.planHash, runsDir: dir, projectRoot: dir });
      expect(ok.ok).toBe(true);

      // Edit the plan after approval: the gate rejects the stale approval.
      const file = path.join(store.runDir(result.run), ArtifactKeys.plan);
      const plan = JSON.parse(await readFile(file, "utf8"));
      plan.scenes[0].narration[0].text += " Really.";
      await writeFile(file, JSON.stringify(plan));
      expect(await generate()).toMatchObject({ status: "refused", message: expect.stringMatching(/changed on disk/) });
      expect(providerCreated).toBe(0);
    }));

  it("render-fixture refuses a live run (approved or not); fixture runs are unaffected", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const { result } = await planLiveRun(store);
      if (result.status !== "awaiting-approval") throw new Error("plan failed");
      const input = await store.readJson(result.run, ArtifactKeys.plan);
      let rendered = 0;
      const render = async () => {
        rendered++;
        throw new Error("must not render");
      };
      const refused = await renderFixtureRun({ input, store, render, now: NOW });
      expect(refused).toMatchObject({ status: "invalid", message: expect.stringMatching(/refusing to render live run.*not been approved/) });

      await approveRun({ store, run: result.run, planHash: result.planHash, now: NOW });
      const stillRefused = await renderFixtureRun({ input, store, render, now: NOW });
      expect(stillRefused).toMatchObject({ status: "invalid", message: expect.stringMatching(/generate/) });
      expect(rendered).toBe(0);
      expect((await loadManifest(store, result.run))!.state).toBe("plan-approved");
    }));
});
