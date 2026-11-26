import {
  API_RATE_LIMITS,
  eligibleAccountType,
  encryptToken,
  InstagramAccountInUseError,
  InstagramBusyError,
  tokenAad,
  type InstagramConnectionDocument,
  type InstagramConnectionToSave,
  type RateLimitResult,
  type RateLimitRule,
  type TokenKeysResult,
} from "@bytereel/db";
import { API_MESSAGES, apiError, newRequestId, requestIdFor } from "../api/v1";
import type { SessionUser } from "../auth/session";
import { InstagramApiError, type InstagramProfile, type LongLivedToken } from "./meta-client";
import type { InstagramApiResult } from "./provider";
import { parseReturnTo, signState, verifyState, type ReturnTo } from "./state";

// G2 "Connect Instagram" and G3 the OAuth callback (F28; API.md §14.7, ARCHITECTURE §17.2). Both are
// top-level browser navigations, so they answer with redirects, never an error page: every problem
// goes back to the page the creator came from as `?instagram_error=<CODE>[&reason=<reason>]` and
// that page shows the plain message (lib/instagram/messages.ts). Only a request that can't be tied
// to any flow gets JSON (400). Kept free of Next.js and the real database: lib/instagram/server.ts
// builds the real dependencies, tests pass fakes.
//
// Where "back" is: `publish:<projectId>` → /projects/<id>/publish (the user's own project only);
// `settings` (the default) → /dashboard until the Settings page exists (F33), then /settings.
// F28 review: G3 has its own counter (20/hour) after the state check and before any call to
// Instagram; a token without the publishing permission is not saved (`reason=missing_permission`);
// the token is encrypted bound to `${ownerId}:${igUserId}`.

// F30 review: INSTAGRAM_BUSY = another account while a post is being published (nothing saved).
export type InstagramErrorCode = "INSTAGRAM_ACCOUNT_INELIGIBLE" | "INSTAGRAM_ACCOUNT_IN_USE" | "INSTAGRAM_BUSY" | "INSTAGRAM_OAUTH_FAILED" | "RATE_LIMITED";
export type OAuthFailReason = "access_denied" | "invalid_state" | "exchange_failed" | "not_set_up" | "missing_permission";

/** Where `settings` goes until F33 builds the Settings page. */
export const SETTINGS_RETURN_PATH = "/dashboard";
export const LOGIN_PATH = "/login";
/** The permission publishing needs (the creator can un-tick it on Instagram's page). */
export const PUBLISH_PERMISSION = "instagram_business_content_publish";

export interface InstagramFlowDeps {
  /** The signed-in, active user and the id of their login session, or null. */
  getSession(request: Request): Promise<{ sessionId: string; user: SessionUser } | null>;
  hitRateLimit(rule: RateLimitRule, userId: string): Promise<RateLimitResult>;
  /** Is this project the user's own (any state)? */
  ownsProject(userId: string, projectId: string): Promise<boolean>;
  /** The Instagram to talk to, or what is missing (named settings only). */
  instagram(): InstagramApiResult;
  tokenKeys(): TokenKeysResult;
  /** HMAC key for the state (derived from BETTER_AUTH_SECRET), or null when login isn't set up. */
  stateKey(): Buffer | null;
  /** Save in one transaction; throws InstagramAccountInUseError. */
  save(userId: string, input: InstagramConnectionToSave): Promise<InstagramConnectionDocument>;
  now?(): Date;
  /** Server log. Only plain text built here (never a token, a secret or Instagram's own text). */
  log?(message: string): void;
}

function redirect(location: string, requestId: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store", "X-Request-Id": requestId, "Referrer-Policy": "no-referrer" },
  });
}

export function returnPath(returnTo: ReturnTo | null): string {
  return returnTo?.kind === "publish" ? `/projects/${returnTo.projectId}/publish` : SETTINGS_RETURN_PATH;
}

function withQuery(path: string, params: Record<string, string>): string {
  return `${path}?${new URLSearchParams(params).toString()}`;
}

function errorQuery(code: InstagramErrorCode, reason?: OAuthFailReason): Record<string, string> {
  return reason ? { instagram_error: code, reason } : { instagram_error: code };
}

/** A publish returnTo of another user's (or a missing) project goes to the dashboard instead. */
async function safeReturn(deps: InstagramFlowDeps, userId: string, returnTo: ReturnTo | null): Promise<ReturnTo | null> {
  if (returnTo?.kind === "publish" && !(await deps.ownsProject(userId, returnTo.projectId))) return null;
  return returnTo;
}

/**
 * The routes' answer when their dependencies can't even be built (e.g. the database settings are
 * missing): back to My videos with `reason=not_set_up`, never a raw 500 page.
 */
export function setupFailed(request: Request, error: unknown, log: (message: string) => void = (m) => console.error(m)): Response {
  const requestId = requestIdFor(request.headers, newRequestId);
  log(`Instagram connect is not set up (request ${requestId}): ${errorLabel(error)}`);
  return redirect(withQuery(SETTINGS_RETURN_PATH, errorQuery("INSTAGRAM_OAUTH_FAILED", "not_set_up")), requestId);
}

/** G2 GET /api/v1/instagram/connect?returnTo=settings|publish:<projectId> */
export async function startConnect(request: Request, deps: InstagramFlowDeps): Promise<Response> {
  const requestId = requestIdFor(request.headers, newRequestId);
  const log = deps.log ?? ((m: string) => console.error(m));
  try {
    const session = await deps.getSession(request);
    if (!session) return redirect(LOGIN_PATH, requestId);
    const userId = session.user.id;
    const raw = new URL(request.url).searchParams.get("returnTo");
    const returnTo = parseReturnTo(raw);
    if (!returnTo) {
      return apiError(400, "INVALID_INPUT", API_MESSAGES.INVALID_INPUT, requestId, { details: { issues: [{ path: "returnTo", message: "must be settings or publish:<projectId>" }] } });
    }
    if (returnTo.kind === "publish" && !(await deps.ownsProject(userId, returnTo.projectId))) {
      return apiError(404, "NOT_FOUND", "We couldn't find that project.", requestId);
    }
    const back = returnPath(returnTo);
    const limit = await deps.hitRateLimit(API_RATE_LIMITS.instagramConnectPerUser, userId);
    if (!limit.allowed) return redirect(withQuery(back, errorQuery("RATE_LIMITED")), requestId);

    const instagram = deps.instagram();
    const keys = deps.tokenKeys();
    const key = deps.stateKey();
    if (!instagram.ok || !keys.ok || !key) {
      const problems = [...(instagram.ok ? [] : instagram.problems), ...(keys.ok ? [] : keys.problems), ...(key ? [] : ["BETTER_AUTH_SECRET is not set up."])];
      log(`Instagram connect is not set up (request ${requestId}): ${problems.join(" ")}`);
      return redirect(withQuery(back, errorQuery("INSTAGRAM_OAUTH_FAILED", "not_set_up")), requestId);
    }
    const state = signState(key, session.sessionId, returnTo, deps.now?.() ?? new Date());
    return redirect(instagram.api.authorizeUrl(state), requestId);
  } catch (error) {
    log(`Instagram connect failed (request ${requestId}): ${errorLabel(error)}`);
    return apiError(500, "INTERNAL", API_MESSAGES.INTERNAL, requestId);
  }
}

/** G3 GET /api/v1/instagram/callback?code&state | ?error&error_reason&error_description&state */
export async function finishConnect(request: Request, deps: InstagramFlowDeps): Promise<Response> {
  const requestId = requestIdFor(request.headers, newRequestId);
  const log = deps.log ?? ((m: string) => console.error(m));
  let back = SETTINGS_RETURN_PATH;
  try {
    const session = await deps.getSession(request);
    if (!session) return redirect(LOGIN_PATH, requestId);
    const userId = session.user.id;
    const params = new URL(request.url).searchParams;
    const state = params.get("state");
    // Instagram may add "#_" after the code; it isn't part of it.
    const code = params.get("code")?.replace(/#_$/, "") ?? null;
    const oauthError = params.get("error");
    if (!state || (!code && !oauthError)) {
      return apiError(400, "INVALID_INPUT", API_MESSAGES.INVALID_REQUEST, requestId, { details: { issues: [{ path: state ? "code" : "state", message: "is required" }] } });
    }

    const key = deps.stateKey();
    if (!key) {
      log(`Instagram callback: BETTER_AUTH_SECRET is not set up (request ${requestId}).`);
      return redirect(withQuery(back, errorQuery("INSTAGRAM_OAUTH_FAILED", "not_set_up")), requestId);
    }
    const now = deps.now?.() ?? new Date();
    const check = verifyState(key, state, session.sessionId, now);
    if (!check.ok) {
      // A forged state's returnTo can't be trusted; an expired one or another session's is ours.
      if (check.reason !== "tampered") back = returnPath(await safeReturn(deps, userId, check.returnTo));
      return redirect(withQuery(back, errorQuery("INSTAGRAM_OAUTH_FAILED", "invalid_state")), requestId);
    }
    back = returnPath(await safeReturn(deps, userId, check.returnTo));
    // Counted only for a valid state of this session, before any call to Instagram.
    const limit = await deps.hitRateLimit(API_RATE_LIMITS.instagramCallbackPerUser, userId);
    if (!limit.allowed) return redirect(withQuery(back, errorQuery("RATE_LIMITED")), requestId);
    if (oauthError) {
      return redirect(withQuery(back, errorQuery("INSTAGRAM_OAUTH_FAILED", oauthError === "access_denied" ? "access_denied" : "exchange_failed")), requestId);
    }

    const instagram = deps.instagram();
    const keys = deps.tokenKeys();
    if (!instagram.ok || !keys.ok) {
      log(`Instagram callback is not set up (request ${requestId}): ${[...(instagram.ok ? [] : instagram.problems), ...(keys.ok ? [] : keys.problems)].join(" ")}`);
      return redirect(withQuery(back, errorQuery("INSTAGRAM_OAUTH_FAILED", "not_set_up")), requestId);
    }

    // The calls to Instagram happen first, outside any transaction (DATABASE.md §7.2 row 13).
    let profile: InstagramProfile;
    let longLived: LongLivedToken;
    let granted: string[] | null;
    try {
      const short = await instagram.api.exchangeCode(code!);
      granted = short.permissions;
      // The creator un-ticked posting on Instagram's page: this token can't publish, so it isn't kept.
      if (granted !== null && !granted.includes(PUBLISH_PERMISSION)) {
        return redirect(withQuery(back, errorQuery("INSTAGRAM_OAUTH_FAILED", "missing_permission")), requestId);
      }
      longLived = await instagram.api.longLivedToken(short.accessToken);
      profile = await instagram.api.profile(longLived.accessToken);
    } catch (error) {
      if (!(error instanceof InstagramApiError)) throw error;
      log(`Instagram callback (request ${requestId}): ${error.message}`);
      return redirect(withQuery(back, errorQuery("INSTAGRAM_OAUTH_FAILED", "exchange_failed")), requestId);
    }

    const accountType = eligibleAccountType(profile.accountType);
    // A personal account: nothing is stored and the new token is dropped.
    if (!accountType) return redirect(withQuery(back, errorQuery("INSTAGRAM_ACCOUNT_INELIGIBLE")), requestId);

    try {
      await deps.save(userId, {
        igUserId: profile.userId,
        username: profile.username,
        accountType,
        profilePictureUrl: profile.profilePictureUrl,
        accessToken: encryptToken(longLived.accessToken, keys.keys, tokenAad(userId, profile.userId)),
        tokenExpiresAt: new Date(now.getTime() + longLived.expiresInSeconds * 1000),
        // [] = Instagram sent no list (unknown); never claimed.
        scopes: granted ?? [],
      });
    } catch (error) {
      if (error instanceof InstagramBusyError) return redirect(withQuery(back, errorQuery("INSTAGRAM_BUSY")), requestId);
      if (!(error instanceof InstagramAccountInUseError)) throw error;
      return redirect(withQuery(back, errorQuery("INSTAGRAM_ACCOUNT_IN_USE")), requestId);
    }
    return redirect(withQuery(back, { instagram: "connected" }), requestId);
  } catch (error) {
    log(`Instagram callback failed (request ${requestId}): ${errorLabel(error)}`);
    return redirect(withQuery(back, errorQuery("INSTAGRAM_OAUTH_FAILED", "exchange_failed")), requestId);
  }
}

/** An unexpected error for the log: its name and code only (a driver message could quote data). */
function errorLabel(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" || typeof code === "string" ? `${name} (code ${code})` : name;
}
