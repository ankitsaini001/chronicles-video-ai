// R2 object keys (docs/ARCHITECTURE.md §9). Keys are built ONLY here, ONLY from validated MongoDB
// ObjectIds and hashes, never from client or AI model input. Anything else is refused.

/** A key built by this file. The store accepts only this type (plus a run-time check). */
export type StorageKey = string & { readonly __storageKey: true };

export class InvalidStorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStorageKeyError";
  }
}

/** A MongoDB ObjectId as text: exactly 24 lowercase hex characters. */
const OBJECT_ID = /^[0-9a-f]{24}$/;
/** A speech cacheKey as stored in MongoDB (DATABASE.md speechArtifacts): "sha256:" + 64 hex. */
const CACHE_KEY = /^sha256:([0-9a-f]{64})$/;
const MAX_FRAME = 9999;

const OID = "[0-9a-f]{24}";
const USER_KEYS = [
  new RegExp(`^users/${OID}/speech/[0-9a-f]{64}/(audio\\.mp3|alignment\\.json|alignment\\.normalized\\.json)$`),
  new RegExp(`^users/${OID}/projects/${OID}/renders/${OID}/(timeline\\.json|captions\\.json|output\\.mp4|thumbnail\\.jpg|qa\\.json|frames/(0|[1-9][0-9]{0,3})\\.png)$`),
];
/** The only non-user prefix: written by `npm run storage -- check` (F22) and nothing else. */
export const HEALTHCHECK_KEY = /^healthcheck\/[0-9]{8}T[0-9]{6}Z-hello\.txt$/;

export function isObjectIdString(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID.test(value);
}

function objectId(field: string, value: unknown): string {
  if (!isObjectIdString(value)) throw new InvalidStorageKeyError(`${field} is not a valid id`);
  return value;
}

/** The hex part of a speech cacheKey ("sha256:<hex>" → "<hex>"). */
function cacheKeyHex(value: unknown): string {
  const match = typeof value === "string" ? CACHE_KEY.exec(value) : null;
  if (!match?.[1]) throw new InvalidStorageKeyError('cacheKey must be "sha256:" followed by 64 lowercase hex characters');
  return match[1];
}

/** A user-file key passes this check; the healthcheck key only when `allowHealthcheck` is set. */
export function isStorageKey(key: unknown, options: { allowHealthcheck?: boolean } = {}): key is StorageKey {
  if (typeof key !== "string") return false;
  if (USER_KEYS.some((pattern) => pattern.test(key))) return true;
  return options.allowHealthcheck === true && HEALTHCHECK_KEY.test(key);
}

export function assertStorageKey(key: unknown, options: { allowHealthcheck?: boolean } = {}): asserts key is StorageKey {
  if (!isStorageKey(key, options)) {
    throw new InvalidStorageKeyError("not an allowed storage key (keys are built from ids by the storage package only)");
  }
}

function checked(key: string): StorageKey {
  assertStorageKey(key);
  return key;
}

export interface RenderRef {
  ownerId: string;
  projectId: string;
  renderId: string;
}

function renderPrefix(ref: RenderRef): string {
  return `users/${objectId("ownerId", ref.ownerId)}/projects/${objectId("projectId", ref.projectId)}/renders/${objectId("renderId", ref.renderId)}`;
}

function speechPrefix(ownerId: string, cacheKey: string): string {
  return `users/${objectId("ownerId", ownerId)}/speech/${cacheKeyHex(cacheKey)}`;
}

/**
 * Builders for every key in ARCHITECTURE §9. The storyboard copy (plans/…/plan.json, review.html)
 * is not stored in R2 (decision in F22: MongoDB holds every plan version).
 */
export const StorageKeys = {
  speechAudio: (ownerId: string, cacheKey: string) => checked(`${speechPrefix(ownerId, cacheKey)}/audio.mp3`),
  speechAlignment: (ownerId: string, cacheKey: string) => checked(`${speechPrefix(ownerId, cacheKey)}/alignment.json`),
  speechNormalizedAlignment: (ownerId: string, cacheKey: string) => checked(`${speechPrefix(ownerId, cacheKey)}/alignment.normalized.json`),
  renderTimeline: (ref: RenderRef) => checked(`${renderPrefix(ref)}/timeline.json`),
  renderCaptions: (ref: RenderRef) => checked(`${renderPrefix(ref)}/captions.json`),
  renderOutput: (ref: RenderRef) => checked(`${renderPrefix(ref)}/output.mp4`),
  renderThumbnail: (ref: RenderRef) => checked(`${renderPrefix(ref)}/thumbnail.jpg`),
  renderQa: (ref: RenderRef) => checked(`${renderPrefix(ref)}/qa.json`),
  renderFrame: (ref: RenderRef, n: number) => {
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_FRAME) throw new InvalidStorageKeyError(`frame number must be a whole number from 0 to ${MAX_FRAME}`);
    return checked(`${renderPrefix(ref)}/frames/${n}.png`);
  },
} as const;

/** Internal: brand a key that already passed the healthcheck pattern (used by ./healthcheck only). */
export function healthcheckStorageKey(key: string): StorageKey {
  assertStorageKey(key, { allowHealthcheck: true });
  return key;
}
