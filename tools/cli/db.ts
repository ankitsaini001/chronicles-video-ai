import { parseArgs } from "node:util";
import {
  cleanupHealthCheck,
  closeMongoClient,
  ensureIndexes,
  explainDbError,
  getDb,
  INDEXES,
  indexesForFeatures,
  ping,
  readDbConfig,
  redactConnectionString,
  runHealthCheck,
} from "@bytereel/db";
import { loadLocalEnvFile } from "@bytereel/pipeline/config/config";

/**
 * Database commands (F06). Reads MONGODB_URI / MONGODB_DB from .env in the project root.
 *   npm run db -- check            write + read one test record (see it in Atlas → Data Explorer)
 *   npm run db -- ping             connection check that writes nothing
 *   npm run db -- cleanup          delete the test record and the healthchecks collection
 *   npm run db -- indexes [--feature F08 ...] [--apply]
 *                                  list the indexes; --apply creates those of the given features
 * Exit codes: 0 = ok, 1 = failed, 2 = usage error.
 */

const USAGE = `Usage:
  npm run db -- check
  npm run db -- ping
  npm run db -- cleanup
  npm run db -- indexes [--feature F07|F08 ...] [--apply]`;

type Print = (lines: string[]) => void;

export async function runDbCommand(argv: string[], print: Print, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || !["check", "ping", "cleanup", "indexes"].includes(command)) {
    print([USAGE]);
    return 2;
  }

  if (command === "indexes" && !rest.includes("--apply")) {
    const { values } = parseArgs({ args: rest, options: { feature: { type: "string", multiple: true } }, strict: true });
    const list = values.feature ? indexesForFeatures(values.feature) : INDEXES;
    print([
      "Indexes (docs/DATABASE.md §8). Nothing was changed; add --apply to create them.",
      ...list.map((i) => `  ${i.feature}  ${i.collection}.${i.name}  ${JSON.stringify(i.keys)}${Object.keys(i.options).length ? " " + JSON.stringify(i.options) : ""}  - ${i.why}`),
    ]);
    return 0;
  }

  const result = readDbConfig(env);
  if (!result.ok) {
    print(["Database settings problem (nothing was sent to MongoDB):", ...result.problems.map((p) => `  - ${p}`)]);
    return 1;
  }
  const db = getDb(result.config);

  try {
    switch (command) {
      case "check": {
        const r = await runHealthCheck(db);
        print([
          "Connected to MongoDB ✓",
          `  Wrote and read back 1 test record in ${r.roundTripMs} ms.`,
          `  See it in Atlas: Data Explorer → bytereel-dev → ${r.database} → ${r.collection}`,
          `  Record: _id "${r.record._id}", message "${r.record.message}", writtenAt ${r.record.writtenAt.toISOString()}`,
          "  When you have seen it, remove it with: npm run db -- cleanup",
        ]);
        return 0;
      }
      case "ping": {
        const r = await ping(db);
        print([r.ok ? `MongoDB answered the ping ✓ (${r.roundTripMs} ms). Nothing was written.` : "MongoDB answered, but the ping was not ok."]);
        return r.ok ? 0 : 1;
      }
      case "cleanup": {
        const r = await cleanupHealthCheck(db);
        print([r.dropped ? `Deleted the test record and the healthchecks collection from "${db.databaseName}".` : "Nothing to clean up: the healthchecks collection does not exist."]);
        return 0;
      }
      case "indexes": {
        const { values } = parseArgs({ args: rest, options: { feature: { type: "string", multiple: true }, apply: { type: "boolean" } }, strict: true });
        if (!values.feature?.length) {
          print(["--apply needs at least one --feature (each feature creates only its own indexes).", "", USAGE]);
          return 2;
        }
        const created = await ensureIndexes(db, indexesForFeatures(values.feature));
        print([`Indexes in place (${created.length}):`, ...created.map((c) => `  ${c}`)]);
        return 0;
      }
    }
    return 2;
  } catch (error) {
    const explained = explainDbError(error);
    print(["Could not complete the database command.", `  ${explained.message}`, `  Detail: ${explained.detail}`]);
    return 1;
  } finally {
    await closeMongoClient();
  }
}

// Run when called directly (npm run db -- ...).
if (import.meta.main) {
  loadLocalEnvFile(".env");
  const print: Print = (lines) => console.log(redactConnectionString(lines.join("\n")));
  process.exitCode = await runDbCommand(process.argv.slice(2), print);
}
