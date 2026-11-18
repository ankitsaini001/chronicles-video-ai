import { isStorageKey, R2ArtifactStore, readR2Config } from "@bytereel/storage";

// The private R2 bucket for the web app (F23; ARCHITECTURE §9), server only. One store per process.
// The video job uploads with keys from StorageKeys; the My videos cards get short-lived (15 min)
// presigned links, made only for the owner's own renders (the database query is owner-scoped).
// A presigned link contains the token's key id: never log or print one.

export type StorageSetup = { ok: true; store: R2ArtifactStore } | { ok: false; problem: string };

let cached: { key: string; setup: StorageSetup } | null = null;

export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageSetup {
  const key = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].map((name) => env[name] ?? "").join("\u0000");
  if (cached?.key === key) return cached.setup;
  const config = readR2Config(env);
  const setup: StorageSetup = config.ok ? { ok: true, store: R2ArtifactStore.fromConfig(config.config) } : { ok: false, problem: config.problems.join(" ") };
  cached = { key, setup };
  return setup;
}

/** A 15-minute private link to a thumbnail (null when storage isn't set up). Call only after the owner check. */
export async function thumbnailLink(thumbnailKey: string): Promise<string | null> {
  const setup = storageFromEnv();
  if (!setup.ok || !isStorageKey(thumbnailKey)) return null;
  return (await setup.store.presignedGet(thumbnailKey)).url;
}
