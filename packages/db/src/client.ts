import { type Db, MongoClient } from "mongodb";
import type { DbConfig } from "./config";

// One MongoDB client for the whole server process (docs/DATABASE.md §9).
// On Vercel a server function can start many times, and in `next dev` files are reloaded on every
// edit. If each start made a new client, we would open hundreds of connections and hit the free
// cluster's limit (500). So the client is kept on `globalThis` and reused.

const GLOBAL_KEY = Symbol.for("bytereel.mongoClient");

interface CachedClient {
  uri: string;
  client: MongoClient;
}

type GlobalWithClient = typeof globalThis & { [GLOBAL_KEY]?: CachedClient };

/** Options shared by every connection. */
export const CLIENT_OPTIONS = {
  appName: "bytereel",
  /** Give up after 10 s instead of hanging when the cluster can't be reached. */
  serverSelectionTimeoutMS: 10_000,
  /** Small pool: serverless functions each hold their own. */
  maxPoolSize: 10,
} as const;

/**
 * The shared client. Creating it does not connect yet: the driver connects on the first command.
 * A different connection string (e.g. in tests) replaces the cached client.
 */
export function getMongoClient(config: DbConfig): MongoClient {
  const g = globalThis as GlobalWithClient;
  const cached = g[GLOBAL_KEY];
  if (cached && cached.uri === config.uri) return cached.client;
  if (cached) void cached.client.close().catch(() => undefined);
  const client = new MongoClient(config.uri, CLIENT_OPTIONS);
  g[GLOBAL_KEY] = { uri: config.uri, client };
  return client;
}

/** The ByteReel database (MONGODB_DB, default "bytereel"). */
export function getDb(config: DbConfig): Db {
  return getMongoClient(config).db(config.dbName);
}

/** Close the shared client (command-line tools call this before exiting). */
export async function closeMongoClient(): Promise<void> {
  const g = globalThis as GlobalWithClient;
  const cached = g[GLOBAL_KEY];
  if (!cached) return;
  delete g[GLOBAL_KEY];
  await cached.client.close();
}
