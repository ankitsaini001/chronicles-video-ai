import { parseArgs } from "node:util";
import { ObjectId } from "mongodb";
import {
  addInvite,
  clearCheckedPost,
  closeMongoClient,
  confirmCheckedPost,
  ensureIndexes,
  explainDbError,
  getDb,
  INDEX_FEATURES,
  INDEXES,
  indexesForFeatures,
  InviteInputError,
  isUnconfirmedPost,
  IN_FLIGHT_POST_STATES,
  listInvites,
  normalizeEmail,
  passwordsIn,
  ping,
  POSTS_COLLECTION,
  ProjectActionError,
  readDbConfig,
  redactConnectionString,
  removeInvite,
  type PostDocument,
} from "@bytereel/db";
import { loadLocalEnvFile } from "@bytereel/pipeline/config/config";

/**
 * Database commands. Reads MONGODB_URI / MONGODB_DB from .env in the project root.
 *   npm run db -- ping                                  connection check that writes nothing (F06)
 *   npm run db -- indexes [--feature F08 ...] [--apply] list the indexes; --apply creates those of the given features (F06)
 *   npm run db -- invite add <email> [--note "..."]     invite an email to sign up (F07)
 *   npm run db -- invite list                           show every invite and whether they signed up (F07)
 *   npm run db -- invite remove <email>                 take an invite back (F07)
 *   npm run db -- clear-unconfirmed-post <postId> --published <permalink> | --not-posted [--apply]
 *        (F30 ops) settle a post whose publish was never confirmed, after checking the creator's
 *        Instagram by hand. Any owner. Prints what it will change; changes nothing without --apply.
 * Exit codes: 0 = ok, 1 = failed, 2 = usage error.
 */

const USAGE = `Usage:
  npm run db -- ping
  npm run db -- indexes [--feature ${INDEX_FEATURES.join("|")} ...] [--apply]
  npm run db -- invite add <email> [--note "who this is"]
  npm run db -- invite list
  npm run db -- invite remove <email>
  npm run db -- clear-unconfirmed-post <postId> --published <https://www.instagram.com/reel/...> [--apply]
  npm run db -- clear-unconfirmed-post <postId> --not-posted [--apply]`;

const INSTAGRAM_LINK = /^https:\/\/(www\.)?instagram\.com\/[^\s]+$/;

type Print = (lines: string[]) => void;

type Parsed =
  | { command: "ping" }
  | { command: "indexes"; features: string[]; apply: boolean }
  | { command: "invite"; action: "add"; email: string; note: string | undefined }
  | { command: "invite"; action: "list" }
  | { command: "invite"; action: "remove"; email: string }
  | { command: "clear-unconfirmed-post"; postId: string; outcome: { published: string } | "not_posted"; apply: boolean };

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
      case "clear-unconfirmed-post": {
        const { values, positionals } = parseArgs({
          args: rest,
          options: { published: { type: "string" }, "not-posted": { type: "boolean" }, apply: { type: "boolean" } },
          allowPositionals: true,
          strict: true,
        });
        if (positionals.length !== 1 || !/^[0-9a-f]{24}$/.test(positionals[0] ?? "")) return '"clear-unconfirmed-post" needs exactly one post id (24 hex characters).';
        const notPosted = values["not-posted"] ?? false;
        if ((values.published !== undefined) === notPosted) return "Give exactly one of --published <link> or --not-posted.";
        if (values.published !== undefined && !INSTAGRAM_LINK.test(values.published)) return "--published needs the reel's https://www.instagram.com/... link.";
        return { command, postId: positionals[0]!, outcome: notPosted ? "not_posted" : { published: values.published! }, apply: values.apply ?? false };
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
          await ensureIndexes(db, indexesForFeatures(["F07"])); // the unique email index (safe to repeat)
          // DATABASE.md Q14: command-added entries get this note unless one is given.
          const r = await addInvite(db, parsed.email, { note: parsed.note?.trim() || "added by setup command" });
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
      case "clear-unconfirmed-post":
        return await clearUnconfirmedPost(db, parsed, safePrint);
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

/**
 * F30 ops (docs/features/F30-publish-now.md "Ops: a stuck unconfirmed post"): the founder looked at the
 * creator's Instagram by hand and settles the post. --published: the post → published with that link
 * (project → published while its current video is still the approved one). --not-posted: the
 * unconfirmed marks are cleared, so the creator can approve again. Same database functions as the
 * creator's "Check again" (audit `via: ops_cli`). Prints the plan; writes only with --apply.
 */
async function clearUnconfirmedPost(db: ReturnType<typeof getDb>, parsed: Extract<Parsed, { command: "clear-unconfirmed-post" }>, print: Print): Promise<number> {
  const post = await db.collection<PostDocument>(POSTS_COLLECTION).findOne({ _id: new ObjectId(parsed.postId) });
  if (!post) {
    print([`No post ${parsed.postId} in ${db.databaseName}. Nothing changed.`]);
    return 1;
  }
  const project = await db.collection<{ _id: ObjectId; title: string; state: string }>("projects").findOne({ _id: post.projectId }, { projection: { title: 1, state: 1 } });
  const at = (d: Date | null | undefined) => (d ? d.toISOString() : "-");
  print([
    `Post ${parsed.postId} in ${db.databaseName}`,
    `  project: "${project?.title ?? "?"}" (${project?.state ?? "missing"}), owner ${post.ownerId.toHexString()}`,
    `  account: @${post.destination.username} (${post.approval.igUserId}); state ${post.state}; first send ${at(post.firstPublishAttemptedAt)}; last send ${at(post.publishAttemptedAt)}`,
  ]);
  if (!isUnconfirmedPost(post)) {
    print(["This post is not unconfirmed (never sent, or already confirmed). Nothing to do."]);
    return 1;
  }
  if (IN_FLIGHT_POST_STATES.includes(post.state)) {
    print(["Its publish job is still working on it. Wait about 10 minutes for the job to finish, then run this again. Nothing changed."]);
    return 1;
  }
  const outcome = parsed.outcome;
  print([
    outcome === "not_posted"
      ? "Plan: mark it NOT posted (clear the unconfirmed marks; the post keeps its state). The creator can then approve and publish again."
      : `Plan: mark it PUBLISHED with ${outcome.published} (project → published if its current video is still the approved one; notification "Your reel is live").`,
  ]);
  if (!parsed.apply) {
    print(["Nothing changed. Run the same command with --apply to do it."]);
    return 0;
  }
  try {
    const ownerId = post.ownerId.toHexString();
    if (outcome === "not_posted") {
      const cleared = await clearCheckedPost(db, { ownerId, postId: parsed.postId, via: "ops_cli" });
      print([cleared ? "Done: marked not posted. The creator can approve again." : "It changed meanwhile (already settled). Nothing changed."]);
      return cleared ? 0 : 1;
    }
    const saved = await confirmCheckedPost(db, { ownerId, postId: parsed.postId, mediaId: null, permalink: outcome.published, via: "ops_cli" });
    print([saved ? `Done: marked published${saved.project?.state === "published" ? " (project published too)" : " (post only: the project has a newer video or is archived)"}.` : "It changed meanwhile (already settled). Nothing changed."]);
    return saved ? 0 : 1;
  } catch (error) {
    if (error instanceof ProjectActionError) {
      print([`Refused: ${error.message} Nothing changed.`]);
      return 1;
    }
    throw error;
  }
}

// Run when called directly (npm run db -- ...).
if (import.meta.main) {
  loadLocalEnvFile(".env");
  process.exitCode = await runDbCommand(process.argv.slice(2), (lines) => console.log(lines.join("\n")));
}
