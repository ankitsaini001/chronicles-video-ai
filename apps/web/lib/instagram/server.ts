import { getDb, getOwnedProject, hitRateLimit, readDbConfig, readTokenKeys, saveInstagramConnection } from "@bytereel/db";
import { readAuthConfig } from "../auth/config";
import { getAuth } from "../auth/server";
import { toSessionUser } from "../auth/session";
import type { InstagramFlowDeps } from "./connect";
import { instagramApiFromEnv } from "./provider";
import { stateKey } from "./state";

// The real dependencies for G2/G3 (server only): the Better Auth session (with its id, which the
// OAuth state is bound to), the database, the rate-limit counters, the Instagram settings and the
// token keys from the environment.

export function instagramFlowDeps(): InstagramFlowDeps {
  const settings = readDbConfig(process.env);
  if (!settings.ok) throw new Error("The database is not set up (MONGODB_URI).");
  const db = getDb(settings.config);
  return {
    getSession: async (request) => {
      const session = await getAuth().api.getSession({ headers: request.headers });
      const user = toSessionUser(session);
      return session && user ? { sessionId: session.session.id, user } : null;
    },
    hitRateLimit: (rule, userId) => hitRateLimit(db, rule, userId),
    ownsProject: async (userId, projectId) => (await getOwnedProject(db, userId, projectId)) !== null,
    instagram: () => instagramApiFromEnv(process.env),
    tokenKeys: () => readTokenKeys(process.env),
    stateKey: () => {
      const auth = readAuthConfig(process.env);
      return auth.ok ? stateKey(auth.config.secret) : null;
    },
    save: (userId, input) => saveInstagramConnection(db, userId, input),
  };
}
