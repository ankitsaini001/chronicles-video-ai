import { AUTH_RATE_LIMITS, getDb, hitRateLimit, readDbConfig } from "@bytereel/db";
import { readAuthConfig } from "@/lib/auth/config";
import { authError, handleAuthRequest } from "@/lib/auth/handler";
import { getAuth } from "@/lib/auth/server";
import { AUTH_MESSAGES } from "@/lib/auth/messages";

// Better Auth's endpoints (docs/API.md §3). lib/auth/handler.ts lets through only the 6
// documented ones and runs our checks first.

async function handle(request: Request): Promise<Response> {
  const db = readDbConfig(process.env);
  const settings = readAuthConfig(process.env);
  if (!db.ok || !settings.ok) return authError(500, "INTERNAL", AUTH_MESSAGES.INTERNAL);
  return handleAuthRequest(request, {
    appOrigins: [settings.config.appOrigin],
    forward: (r) => getAuth().handler(r),
    hitSignUpLimit: (ip) => hitRateLimit(getDb(db.config), AUTH_RATE_LIMITS.signUpPerIp, ip),
    // Vercel sets VERCEL=1 and writes X-Forwarded-For itself.
    trustForwardedFor: process.env.VERCEL === "1",
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
