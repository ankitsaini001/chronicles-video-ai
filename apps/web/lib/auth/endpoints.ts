// Better Auth lockdown (docs/API.md §3.1–3.2, ARCHITECTURE §10.1).
// Better Auth ships ~30 endpoints. Only these 6 may be reached under /api/auth; everything else is
// switched off twice: in Better Auth (`disabledPaths`) and in our route handler (404).

export const AUTH_BASE_PATH = "/api/auth";

export const ALLOWED_AUTH_ENDPOINTS = [
  { id: "A1", method: "POST", path: "/sign-up/email" },
  { id: "A2", method: "POST", path: "/sign-in/email" },
  { id: "A3", method: "POST", path: "/sign-out" },
  { id: "A4", method: "GET", path: "/get-session" },
  { id: "A5", method: "POST", path: "/change-password" },
  { id: "A6", method: "POST", path: "/reset-password" },
] as const;

export type AllowedAuthEndpoint = (typeof ALLOWED_AUTH_ENDPOINTS)[number];

/**
 * Every other Better Auth 1.7.14 endpoint, switched off with `disabledPaths` (exact paths only).
 * Two of its routes have a variable part (/callback/:id, /reset-password/:token), which
 * `disabledPaths` can't match; the route handler's allow-list blocks those. A unit test fails if a
 * Better Auth upgrade adds an endpoint that is missing here.
 */
export const DISABLED_AUTH_PATHS = [
  "/account-info",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/error",
  "/get-access-token",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/ok",
  "/refresh-token",
  "/request-password-reset",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/send-verification-email",
  "/sign-in/social",
  "/unlink-account",
  "/update-session",
  "/update-user",
  "/verify-email",
  "/verify-password",
] as const;

/**
 * The allowed endpoint for this method and URL path, or null. Exact match only: no trailing slash,
 * no other spelling, no encoded characters.
 */
export function findAllowedAuthEndpoint(method: string, pathname: string): AllowedAuthEndpoint | null {
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return null;
  const path = pathname.slice(AUTH_BASE_PATH.length);
  return ALLOWED_AUTH_ENDPOINTS.find((e) => e.method === method && e.path === path) ?? null;
}
