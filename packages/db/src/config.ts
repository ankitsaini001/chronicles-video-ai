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
  }

  if (!DB_NAME.test(dbName)) {
    problems.push(`MONGODB_DB must be a simple name like "${DEFAULT_DB_NAME}" (letters, numbers, - or _).`);
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, config: { uri, dbName } };
}

/** Hide the user name and password inside any text that might contain a connection string. */
export function redactConnectionString(text: string): string {
  return text.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, "$1***@");
}
