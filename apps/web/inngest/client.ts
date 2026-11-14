import { Inngest } from "inngest";
import { SITE } from "../lib/site";

// The Inngest client (ARCHITECTURE §13): background jobs that keep running after the request ends,
// with durable steps and retries. Server code only.
//
// Two modes, chosen here explicitly (never left to a guess):
// - On Vercel (production / preview): cloud mode. INNGEST_EVENT_KEY (to send events) and
//   INNGEST_SIGNING_KEY (Inngest's calls to /api/inngest are signed and checked) must be set, and
//   the dev-mode switch INNGEST_DEV must NOT be set (it turns signature checks off). F38 sets this up.
// - On your computer: dev mode, talking to the local Inngest Dev Server (`npm run inngest`,
//   http://localhost:8288). No keys needed. INNGEST_DEV may name another Dev Server address (the
//   automated test uses http://localhost:8299).

/** The app id in Inngest. From the product name (SITE.name), so a rename only touches lib/site.ts (BRAND.md §10). */
export const INNGEST_APP_ID = SITE.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** Event that starts the storyboard job (API.md C2, E2). Carries ids only (ARCHITECTURE §13.2). */
export const PLAN_REQUESTED = "plan.requested";

export type InngestSetup = { ok: true; dev: boolean; client: Inngest } | { ok: false; problem: string };

/** Why Inngest can't be used with these settings, or null when it can. */
export function inngestProblem(env: NodeJS.ProcessEnv): string | null {
  const onVercel = Boolean(env.VERCEL || env.VERCEL_ENV);
  if (onVercel) {
    if (env.INNGEST_DEV) return "INNGEST_DEV is set on Vercel. Remove it: dev mode turns off Inngest's signature check.";
    if (!env.INNGEST_EVENT_KEY?.trim()) return "INNGEST_EVENT_KEY is missing in Vercel's environment variables (Inngest dashboard → Event keys).";
    if (!env.INNGEST_SIGNING_KEY?.trim()) return "INNGEST_SIGNING_KEY is missing in Vercel's environment variables (Inngest dashboard → Signing key).";
    return null;
  }
  const dev = env.INNGEST_DEV?.trim();
  if (dev && dev !== "1" && !/^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/?$/.test(dev)) {
    return 'INNGEST_DEV must be empty, "1", or a local Dev Server address like http://localhost:8288.';
  }
  return null;
}

let cached: { key: string; setup: InngestSetup } | null = null;

export function getInngest(env: NodeJS.ProcessEnv = process.env): InngestSetup {
  const key = [env.VERCEL, env.VERCEL_ENV, env.INNGEST_DEV, Boolean(env.INNGEST_EVENT_KEY), Boolean(env.INNGEST_SIGNING_KEY)].join("|");
  if (cached?.key === key) return cached.setup;
  const problem = inngestProblem(env);
  const dev = !(env.VERCEL || env.VERCEL_ENV);
  const setup: InngestSetup = problem ? { ok: false, problem } : { ok: true, dev, client: new Inngest({ id: INNGEST_APP_ID, isDev: dev }) };
  cached = { key, setup };
  return setup;
}
