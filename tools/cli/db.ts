import { parseArgs } from "node:util";
import {
  closeMongoClient,
  ensureIndexes,
  explainDbError,
  getDb,
  INDEX_FEATURES,
  INDEXES,
  indexesForFeatures,
  passwordsIn,
  ping,
  readDbConfig,
  redactConnectionString,
} from "@bytereel/db";
import { loadLocalEnvFile } from "@bytereel/pipeline/config/config";

/**
 * Database commands (F06). Reads MONGODB_URI / MONGODB_DB from .env in the project root.
 *   npm run db -- ping             connection check that writes nothing
 *   npm run db -- indexes [--feature F08 ...] [--apply]
 *                                  list the indexes; --apply creates those of the given features
 * Exit codes: 0 = ok, 1 = failed, 2 = usage error.
 */

const USAGE = `Usage:
  npm run db -- ping
  npm run db -- indexes [--feature ${INDEX_FEATURES.join("|")} ...] [--apply]`;

const COMMANDS = ["ping", "indexes"] as const;
type Command = (typeof COMMANDS)[number];
type Print = (lines: string[]) => void;

interface Parsed {
  command: Command;
  features: string[];
  apply: boolean;
}

/** Read and check the command line before anything connects. Returns an error text on bad input. */
function parseCommand(argv: string[]): Parsed | string {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) return "Unknown command.";
  if (command !== "indexes" && rest.length > 0) return `"${command}" takes no options.`;
  let values: { feature?: string[] | undefined; apply?: boolean | undefined };
  try {
    values = parseArgs({ args: rest, options: { feature: { type: "string", multiple: true }, apply: { type: "boolean" } }, strict: true }).values;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid options.";
  }
  const features = (values.feature ?? []).map((f) => f.toUpperCase());
  const unknown = features.filter((f) => !INDEX_FEATURES.includes(f));
  if (unknown.length) return `Unknown feature ${unknown.join(", ")}. Features with indexes: ${INDEX_FEATURES.join(", ")}.`;
  const apply = values.apply ?? false;
  if (apply && features.length === 0) return "--apply needs at least one --feature (each feature creates only its own indexes).";
  return { command: command as Command, features, apply };
}

export async function runDbCommand(argv: string[], print: Print, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseCommand(argv);
  if (typeof parsed === "string") {
    print([parsed, "", USAGE]);
    return 2;
  }

  if (parsed.command === "indexes" && !parsed.apply) {
    const list = parsed.features.length ? indexesForFeatures(parsed.features) : INDEXES;
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
  const secrets = passwordsIn(result.config.uri);
  const safePrint: Print = (lines) => print(lines.map((l) => redactConnectionString(l, secrets)));

  try {
    const db = getDb(result.config);
    switch (parsed.command) {
      case "ping": {
        const r = await ping(db);
        safePrint([r.ok ? `MongoDB answered the ping ✓ (${r.roundTripMs} ms). Nothing was written.` : "MongoDB answered, but the ping was not ok."]);
        return r.ok ? 0 : 1;
      }
      case "indexes": {
        const created = await ensureIndexes(db, indexesForFeatures(parsed.features));
        safePrint([`Indexes in place (${created.length}):`, ...created.map((c) => `  ${c}`)]);
        return 0;
      }
    }
  } catch (error) {
    const explained = explainDbError(error, secrets);
    safePrint(["Could not complete the database command.", `  ${explained.message}`, `  Detail: ${explained.detail}`]);
    return 1;
  } finally {
    await closeMongoClient();
  }
}

// Run when called directly (npm run db -- ...).
if (import.meta.main) {
  loadLocalEnvFile(".env");
  process.exitCode = await runDbCommand(process.argv.slice(2), (lines) => console.log(lines.join("\n")));
}
