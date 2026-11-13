import type { CreateIndexesOptions, Db, IndexSpecification } from "mongodb";

// Index setup (docs/DATABASE.md §8). Every index ByteReel needs is listed here once, tagged with
// the feature that first needs it. Each feature creates ONLY its own indexes (DATABASE.md §11), so
// what you see in Atlas always matches what has been built.
//
// Better Auth's MongoDB adapter may not create indexes itself (to be checked in F08), so we create
// the ones it relies on.

export interface IndexDefinition {
  collection: string;
  /** Index name, fixed so re-running the setup recognises it. */
  name: string;
  keys: IndexSpecification;
  options: Omit<CreateIndexesOptions, "name">;
  /** Feature that creates it (docs/features). */
  feature: "F07" | "F08";
  /** Why it exists, in plain words (shown by `npm run db -- indexes`). */
  why: string;
}

export const INDEXES: readonly IndexDefinition[] = [
  { collection: "allowlist", name: "email_unique", keys: { email: 1 }, options: { unique: true }, feature: "F07", why: "An email is invited once" },
  { collection: "user", name: "email_unique", keys: { email: 1 }, options: { unique: true }, feature: "F08", why: "One account per email" },
  { collection: "session", name: "token_unique", keys: { token: 1 }, options: { unique: true }, feature: "F08", why: "Find your session on each request" },
  { collection: "session", name: "userId", keys: { userId: 1 }, options: {}, feature: "F08", why: "Log a user out everywhere" },
  { collection: "session", name: "expiresAt_ttl", keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 }, feature: "F08", why: "Expired sessions delete themselves" },
  { collection: "account", name: "userId_providerId", keys: { userId: 1, providerId: 1 }, options: {}, feature: "F08", why: "Find a user's password on login" },
  { collection: "verification", name: "identifier", keys: { identifier: 1 }, options: {}, feature: "F08", why: "Find a reset link" },
  { collection: "verification", name: "expiresAt_ttl", keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 }, feature: "F08", why: "Expired reset links delete themselves" },
  { collection: "rateLimits", name: "expiresAt_ttl", keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 }, feature: "F08", why: "Old sign-up/login counters delete themselves" },
];

export function indexesForFeatures(features: readonly string[]): IndexDefinition[] {
  return INDEXES.filter((index) => features.includes(index.feature));
}

/**
 * Create the given indexes. Creating an index that already exists with the same keys and options
 * does nothing, so this is safe to run again. Note: it also creates the collection if missing.
 */
export async function ensureIndexes(db: Db, indexes: readonly IndexDefinition[]): Promise<string[]> {
  const created: string[] = [];
  for (const index of indexes) {
    await db.collection(index.collection).createIndex(index.keys, { ...index.options, name: index.name });
    created.push(`${index.collection}.${index.name}`);
  }
  return created;
}
