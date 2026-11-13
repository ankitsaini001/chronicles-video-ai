import { parseArgs } from "node:util";
import {
  addInvite,
  closeMongoClient,
  ensureIndexes,
  explainDbError,
  getDb,
  INDEX_FEATURES,
  INDEXES,
  indexesForFeatures,
  InviteInputError,
  listInvites,
  normalizeEmail,
  passwordsIn,
  ping,
  readDbConfig,
  redactConnectionString,
  removeInvite,
} from "@bytereel/db";
import { loadLocalEnvFile } from "@bytereel/pipeline/config/config";

/**
 * Database commands. Reads MONGODB_URI / MONGODB_DB from .env in the project root.
 *   npm run db -- ping                                  connection check that writes nothing (F06)
 *   npm run db -- indexes [--feature F08 ...] [--apply] list the indexes; --apply creates those of the given features (F06)
 *   npm run db -- invite add <email> [--note "..."]     invite an email to sign up (F07)
 *   npm run db -- invite list                           show every invite and whether they signed up (F07)
 *   npm run db -- invite remove <email>                 take an invite back (F07)
 * Exit codes: 0 = ok, 1 = failed, 2 = usage error.
 */

const USAGE = `Usage:
  npm run db -- ping
  npm run db -- indexes [--feature ${INDEX_FEATURES.join("|")} ...] [--apply]
  npm run db -- invite add <email> [--note "who this is"]
  npm run db -- invite list
  npm run db -- invite remove <email>`;

type Print = (lines: string[]) => void;

type Parsed =
  | { command: "ping" }
  | { command: "indexes"; features: string[]; apply: boolean }
  | { command: "invite"; action: "add"; email: string; note: string | undefined }
  | { command: "invite"; action: "list" }
  | { command: "invite"; action: "remove"; email: string };

/** Read and check the command line before anything connects. Returns an error text on bad input. */
function parseCommand(argv: string[]): Parsed | string {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "ping":
        return rest.length ? `"ping" takes no options.` : { command };
      case "indexes": {
        const { values } = parseArgs({ args: rest, options: { feature: { type: "string", multiple: true }, apply: { type: "boolean" } }, strict: true });
        const features = (values.feature ?? []).map((f) => f.toUpperCase());
        const unknown = features.filter((f) => !INDEX_FEATURES.includes(f));
        if (unknown.length) return `Unknown feature ${unknown.join(", ")}. Features with indexes: ${INDEX_FEATURES.join(", ")}.`;
        const apply = values.apply ?? false;
        if (apply && features.length === 0) return "--apply needs at least one --feature (each feature creates only its own indexes).";
        return { command, features, apply };
      }
      case "invite": {
        const [action, ...args] = rest;
        const { values, positionals } = parseArgs({ args, options: { note: { type: "string" } }, allowPositionals: true, strict: true });
        if (action === "list") return positionals.length || values.note !== undefined ? `"invite list" takes no options.` : { command, action };
        if (action !== "add" && action !== "remove") return 'Use "invite add", "invite list" or "invite remove".';
        if (positionals.length !== 1) return `"invite ${action}" needs exactly one email.`;
        const normalized = normalizeEmail(positionals[0] ?? "");
        if (!normalized.ok) return normalized.problem;
        if (action === "remove") return values.note !== undefined ? `"invite remove" takes no --note.` : { command, action, email: normalized.email };
        return { command, action, email: normalized.email, note: values.note };
      }
      default:
        return "Unknown command.";
    }
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid options.";
  }
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
      case "invite": {
        if (parsed.action === "add") {
          const r = await addInvite(db, parsed.email, parsed.note === undefined ? {} : { note: parsed.note });
          safePrint(
            r.status === "added"
              ? [`Invited ${r.entry.email} ✓`, `  They can sign up once sign-up is built (F08). See it in Atlas: Data Explorer → your cluster → ${db.databaseName} → allowlist`]
              : [`${r.entry.email} is already on the invite list (invited ${r.entry.createdAt.toISOString().slice(0, 10)}). Nothing changed.`],
          );
          return 0;
        }
        if (parsed.action === "remove") {
          const r = await removeInvite(db, parsed.email);
          safePrint(
            r.removed
              ? [`Removed the invite for ${r.email}.`, "  This only stops future sign-ups: if they already have an account, it keeps working (suspend it from the admin page, F34)."]
              : [`${r.email} is not on the invite list. Nothing changed.`],
          );
          return 0;
        }
        const entries = await listInvites(db);
        safePrint(
          entries.length === 0
            ? ["The invite list is empty. Add someone with: npm run db -- invite add <email>"]
            : [
                `Invite list (${entries.length}):`,
                ...entries.map((e) => `  ${e.email}  invited ${e.createdAt.toISOString().slice(0, 10)}  ${e.signedUpUserId ? "signed up" : "not signed up yet"}${e.note ? `  - ${e.note}` : ""}`),
              ],
        );
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof InviteInputError) {
      safePrint([error.message]);
      return 2;
    }
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
