import { getDb, getMongoClient, isInvited, markInviteSignedUp, readDbConfig } from "@bytereel/db";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { nextCookies } from "better-auth/next-js";
import { readAuthConfig } from "./config";
import { createAuth, type Auth } from "./create-auth";

// The app's one Better Auth instance, on the real MongoDB database (server code only).
// Built on first use, not at import, so `next build` works without the secrets.

let auth: Auth | undefined;

export function getAuth(): Auth {
  if (auth) return auth;
  const db = readDbConfig(process.env);
  const settings = readAuthConfig(process.env);
  if (!db.ok || !settings.ok) {
    // The start-up check (instrumentation.ts) has already printed what to fix.
    throw new Error("Login is not set up: check MONGODB_URI, BETTER_AUTH_SECRET and BETTER_AUTH_URL in .env, then restart.");
  }
  const database = getDb(db.config);
  auth = createAuth({
    config: settings.config,
    // Our shared client (one connection pool). Passing the client turns on transactions, so a
    // sign-up saves the user, password and session all together or not at all.
    database: mongodbAdapter(database, { client: getMongoClient(db.config) }),
    invites: {
      isInvited: (email) => isInvited(database, email),
      markSignedUp: async (email, userId) => {
        await markInviteSignedUp(database, email, userId);
      },
    },
    // Lets server code (e.g. the dashboard reading the session) refresh the cookie. Must be last.
    plugins: [nextCookies()],
  });
  return auth;
}
