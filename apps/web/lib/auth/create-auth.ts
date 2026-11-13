import { normalizeEmail } from "@bytereel/db";
import { APIError, betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import type { AuthConfig } from "./config";
import { DISABLED_AUTH_PATHS } from "./endpoints";
import { AUTH_MESSAGES, SIGN_UP_LIMITS } from "./messages";

// Better Auth set-up (docs/ARCHITECTURE.md §10, API.md §3). Kept free of Next.js and of the real
// database so the tests can build it with an in-memory database (lib/auth/server.ts builds the
// real one).

/** Values every new user starts with. Users can never set them through sign-up (API.md §3.1). */
export const SERVER_OWNED_DEFAULTS = {
  role: "creator",
  status: "active",
  timezone: "Asia/Kolkata",
  defaultLanguage: "en",
  defaultVoiceGender: "female",
  failedLoginCount: 0,
  lockedUntil: null,
  lastLoginAt: null,
} as const;

/**
 * Our extra `user` fields (DATABASE.md §4.1). All `input: false`: Better Auth ignores them in any
 * request body and uses the default. The login-protection fields stay out of API answers.
 */
const USER_FIELDS = {
  role: { type: "string", required: true, defaultValue: SERVER_OWNED_DEFAULTS.role, input: false },
  status: { type: "string", required: true, defaultValue: SERVER_OWNED_DEFAULTS.status, input: false },
  timezone: { type: "string", required: true, defaultValue: SERVER_OWNED_DEFAULTS.timezone, input: false },
  defaultLanguage: { type: "string", required: true, defaultValue: SERVER_OWNED_DEFAULTS.defaultLanguage, input: false },
  defaultVoiceGender: { type: "string", required: true, defaultValue: SERVER_OWNED_DEFAULTS.defaultVoiceGender, input: false },
  failedLoginCount: { type: "number", required: true, defaultValue: SERVER_OWNED_DEFAULTS.failedLoginCount, input: false, returned: false },
  lockedUntil: { type: "date", required: false, defaultValue: SERVER_OWNED_DEFAULTS.lockedUntil, input: false, returned: false },
  lastLoginAt: { type: "date", required: false, defaultValue: SERVER_OWNED_DEFAULTS.lastLoginAt, input: false, returned: false },
} as const satisfies NonNullable<NonNullable<BetterAuthOptions["user"]>["additionalFields"]>;

/** The invite list, as the sign-up hooks need it. */
export interface InviteList {
  isInvited(email: string): Promise<boolean>;
  /** Link the invite to the new account (allowlist.signedUpUserId). */
  markSignedUp(email: string, userId: string): Promise<void>;
}

export interface CreateAuthOptions {
  config: AuthConfig;
  database: BetterAuthOptions["database"];
  invites: InviteList;
  plugins?: BetterAuthPlugin[];
  /** Where to report a failed invite link (default: console.error). Never given the email. */
  logError?: (message: string, error: unknown) => void;
}

const DAY = 24 * 60 * 60;

export function createAuth({ config, database, invites, plugins = [], logError = defaultLogError }: CreateAuthOptions) {
  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: "/api/auth",
    trustedOrigins: [config.appOrigin],
    database,
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      // No emails in V1: the invite list replaces verification (API.md §3.1).
      requireEmailVerification: false,
      minPasswordLength: SIGN_UP_LIMITS.passwordMin,
      maxPasswordLength: SIGN_UP_LIMITS.passwordMax,
      // Sign-up signs you in straight away.
      autoSignIn: true,
    },
    session: {
      expiresIn: 30 * DAY,
      // Rolling: pushed to now + 30 days at most once a day while the app is used.
      updateAge: DAY,
      // Off, so a deleted session stops working at once (API.md §3.1).
      cookieCache: { enabled: false },
    },
    user: { additionalFields: USER_FIELDS },
    // Better Auth's limiter counts in server memory, useless on Vercel. Ours uses the
    // rateLimits collection (DATABASE.md Q13), in the route handler.
    rateLimit: { enabled: false },
    disabledPaths: [...DISABLED_AUTH_PATHS],
    databaseHooks: {
      user: {
        create: {
          // Only invited emails can sign up (ARCHITECTURE §10.2).
          before: async (user) => {
            const normalized = normalizeEmail(typeof user.email === "string" ? user.email : "");
            if (!normalized.ok) throw APIError.from("BAD_REQUEST", { code: "INVALID_EMAIL", message: AUTH_MESSAGES.INVALID_EMAIL });
            if (!(await invites.isInvited(normalized.email))) {
              throw APIError.from("FORBIDDEN", { code: "NOT_ALLOWLISTED", message: AUTH_MESSAGES.NOT_ALLOWLISTED });
            }
            // Store exactly the normalized email, and the server-owned values whatever was sent.
            return { data: { ...user, email: normalized.email, ...SERVER_OWNED_DEFAULTS } };
          },
          // Runs after the sign-up is saved. A failure here must not undo a working account,
          // so it is only reported (the invite list then shows "not signed up yet").
          after: async (user) => {
            try {
              await invites.markSignedUp(user.email, user.id);
            } catch (error) {
              logError(`Sign-up: could not link the invite to the new account ${user.id}.`, error);
            }
          },
        },
      },
      session: {
        create: {
          // Only `active` users get a session (API.md §3.1). Runs for every new session (log in,
          // sign-up, change password), after the password was checked, so a wrong password still
          // gets the generic "incorrect" answer and this answer never reveals that an email exists.
          // `suspended` and `deleting` (account deletion in progress) are both refused.
          before: async (session, ctx) => {
            const user = ctx ? await ctx.context.internalAdapter.findUserById(session.userId) : null;
            if ((user as { status?: unknown } | null)?.status !== "active") {
              throw APIError.from("FORBIDDEN", { code: "ACCOUNT_SUSPENDED", message: AUTH_MESSAGES.ACCOUNT_SUSPENDED });
            }
          },
        },
      },
    },
    plugins,
  });
}

export type Auth = ReturnType<typeof createAuth>;

function defaultLogError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : error);
}
