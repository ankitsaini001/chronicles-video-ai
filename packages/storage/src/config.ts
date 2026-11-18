// R2 settings from the environment (docs/ARCHITECTURE.md §9, F22).
// No imports from the AWS SDK, so a start-up check can use this file without loading it.

export interface R2Config {
  /** Cloudflare account ID (32 hex characters). Treated as private: never log or show it. */
  accountId: string;
  /** R2 API token access key ID. A secret: never log or show it. */
  accessKeyId: string;
  /** R2 API token secret access key. A secret: never log or show it. */
  secretAccessKey: string;
  /** The private bucket, e.g. "reel-app-dev". */
  bucket: string;
}

export type R2ConfigResult = { ok: true; config: R2Config } | { ok: false; problems: string[] };

export const R2_ENV_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const TOKEN_PART = /^[A-Za-z0-9+/=_-]{16,256}$/;
// R2 bucket names: 3-63 characters, lowercase letters, digits and "-", not starting or ending with "-".
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

const WHERE = "Add it to the .env file in the project root (see .env.example and docs/features/F22-r2-storage.md).";

/**
 * Check the four R2 variables. Every problem names the variable and says how to fix it, and
 * never contains the value itself (values are secrets or private).
 */
export function readR2Config(env: NodeJS.ProcessEnv = process.env): R2ConfigResult {
  const problems: string[] = [];
  const value = (name: (typeof R2_ENV_VARS)[number]) => env[name]?.trim() ?? "";
  const accountId = value("R2_ACCOUNT_ID");
  const accessKeyId = value("R2_ACCESS_KEY_ID");
  const secretAccessKey = value("R2_SECRET_ACCESS_KEY");
  const bucket = value("R2_BUCKET");

  for (const name of R2_ENV_VARS) if (value(name) === "") problems.push(`${name} is missing. ${WHERE}`);

  if (accountId !== "" && !ACCOUNT_ID.test(accountId)) {
    problems.push(
      accountId.includes("r2.cloudflarestorage.com")
        ? "R2_ACCOUNT_ID must be only the account ID (32 letters and digits), not the full https:// address."
        : "R2_ACCOUNT_ID doesn't look like a Cloudflare account ID (32 lowercase letters a-f and digits; Cloudflare → R2 → Overview → Account Details).",
    );
  }
  if (accessKeyId !== "" && !TOKEN_PART.test(accessKeyId)) {
    problems.push("R2_ACCESS_KEY_ID doesn't look right (no spaces or quotes; copy the Access Key ID shown when the R2 API token was created).");
  }
  if (secretAccessKey !== "" && !TOKEN_PART.test(secretAccessKey)) {
    problems.push("R2_SECRET_ACCESS_KEY doesn't look right (no spaces or quotes; copy the Secret Access Key shown when the R2 API token was created).");
  }
  if (bucket !== "" && !BUCKET.test(bucket)) {
    problems.push('R2_BUCKET must be a bucket name like "reel-app-dev" (lowercase letters, digits and -, 3 to 63 characters).');
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, config: { accountId, accessKeyId, secretAccessKey, bucket } };
}

/** The S3-compatible R2 address for an account (ARCHITECTURE §9). Contains the account ID: don't print it. */
export function r2Endpoint(accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error("R2 account ID is not valid");
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/** Hide the account ID, access key ID and secret anywhere in a text (for error messages before printing). */
export function redactR2(text: string, config: Pick<R2Config, "accountId" | "accessKeyId" | "secretAccessKey">): string {
  let result = text;
  for (const secret of [config.secretAccessKey, config.accessKeyId, config.accountId]) {
    if (secret.length >= 4) result = result.split(secret).join("[hidden]");
  }
  return result;
}
