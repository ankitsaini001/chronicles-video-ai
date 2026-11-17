import { serve } from "inngest/next";
import { createFixCaptionsFunction } from "@/inngest/functions/fix-captions";
import { createGenerateVideoFunction } from "@/inngest/functions/generate-video";
import { createPlanVideoFunction } from "@/inngest/functions/plan-video";
import { createRevisePlanFunction } from "@/inngest/functions/revise-plan";
import { getInngest } from "@/inngest/client";

// /api/inngest (ARCHITECTURE §13, §26.3): Inngest calls this address to run our background jobs
// step by step. Locally the Inngest Dev Server (`npm run inngest`) calls it; on Vercel, Inngest
// Cloud does, and every call is signed (INNGEST_SIGNING_KEY) and checked by the SDK.
// If Inngest isn't set up correctly (e.g. dev mode switched on on Vercel), every call gets a 500
// and the reason goes to the server log only.

/**
 * One step may wait up to 240 s for Gemini (PLAN_REQUEST_TIMEOUT_MS; keep it well under this, the
 * step also writes to the database); 300 s is the most a Vercel function can run (Hobby, fluid
 * compute). The F23 render step runs on this computer (about 2–4 min, no Vercel limit there); where
 * videos are rendered online is decided at go-live (F38).
 */
export const maxDuration = 300;

type Handler = (request: Request, context: unknown) => Promise<Response>;

function handlers(): { GET: Handler; POST: Handler; PUT: Handler } | null {
  const setup = getInngest(process.env);
  if (!setup.ok) {
    console.error(`Inngest is not set up: ${setup.problem}`);
    return null;
  }
  return serve({ client: setup.client, functions: [createPlanVideoFunction(setup.client), createRevisePlanFunction(setup.client), createGenerateVideoFunction(setup.client), createFixCaptionsFunction(setup.client)] }) as unknown as { GET: Handler; POST: Handler; PUT: Handler };
}

let served: ReturnType<typeof handlers> | undefined;
const route = (method: "GET" | "POST" | "PUT"): Handler => async (request, context) => {
  served ??= handlers();
  if (!served) return Response.json({ error: { code: "INTERNAL", message: "Background jobs are not set up." } }, { status: 500 });
  return served[method](request, context);
};

export const GET = route("GET");
export const POST = route("POST");
export const PUT = route("PUT");
