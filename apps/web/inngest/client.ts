import { Inngest } from "inngest";

// The Inngest client (ARCHITECTURE §13): background jobs that keep running after the request ends,
// with durable steps and retries. Server code only.
//
// Two modes, chosen here explicitly (never left to a guess):
// - Dev mode ONLY when asked for: INNGEST_DEV is "1" or a local Dev Server address. `npm run dev`
//   sets INNGEST_DEV=1 for you (apps/web/scripts/dev.mjs); the app then talks to the local Inngest
//   Dev Server (`npm run inngest`, http://localhost:8288) and needs no keys. Dev mode turns off
//   Inngest's signature check, so it is refused on Vercel, and in a production build
//   (NODE_ENV=production) it is allowed only with a local Dev Server ADDRESS (the automated test's
//   http://localhost:8299 on a `next start` test server), never with a bare "1".
// - Otherwise cloud mode: INNGEST_EVENT_KEY (to send events) and INNGEST_SIGNING_KEY (Inngest's
//   calls to /api/inngest are signed and checked) must both be set, on any host. F38 sets this up.

/**
 * The app id in Inngest. A FIXED, brand-neutral id: never derived from the product name, because
 * changing it makes Inngest Cloud see a new app (BRAND.md §10: do not change it on a rename).
 */
export const INNGEST_APP_ID = "reel-app";

/** Event that starts the storyboard job (API.md C2, E2). Carries ids only (ARCHITECTURE §13.2). */
export const PLAN_REQUESTED = "plan.requested";

/** Event that starts a storyboard change (API.md D5, E2; F18). Carries ids only. */
export const REVISION_REQUESTED = "revision.requested";

/** Event that starts the video job (API.md D8, E2; F23). Carries ids only. */
export const VIDEO_GENERATE_REQUESTED = "video.generate.requested";

/** Event that starts a caption-fix re-render (API.md F4, E2; F25). Carries ids only. */
export const VIDEO_RECAPTION_REQUESTED = "video.recaption.requested";

/**
 * Only ONE video job step runs at a time across the whole app (F23, founder 2026-11-15), shared by
 * `generate-video` and `fix-captions` (F25: a caption fix re-renders the video): renders run
 * on this computer, and one render at a time keeps the machine (and the founder's dev server)
 * usable. Inngest counts steps, so two videos may take turns between steps, but a render (one step)
 * never overlaps another. Other videos wait ("Waiting to start…"). `scope: "env"` with a fixed key.
 */
export const VIDEO_CONCURRENCY: [{ scope: "env"; key: string; limit: number }] = [{ scope: "env", key: '"video-render"', limit: 1 }];

/**
 * Storyboard AI work shares ONE limit across `plan-video` and `revise-plan` (F16–F20 review): at most
 * 2 runs per creator and 5 in total at the same time, whichever function they are in. `scope: "env"`
 * makes a keyed limit count across functions of this environment; the keys are fixed strings, never
 * the product name.
 */
export const PLANNER_CONCURRENCY: [{ scope: "env"; key: string; limit: number }, { scope: "env"; key: string; limit: number }] = [
  { scope: "env", key: '"planner-owner-" + event.data.ownerId', limit: 2 },
  { scope: "env", key: '"planner-all"', limit: 5 },
];

export type InngestSetup = { ok: true; dev: boolean; client: Inngest } | { ok: false; problem: string };

const LOCAL_DEV_SERVER = /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/?$/;

/** Dev mode is on only when INNGEST_DEV asks for it ("1" or a local Dev Server address). */
export function inngestDevMode(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.INNGEST_DEV?.trim());
}

/** Why Inngest can't be used with these settings, or null when it can. */
export function inngestProblem(env: NodeJS.ProcessEnv): string | null {
  const onVercel = Boolean(env.VERCEL || env.VERCEL_ENV);
  const dev = env.INNGEST_DEV?.trim();
  if (dev) {
    if (onVercel) return "INNGEST_DEV is set on Vercel. Remove it: dev mode turns off Inngest's signature check.";
    if (dev !== "1" && !LOCAL_DEV_SERVER.test(dev)) return 'INNGEST_DEV must be empty, "1", or a local Dev Server address like http://localhost:8288.';
    if (env.NODE_ENV === "production" && !LOCAL_DEV_SERVER.test(dev)) {
      return "INNGEST_DEV=1 is not allowed in a production build: dev mode turns off Inngest's signature check. Set INNGEST_SIGNING_KEY and INNGEST_EVENT_KEY instead.";
    }
    return null;
  }
  if (!env.INNGEST_EVENT_KEY?.trim()) return "INNGEST_EVENT_KEY is missing (Inngest dashboard → Event keys). On your computer, start the site with `npm run dev`, which uses the local Inngest Dev Server instead.";
  if (!env.INNGEST_SIGNING_KEY?.trim()) return "INNGEST_SIGNING_KEY is missing (Inngest dashboard → Signing key). On your computer, start the site with `npm run dev`, which uses the local Inngest Dev Server instead.";
  return null;
}

let cached: { key: string; setup: InngestSetup } | null = null;

export function getInngest(env: NodeJS.ProcessEnv = process.env): InngestSetup {
  const key = [env.VERCEL, env.VERCEL_ENV, env.NODE_ENV, env.INNGEST_DEV, Boolean(env.INNGEST_EVENT_KEY), Boolean(env.INNGEST_SIGNING_KEY)].join("|");
  if (cached?.key === key) return cached.setup;
  const problem = inngestProblem(env);
  const dev = inngestDevMode(env);
  const setup: InngestSetup = problem ? { ok: false, problem } : { ok: true, dev, client: new Inngest({ id: INNGEST_APP_ID, isDev: dev }) };
  cached = { key, setup };
  return setup;
}
