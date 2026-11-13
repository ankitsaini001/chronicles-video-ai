// Database settings from the environment (docs/DATABASE.md §2).
// This file has NO imports from the MongoDB driver, so the website's start-up check can use it
// without loading the driver.

export interface DbConfig {
  /** Full Atlas connection string, including the password. A secret: never log or show it. */
  uri: string;
  /** Database name inside the cluster. */
  dbName: string;
}

export type DbConfigResult = { ok: true; config: DbConfig } | { ok: false; problems: string[] };

/** Used when MONGODB_DB is not set (docs/DATABASE.md §2). */
export const DEFAULT_DB_NAME = "bytereel";

const SCHEME = /^mongodb(\+srv)?:\/\//;
const PLACEHOLDER = /<db_(password|username)>|<password>|<username>/i;
const DB_NAME = /^[A-Za-z0-9_-]{1,38}$/;

/**
 * Check MONGODB_URI and MONGODB_DB. Problems are plain sentences that say how to fix them and
 * never contain the connection string itself (it holds the password).
 */
export function readDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfigResult {
  const problems: string[] = [];
  const uri = env.MONGODB_URI?.trim() ?? "";
  const dbName = env.MONGODB_DB?.trim() || DEFAULT_DB_NAME;

  if (uri === "") {
    problems.push(
      "MONGODB_URI is missing. Add it to the .env file in the project root (Atlas → your cluster → Connect → Drivers → copy the connection string).",
    );
  } else if (!SCHEME.test(uri)) {
    problems.push('MONGODB_URI must start with "mongodb+srv://" (the Atlas connection string). Check the value in .env.');
  } else if (PLACEHOLDER.test(uri)) {
    problems.push("MONGODB_URI still contains a placeholder like <db_password>. Replace it, including the < >, with the real value.");
  } else if (/\s/.test(uri)) {
    problems.push("MONGODB_URI contains a space or a line break. It must be one line with no spaces.");
  } else {
    const shape = connectionStringShapeProblem(uri);
    if (shape) problems.push(shape);
  }

  if (!DB_NAME.test(dbName)) {
    problems.push(`MONGODB_DB must be a simple name like "${DEFAULT_DB_NAME}" (letters, numbers, - or _).`);
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, config: { uri, dbName } };
}

const ENCODE_HINT = "Special characters in the password must be URL-encoded (@ → %40, / → %2F, : → %3A, # → %23, ? → %3F).";

/**
 * Catch the most common copy-paste mistakes without loading the driver, so the website's start-up
 * check can report them too. The driver does the full check when it connects.
 */
function connectionStringShapeProblem(uri: string): string | undefined {
  const rest = uri.replace(SCHEME, "");
  const at = rest.lastIndexOf("@");
  if (at === -1) return "MONGODB_URI has no user name and password (expected mongodb+srv://USER:PASSWORD@cluster…).";
  const userInfo = rest.slice(0, at);
  if (userInfo.includes("@") || /[/?#]/.test(userInfo) || (userInfo.match(/:/g) ?? []).length > 1) {
    return `MONGODB_URI is not valid: the password seems to contain a character that must be encoded. ${ENCODE_HINT}`;
  }
  const host = rest.slice(at + 1).split(/[/?]/)[0] ?? "";
  if (uri.startsWith("mongodb+srv://") && host.includes(":")) {
    return "MONGODB_URI is not valid: a mongodb+srv:// address can't include a port number (remove the :27017 part).";
  }
  return undefined;
}

/**
 * Hide the user name and password inside any text that might contain a connection string.
 * Everything up to the LAST "@" of the address is hidden, so a password containing "@" or "/"
 * can't leak. Optional `secrets` (e.g. the configured password) are also masked anywhere.
 */
export function redactConnectionString(text: string, secrets: readonly string[] = []): string {
  let result = text.replace(/(mongodb(?:\+srv)?:\/\/)\S*@/gi, "$1***@");
  for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join("***");
  return result;
}

/** The password inside a connection string (raw and decoded), for `redactConnectionString`. */
export function passwordsIn(uri: string): string[] {
  const rest = uri.replace(SCHEME, "");
  const at = rest.lastIndexOf("@");
  if (at === -1) return [];
  const userInfo = rest.slice(0, at);
  const colon = userInfo.indexOf(":");
  if (colon === -1) return [];
  const raw = userInfo.slice(colon + 1);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  return [...new Set([raw, decoded])];
}
