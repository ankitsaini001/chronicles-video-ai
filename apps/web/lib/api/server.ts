import { getDb, hitRateLimit, readDbConfig } from "@bytereel/db";
import { readAuthConfig } from "@/lib/auth/config";
import { getAuth } from "@/lib/auth/server";
import { toSessionUser } from "@/lib/auth/session";
import { API_MESSAGES, apiError, handleApiRequest, newRequestId, requestIdFor, type ApiEndpoint } from "./v1";

// The real dependencies for /api/v1 route handlers (server code only): the session from Better
// Auth (only `active` users count, API.md §3.1) and the rate-limit counters in MongoDB.
// A route file is then just: export const GET = apiRoute({ rateLimit, handle }).

export function apiRoute(endpoint: ApiEndpoint): (request: Request) => Promise<Response> {
  return async (request) => {
    const db = readDbConfig(process.env);
    const settings = readAuthConfig(process.env);
    if (!db.ok || !settings.ok) {
      // The start-up check (instrumentation.ts) has already printed what to fix.
      return apiError(500, "INTERNAL", API_MESSAGES.INTERNAL, requestIdFor(request.headers, newRequestId));
    }
    const database = getDb(db.config);
    return handleApiRequest(request, endpoint, {
      appOrigins: [settings.config.appOrigin],
      getUser: async (r) => toSessionUser(await getAuth().api.getSession({ headers: r.headers })),
      hitRateLimit: (rule, userId) => hitRateLimit(database, rule, userId),
    });
  };
}
