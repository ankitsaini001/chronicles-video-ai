import { readDbConfig } from "@bytereel/db";
import { readInstagramConfig } from "./config";
import { FakeInstagramApi } from "./fake-instagram";
import { MetaInstagramApi, type InstagramApi } from "./meta-client";

// Which Instagram G2/G3 talk to (F28, server only): the real one (INSTAGRAM_APP_ID,
// INSTAGRAM_APP_SECRET, the redirect address), or the stand-in when E2E_FAKE_INSTAGRAM=1.
// The stand-in is allowed ONLY on a local test server: database `bytereel_test`, address
// http://localhost:3230–3239, not on Vercel; set anywhere else, connecting refuses to start. And the
// other way round: on the test database the REAL Instagram is refused, so a test can never call Meta.

export const FAKE_INSTAGRAM_ENV = "E2E_FAKE_INSTAGRAM";
const TEST_DB = "bytereel_test";
const TEST_ORIGIN = /^http:\/\/localhost:323\d$/;

function databaseName(env: NodeJS.ProcessEnv): string | null {
  const settings = readDbConfig(env);
  return settings.ok ? settings.config.dbName : null;
}

/** Why the stand-in switch can't be used here, or null when it is off or allowed. */
export function fakeInstagramProblem(env: NodeJS.ProcessEnv): string | null {
  const flag = env[FAKE_INSTAGRAM_ENV];
  if (flag === undefined || flag === "") return null;
  if (flag !== "1") return `${FAKE_INSTAGRAM_ENV} must be "1" or unset.`;
  if (env.VERCEL || env.VERCEL_ENV) return `${FAKE_INSTAGRAM_ENV} is set on Vercel. Remove it from the project's environment variables.`;
  if (databaseName(env) !== TEST_DB) return `${FAKE_INSTAGRAM_ENV} is only allowed with MONGODB_DB=${TEST_DB}.`;
  if (!TEST_ORIGIN.test(env.BETTER_AUTH_URL ?? "")) return `${FAKE_INSTAGRAM_ENV} is only allowed on a local test server (http://localhost:3230–3239).`;
  return null;
}

export function isFakeInstagram(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FAKE_INSTAGRAM_ENV] === "1" && fakeInstagramProblem(env) === null;
}

export type InstagramApiResult = { ok: true; api: InstagramApi; fake: boolean } | { ok: false; problems: string[] };

export function instagramApiFromEnv(env: NodeJS.ProcessEnv = process.env): InstagramApiResult {
  const problem = fakeInstagramProblem(env);
  if (problem) return { ok: false, problems: [problem] };
  if (env[FAKE_INSTAGRAM_ENV] === "1") return { ok: true, fake: true, api: new FakeInstagramApi(new URL(env.BETTER_AUTH_URL!).origin) };
  if (databaseName(env) === TEST_DB) return { ok: false, problems: [`The real Instagram is never used with MONGODB_DB=${TEST_DB}. Set ${FAKE_INSTAGRAM_ENV}=1 for tests.`] };
  const config = readInstagramConfig(env);
  if (!config.ok) return { ok: false, problems: config.problems };
  return { ok: true, fake: false, api: new MetaInstagramApi(config.config) };
}
