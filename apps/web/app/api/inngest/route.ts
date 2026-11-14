import { serve } from "inngest/next";
import { createPlanVideoFunction } from "@/inngest/functions/plan-video";
import { createRevisePlanFunction } from "@/inngest/functions/revise-plan";
import { getInngest } from "@/inngest/client";

// /api/inngest (ARCHITECTURE §13, §26.3): Inngest calls this address to run our background jobs
// step by step. Locally the Inngest Dev Server (`npm run inngest`) calls it; on Vercel, Inngest
// Cloud does, and every call is signed (INNGEST_SIGNING_KEY) and checked by the SDK.
// If Inngest isn't set up correctly (e.g. dev mode switched on on Vercel), every call gets a 500
// and the reason goes to the server log only.

/** One step may wait up to 180 s for Gemini; 300 s is the most a Vercel function can run (Hobby, fluid compute). */
export const maxDuration = 300;

type Handler = (request: Request, context: unknown) => Promise<Response>;

function handlers(): { GET: Handler; POST: Handler; PUT: Handler } | null {
  const setup = getInngest(process.env);
  if (!setup.ok) {
    console.error(`Inngest is not set up: ${setup.problem}`);
    return null;
  }
  return serve({ client: setup.client, functions: [createPlanVideoFunction(setup.client), createRevisePlanFunction(setup.client)] }) as unknown as { GET: Handler; POST: Handler; PUT: Handler };
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
