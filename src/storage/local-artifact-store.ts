import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../shared/hash";
import {
  assertArtifactKey,
  runRelativePath,
  RunLockedError,
  type ArtifactStore,
  type RunRef,
  type RunWriter,
  type WrittenArtifact,
} from "./artifact-store";

const LOCK_FILE = ".writer.lock";

interface LockInfo {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

/**
 * Filesystem ArtifactStore. Layout: <root>/<owner>/<project>/<version>/<artifact key>.
 *
 * - Atomic writes: data goes to a temp file in the same folder, is flushed to disk,
 *   then renamed over the final name. Readers never see a half-written file.
 * - Single writer: a run folder can have only one writer, enforced by an exclusive
 *   lock file (.writer.lock) created with O_EXCL.
 */
export class LocalArtifactStore implements ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  describeRun(run: RunRef): string {
    return this.runDir(run);
  }

  runDir(run: RunRef): string {
    const dir = path.resolve(this.root, runRelativePath(run));
    // Defense in depth: IDs are already validated, but never let a path escape the root.
    if (!dir.startsWith(this.root + path.sep)) throw new Error(`run path escapes the artifact root: ${dir}`);
    return dir;
  }

  private artifactPath(run: RunRef, key: string): string {
    assertArtifactKey(key);
    const dir = this.runDir(run);
    const full = path.resolve(dir, key);
    if (!full.startsWith(dir + path.sep)) throw new Error(`artifact path escapes the run folder: ${key}`);
    return full;
  }

  async acquireWriter(run: RunRef): Promise<RunWriter> {
    const dir = this.runDir(run);
    await fs.mkdir(dir, { recursive: true });
    const lockPath = path.join(dir, LOCK_FILE);
    await takeLock(lockPath, true);
    return new LocalRunWriter(run, lockPath, (key) => this.artifactPath(run, key));
  }

  async read(run: RunRef, key: string): Promise<Uint8Array | null> {
    try {
      return await fs.readFile(this.artifactPath(run, key));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  }

  async readJson(run: RunRef, key: string): Promise<unknown | null> {
    const data = await this.read(run, key);
    if (data === null) return null;
    try {
      return JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      throw new Error(`${key} in ${this.runDir(run)} is not valid JSON`);
    }
  }

  async exists(run: RunRef, key: string): Promise<boolean> {
    return (await this.read(run, key)) !== null;
  }

  async verify(run: RunRef, key: string, expectedSha256: string): Promise<boolean> {
    const data = await this.read(run, key);
    return data !== null && sha256(data) === expectedSha256;
  }
}

class LocalRunWriter implements RunWriter {
  private released = false;

  constructor(
    readonly run: RunRef,
    private readonly lockPath: string,
    private readonly resolve: (key: string) => string,
  ) {}

  async write(key: string, data: string | Uint8Array): Promise<WrittenArtifact> {
    if (this.released) throw new Error("this run writer was released; acquire a new one to write");
    const finalPath = this.resolve(key);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    await atomicWriteFile(finalPath, bytes);
    return { key, sha256: sha256(bytes), bytes: bytes.byteLength };
  }

  async writeJson(key: string, value: unknown): Promise<WrittenArtifact> {
    return this.write(key, `${JSON.stringify(value, null, 2)}\n`);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await fs.rm(this.lockPath, { force: true });
  }
}

/** Write to a temp file in the same folder, flush, then rename over the final path. */
export async function atomicWriteFile(finalPath: string, data: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await fs.open(tempPath, "wx");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, finalPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function takeLock(lockPath: string, allowStaleCleanup: boolean): Promise<void> {
  const info: LockInfo = { pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() };
  try {
    const handle = await fs.open(lockPath, "wx"); // fails with EEXIST if someone holds the lock
    try {
      await handle.writeFile(`${JSON.stringify(info)}\n`);
    } finally {
      await handle.close();
    }
    return;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }

  const holder = readLockInfo(lockPath);
  // A lock left behind by a crashed process on this machine can be cleaned up safely.
  if (allowStaleCleanup && holder && holder.hostname === os.hostname() && !isProcessAlive(holder.pid)) {
    await fs.rm(lockPath, { force: true });
    return takeLock(lockPath, false);
  }
  const who = holder ? `process ${holder.pid} on ${holder.hostname} (since ${holder.acquiredAt})` : "another process";
  throw new RunLockedError(
    `This run is already being written by ${who}. Only one writer per run is allowed. ` +
      `If no pipeline command is running, delete ${lockPath} and try again.`,
  );
}

function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockInfo>;
    if (typeof parsed.pid === "number" && typeof parsed.hostname === "string" && typeof parsed.acquiredAt === "string") {
      return parsed as LockInfo;
    }
  } catch {
    // unreadable lock: treat as held by an unknown process
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (error) {
    return isErrno(error, "EPERM"); // exists but belongs to another user
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
