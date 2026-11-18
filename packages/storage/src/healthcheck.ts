import { healthcheckStorageKey, type StorageKey } from "./keys";

/**
 * The F22 test file key: healthcheck/<UTC timestamp>-hello.txt, e.g.
 * healthcheck/20261114T101530Z-hello.txt. ONLY `npm run storage -- check` (tools/cli/storage.ts)
 * uses this; the app never writes outside users/{ownerId}/.
 */
export function healthcheckKey(now: Date = new Date()): StorageKey {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  return healthcheckStorageKey(`healthcheck/${stamp}-hello.txt`);
}
