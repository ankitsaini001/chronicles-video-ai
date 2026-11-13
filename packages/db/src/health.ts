import type { Db } from "mongodb";

// F06 connection test (docs/DATABASE.md §4.7 and Q16). It writes ONE record you can see in Atlas
// (Data Explorer → bytereel → healthchecks), reads it back, and is removed again by
// `cleanupHealthCheck` once the founder has seen it. Later health checks use `ping`, which writes
// nothing.

export const HEALTHCHECK_COLLECTION = "healthchecks";
/** Fixed id, so running the check again updates the same record instead of adding more. */
export const HEALTHCHECK_ID = "f06-connection-test";

export interface HealthRecord {
  _id: string;
  message: string;
  writtenBy: string;
  writtenAt: Date;
  schemaVersion: 1;
}

export interface HealthCheckResult {
  database: string;
  collection: string;
  record: HealthRecord;
  /** Time for the write + read round trip, in milliseconds. */
  roundTripMs: number;
}

/** Write the test record, read it back, and confirm it is the same. */
export async function runHealthCheck(db: Db, now: Date = new Date()): Promise<HealthCheckResult> {
  const collection = db.collection<HealthRecord>(HEALTHCHECK_COLLECTION);
  const record: HealthRecord = {
    _id: HEALTHCHECK_ID,
    message: "Hello from ByteReel! If you can read this in Atlas, the app is connected to your database.",
    writtenBy: "npm run db -- check (F06)",
    writtenAt: now,
    schemaVersion: 1,
  };
  await db.command({ ping: 1 }); // connect first, so the timing below is the write + read only
  const started = Date.now();
  await collection.replaceOne({ _id: HEALTHCHECK_ID }, record, { upsert: true });
  const readBack = await collection.findOne({ _id: HEALTHCHECK_ID });
  const roundTripMs = Date.now() - started;
  if (!readBack || readBack.writtenAt.getTime() !== now.getTime()) {
    throw new Error("The test record was written but could not be read back unchanged.");
  }
  return { database: db.databaseName, collection: HEALTHCHECK_COLLECTION, record: readBack, roundTripMs };
}

/** Delete the test record and the `healthchecks` collection (end of F06). Safe to run twice. */
export async function cleanupHealthCheck(db: Db): Promise<{ dropped: boolean }> {
  const exists = (await db.listCollections({ name: HEALTHCHECK_COLLECTION }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) return { dropped: false };
  await db.collection(HEALTHCHECK_COLLECTION).drop();
  return { dropped: true };
}

/** Lightweight check that writes nothing (used after F06). */
export async function ping(db: Db): Promise<{ ok: boolean; roundTripMs: number }> {
  await db.command({ ping: 1 }); // the first command also opens the connection; time the second
  const started = Date.now();
  const result = await db.command({ ping: 1 });
  return { ok: result.ok === 1, roundTripMs: Date.now() - started };
}
