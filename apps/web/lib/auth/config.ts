// Login settings from the environment (docs/ARCHITECTURE.md §10, §26.2).
// No imports, so the start-up check (instrumentation.ts) can use it without loading Better Auth.

export interface AuthConfig {
  /** Signs the session cookie. A secret: never log or show it. */
  secret: string;
  /** The app's address, e.g. http://localhost:3000 (no path). */
  baseURL: string;
  /** Origin allowed to send sign-up/login requests (API.md §3.6): the origin of baseURL. */
  appOrigin: string;
}

export type AuthConfigResult = { ok: true; config: AuthConfig } | { ok: false; problems: string[] };

/** Better Auth's own minimum for a safe secret. */
export const MIN_SECRET_LENGTH = 32;

/**
 * Check BETTER_AUTH_SECRET and BETTER_AUTH_URL. Problems are plain sentences that say how to fix
 * them and never contain the secret.
 */
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfigResult {
  const problems: string[] = [];
  const secret = env.BETTER_AUTH_SECRET?.trim() ?? "";
  const rawUrl = env.BETTER_AUTH_URL?.trim() ?? "";

  if (secret === "") {
    problems.push("BETTER_AUTH_SECRET is missing. Add it to the .env file in the project root. Make one with: openssl rand -base64 32");
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(`BETTER_AUTH_SECRET is too short (it needs at least ${MIN_SECRET_LENGTH} characters). Make a new one with: openssl rand -base64 32`);
  }

  let appOrigin = "";
  if (rawUrl === "") {
    problems.push("BETTER_AUTH_URL is missing. Add it to the .env file in the project root: http://localhost:3000 on your computer.");
  } else {
    let url: URL | undefined;
    try {
      url = new URL(rawUrl);
    } catch {
      url = undefined;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      problems.push('BETTER_AUTH_URL must be just the app\'s address, like "http://localhost:3000" (no path at the end).');
    } else {
      appOrigin = url.origin;
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, config: { secret, baseURL: appOrigin, appOrigin } };
}
