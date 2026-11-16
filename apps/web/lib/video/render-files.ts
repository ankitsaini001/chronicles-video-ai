import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { StorageError, type ObjectInfo, type StorageKey, type StoredObject } from "@bytereel/storage";

// File helpers shared by the two video workers (F23 run-generate-job.ts, F25 run-caption-job.ts):
// the R2 methods they use, the create-only upload, and the clean-up of old render work folders.
// No voice, AI or database code here.

/** The R2 store's methods the workers use (R2ArtifactStore). */
export interface FileStore {
  checkBucket(): Promise<void>;
  put(key: StorageKey, data: string | Uint8Array, options?: { createOnly?: boolean }): Promise<StoredObject>;
  get(key: StorageKey): Promise<Uint8Array | null>;
  head(key: StorageKey): Promise<ObjectInfo | null>;
}

export const sha256 = (data: Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** Upload a finished file create-only; an existing file with the SAME bytes (an earlier run of this step) is fine. */
export async function putOnce(files: FileStore, key: StorageKey, data: Uint8Array | string): Promise<StoredObject> {
  const bytes = typeof data === "string" ? new Uint8Array(Buffer.from(data, "utf8")) : data;
  try {
    return await files.put(key, bytes, { createOnly: true });
  } catch (error) {
    if (!(error instanceof StorageError) || error.code !== "already_exists") throw error;
    const existing = await files.head(key);
    const mine = sha256(bytes);
    if (existing?.sha256 === mine) return { key, sha256: mine, bytes: bytes.byteLength };
    throw new Error(`${key.split("/").pop()} already exists in storage with different content`);
  }
}

/** R2 refused (wrong token permissions, missing bucket): trying again can't help, the job ends at once. */
export const isStorageRefusal = (error: unknown) => error instanceof StorageError && (error.code === "access_denied" || error.code === "bucket_not_found");

/** A render's work folder this old was left by a render that never finished (the server restarted). */
export const OLD_WORK_FOLDER_MS = 6 * 60 * 60_000;

/** Remove work folders of renders that never finished (older than 6 h); never the current one. */
export async function removeOldWorkFolders(parent: string, current: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === current || !/^[0-9a-f]{24}$/.test(entry.name)) continue;
    const folder = path.join(parent, entry.name);
    const info = await stat(folder).catch(() => null);
    if (info && Date.now() - info.mtimeMs > OLD_WORK_FOLDER_MS) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
