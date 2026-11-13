import { beginIdempotency, finishIdempotency, getDb, hitRateLimit, readDbConfig, releaseIdempotency } from "@bytereel/db";
import { readAuthConfig } from "@/lib/auth/config";
import { getAuth } from "@/lib/auth/server";
import { toSessionUser } from "@/lib/auth/session";
import { API_MESSAGES, apiError, handleApiRequest, newRequestId, requestIdFor, type ApiContext, type ApiEndpoint } from "./v1";

// The real dependencies for /api/v1 route handlers (server code only): the session from Better
// Auth (only `active` users count, API.md §3.1), the rate-limit counters and the Idempotency-Key
// records in MongoDB. A route file is then just: export const GET = apiRoute({ rateLimit, handle }).
// The handler also gets the database (`db`), so it doesn't have to read the settings again.

export type RouteContext<B> = ApiContext<B> & { db: ReturnType<typeof getDb> };

export function apiRoute<B = undefined>(
  endpoint: Omit<ApiEndpoint<B>, "handle"> & { handle: (context: RouteContext<B>) => Promise<unknown> },
): (request: Request) => Promise<Response> {
  return async (request) => {
    const db = readDbConfig(process.env);
    const settings = readAuthConfig(process.env);
    if (!db.ok || !settings.ok) {
      // The start-up check (instrumentation.ts) has already printed what to fix.
      return apiError(500, "INTERNAL", API_MESSAGES.INTERNAL, requestIdFor(request.headers, newRequestId));
    }
    const database = getDb(db.config);
    return handleApiRequest(
      request,
      { ...endpoint, handle: (context) => endpoint.handle({ ...context, db: database }) },
      {
        appOrigins: [settings.config.appOrigin],
        getUser: async (r) => toSessionUser(await getAuth().api.getSession({ headers: r.headers })),
        hitRateLimit: (rule, userId) => hitRateLimit(database, rule, userId),
        idempotency: {
          begin: (userId, key, fingerprint) => beginIdempotency(database, userId, key, fingerprint),
          finish: (recordId, status, body) => finishIdempotency(database, recordId, status, body),
          release: (recordId) => releaseIdempotency(database, recordId),
        },
      },
    );
  };
}
