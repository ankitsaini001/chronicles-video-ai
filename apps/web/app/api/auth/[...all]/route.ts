import { AUTH_RATE_LIMITS, getDb, getLoginLock, hitRateLimit, readDbConfig, recordFailedLogin, recordSuccessfulLogin } from "@bytereel/db";
import { readAuthConfig } from "@/lib/auth/config";
import { authError, handleAuthRequest } from "@/lib/auth/handler";
import { getAuth } from "@/lib/auth/server";
import { AUTH_MESSAGES } from "@/lib/auth/messages";

// Better Auth's endpoints (docs/API.md §3). lib/auth/handler.ts lets through only the 6
// documented ones and runs our checks first (Origin, strict bodies, rate limits, account lock).

async function handle(request: Request): Promise<Response> {
  const db = readDbConfig(process.env);
  const settings = readAuthConfig(process.env);
  if (!db.ok || !settings.ok) return authError(500, "INTERNAL", AUTH_MESSAGES.INTERNAL);
  const database = getDb(db.config);
  return handleAuthRequest(request, {
    appOrigins: [settings.config.appOrigin],
    forward: (r) => getAuth().handler(r),
    hitSignUpLimit: (ip) => hitRateLimit(database, AUTH_RATE_LIMITS.signUpPerIp, ip),
    hitSignInIpLimit: (ip) => hitRateLimit(database, AUTH_RATE_LIMITS.signInPerIp, ip),
    hitSignInEmailLimit: (email) => hitRateLimit(database, AUTH_RATE_LIMITS.signInPerEmail, email),
    hitGetSessionLimit: (ip) => hitRateLimit(database, AUTH_RATE_LIMITS.getSessionPerIp, ip),
    loginGuard: {
      getLock: (email) => getLoginLock(database, email),
      recordFailure: (email) => recordFailedLogin(database, email),
      recordSuccess: (email) => recordSuccessfulLogin(database, email),
    },
    // Vercel sets VERCEL=1 and writes X-Forwarded-For itself.
    trustForwardedFor: process.env.VERCEL === "1",
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
