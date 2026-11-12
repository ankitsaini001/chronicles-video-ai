import { afterEach, describe, expect, it } from "vitest";
import { RUN_STATES, type RunState } from "../packages/pipeline/src/contracts";
import {
  createManifest,
  InvalidTransitionError,
  loadManifest,
  RUN_STATE_TRANSITIONS,
  saveManifest,
  transitionRun,
  updateSceneSpeech,
  updateStage,
} from "../packages/pipeline/src/pipeline";
import { LocalArtifactStore, type RunRef } from "../packages/pipeline/src/storage";
import { withTempDir } from "./helpers";

const RUN: RunRef = { ownerId: "owner-1", projectId: "project-1", versionId: "v1" };
const t = (seconds: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, seconds));

function newManifest() {
  return createManifest({ run: RUN, parentVersionId: null, sceneIds: ["scene-a", "scene-b"], fixture: true, now: t(0) });
}

describe("run state transitions", () => {
  it("starts in draft with every stage pending", () => {
    const m = newManifest();
    expect(m.state).toBe("draft");
    expect(Object.values(m.stages).every((s) => s.status === "pending")).toBe(true);
    expect(m.scenes.map((s) => s.id)).toEqual(["scene-a", "scene-b"]);
    expect(m.history).toEqual([{ from: null, to: "draft", at: t(0).toISOString(), reason: "run created" }]);
  });

  it("follows the happy path to approved", () => {
    let m = newManifest();
    const path: RunState[] = ["awaiting-approval", "running", "ready-for-review", "approved"];
    path.forEach((state, i) => (m = transitionRun(m, state, `step ${i}`, t(i + 1))));
    expect(m.state).toBe("approved");
    expect(m.history.map((h) => h.to)).toEqual(["draft", ...path]);
  });

  it("supports failure and resume", () => {
    let m = transitionRun(newManifest(), "awaiting-approval", "plan ok", t(1));
    m = transitionRun(m, "running", "approved", t(2));
    m = transitionRun(m, "failed", "render crashed", t(3));
    m = transitionRun(m, "running", "resume", t(4));
    expect(m.state).toBe("running");
  });

  it("rejects transitions that skip approval or leave a final state", () => {
    expect(() => transitionRun(newManifest(), "running", "skip approval", t(1))).toThrow(InvalidTransitionError);
    expect(() => transitionRun(newManifest(), "approved", "skip everything", t(1))).toThrow(/cannot move run from "draft" to "approved"/);
    const cancelled = transitionRun(newManifest(), "cancelled", "user cancelled", t(1));
    for (const state of RUN_STATES) {
      expect(() => transitionRun(cancelled, state, "x", t(2))).toThrow(/final state/);
    }
  });

  it("never allows a transition to the same state", () => {
    for (const state of RUN_STATES) expect(RUN_STATE_TRANSITIONS[state]).not.toContain(state);
  });

  it("does not mutate the input manifest", () => {
    const m = newManifest();
    transitionRun(m, "awaiting-approval", "x", t(1));
    expect(m.state).toBe("draft");
  });
});

describe("stage and scene status", () => {
  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
  });

  it("records attempts, timing and diagnostics", () => {
    let m = updateStage(newManifest(), "render", "running", t(1));
    m = updateStage(m, "render", "failed", t(4), "chromium exited");
    m = updateStage(m, "render", "running", t(5));
    m = updateStage(m, "render", "succeeded", t(7));
    expect(m.stages.render).toMatchObject({ status: "succeeded", attempts: 2, durationMs: 2000, diagnostics: ["chromium exited"] });
  });

  it("rejects invalid stage transitions", () => {
    expect(() => updateStage(newManifest(), "speech", "succeeded", t(1))).toThrow(/cannot move stage "speech" from "pending" to "succeeded"/);
  });

  it("tracks per-scene speech status", () => {
    let m = updateSceneSpeech(newManifest(), "scene-b", "running", t(1));
    m = updateSceneSpeech(m, "scene-b", "succeeded", t(2));
    expect(m.scenes[0]!.speech.status).toBe("pending");
    expect(m.scenes[1]!.speech.status).toBe("succeeded");
    expect(() => updateSceneSpeech(m, "scene-x", "running", t(3))).toThrow(/not part of this run/);
  });

  it("never stores secrets in diagnostics", () => {
    process.env.ELEVENLABS_API_KEY = "sk_live_supersecret123";
    let m = updateStage(newManifest(), "speech", "running", t(1));
    m = updateStage(m, "speech", "failed", t(2), "request failed with key sk_live_supersecret123; headers: xi-api-key: sk_live_supersecret123");
    const text = JSON.stringify(m);
    expect(text).not.toContain("supersecret");
    expect(m.stages.speech.diagnostics[0]).toContain("[redacted]");
  });
});

describe("manifest persistence", () => {
  it("saves and loads a manifest through the artifact store", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const writer = await store.acquireWriter(RUN);
      const m = transitionRun(newManifest(), "awaiting-approval", "ok", t(1));
      await saveManifest(writer, m);
      await writer.release();
      expect(await loadManifest(store, RUN)).toEqual(m);
      expect(await loadManifest(store, { ...RUN, versionId: "v9" })).toBeNull();
    }));

  it("reports a corrupt manifest clearly", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const writer = await store.acquireWriter(RUN);
      await writer.writeJson("manifest.json", { ...newManifest(), state: "done" });
      await writer.release();
      await expect(loadManifest(store, RUN)).rejects.toThrow(/manifest.json .* is invalid: state/);
    }));
});
