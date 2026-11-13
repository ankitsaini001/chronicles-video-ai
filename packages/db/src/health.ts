import type { Db } from "mongodb";

// Health check (docs/DATABASE.md Q16). F06 proved the connection by writing one test record to a
// temporary `healthchecks` collection, which the founder saw in Atlas and which was then deleted
// (2026-11-13). From now on a ping is enough: it checks the connection and writes nothing.

/** Lightweight check that writes nothing. */
export async function ping(db: Db): Promise<{ ok: boolean; roundTripMs: number }> {
  await db.command({ ping: 1 }); // the first command also opens the connection; time the second
  const started = Date.now();
  const result = await db.command({ ping: 1 });
  return { ok: result.ok === 1, roundTripMs: Date.now() - started };
}
