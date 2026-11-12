import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/shared/hash";
import {
  ArtifactKeys,
  atomicWriteFile,
  InvalidArtifactKeyError,
  LocalArtifactStore,
  RunLockedError,
  type RunRef,
} from "../src/storage";
import { withTempDir } from "./helpers";

const RUN: RunRef = { ownerId: "owner-1", projectId: "project-1", versionId: "v1" };

describe("LocalArtifactStore paths", () => {
  it("uses runs/<owner>/<project>/<version>/", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      expect(store.runDir(RUN)).toBe(path.join(dir, "owner-1", "project-1", "v1"));
    }));

  it("rejects unsafe run IDs and artifact keys (never accepts arbitrary paths)", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      expect(() => store.runDir({ ...RUN, ownerId: "../other" })).toThrow(InvalidArtifactKeyError);
      const writer = await store.acquireWriter(RUN);
      try {
        for (const key of ["../escape.json", "/etc/passwd", "audio/../../x.mp3", "notes.txt", "audio/Scene 1.mp3"]) {
          await expect(writer.write(key, "x")).rejects.toThrow(InvalidArtifactKeyError);
        }
        expect(() => ArtifactKeys.audio("../x")).toThrow(InvalidArtifactKeyError);
        expect(ArtifactKeys.audio("scene-hook")).toBe("audio/scene-hook.mp3");
      } finally {
        await writer.release();
      }
    }));
});

describe("atomic writes", () => {
  it("writes the full content, returns its hash and leaves no temp files", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const writer = await store.acquireWriter(RUN);
      const first = await writer.writeJson(ArtifactKeys.plan, { a: 1 });
      const second = await writer.write(ArtifactKeys.plan, "replaced\n");
      await writer.write(ArtifactKeys.audio("scene-hook"), new Uint8Array([1, 2, 3]));
      await writer.release();

      expect(first.sha256).not.toBe(second.sha256);
      expect(second).toEqual({ key: "plan.json", sha256: sha256("replaced\n"), bytes: 9 });
      expect(Buffer.from((await store.read(RUN, "plan.json"))!).toString()).toBe("replaced\n");
      expect(await store.verify(RUN, "plan.json", second.sha256)).toBe(true);
      expect(await store.verify(RUN, "plan.json", first.sha256)).toBe(false);

      const files = await readdir(store.runDir(RUN), { recursive: true });
      expect(files.filter((f) => String(f).includes(".tmp-"))).toEqual([]);
      expect(files).not.toContain(".writer.lock");
    }));

  it("keeps the previous file intact when a write fails", () =>
    withTempDir(async (dir) => {
      const target = path.join(dir, "data.json");
      await writeFile(target, "original");
      // Force a failure: the "folder" for this write is actually a file, so it cannot succeed.
      // The existing file must be untouched and no temp file may be left behind.
      await expect(atomicWriteFile(path.join(target, "child.json"), Buffer.from("x"))).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("original");
      expect((await readdir(dir)).filter((f) => f.includes(".tmp-"))).toEqual([]);
    }));

  it("returns null for missing artifacts", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      expect(await store.read(RUN, "plan.json")).toBeNull();
      expect(await store.exists(RUN, "plan.json")).toBe(false);
    }));
});

describe("single writer per run", () => {
  it("refuses a second writer while the first holds the lock", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const first = await store.acquireWriter(RUN);
      await expect(store.acquireWriter(RUN)).rejects.toThrow(RunLockedError);
      await expect(store.acquireWriter(RUN)).rejects.toThrow(/Only one writer per run/);
      // A different run is independent.
      const other = await store.acquireWriter({ ...RUN, versionId: "v2" });
      await other.release();
      await first.release();
      const again = await store.acquireWriter(RUN);
      await again.release();
    }));

  it("refuses writes after release", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const writer = await store.acquireWriter(RUN);
      await writer.release();
      await expect(writer.write("plan.json", "x")).rejects.toThrow(/released/);
    }));

  it("cleans up a stale lock left by a process that no longer exists", () =>
    withTempDir(async (dir) => {
      const store = new LocalArtifactStore(dir);
      const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid;
      const lockPath = path.join(store.runDir(RUN), ".writer.lock");
      const writer = await store.acquireWriter(RUN);
      await writer.release();
      await writeFile(lockPath, JSON.stringify({ pid: deadPid, hostname: os.hostname(), acquiredAt: "2026-01-01T00:00:00.000Z" }));
      const recovered = await store.acquireWriter(RUN);
      expect(existsSync(lockPath)).toBe(true);
      await recovered.release();
      expect(existsSync(lockPath)).toBe(false);
    }));
});
