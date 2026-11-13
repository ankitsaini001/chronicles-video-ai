import { API_RATE_LIMITS } from "@bytereel/db";
import { getMe } from "@/lib/account/me";
import { apiRoute } from "@/lib/api/server";

// B1 GET /api/v1/me (docs/API.md §14.2): the signed-in user's profile, defaults, usage and alerts.
// Signed out (or not `active`) → 401 UNAUTHENTICATED; 300 requests per minute per user.

export const GET = apiRoute({
  rateLimit: API_RATE_LIMITS.readsPerUser,
  handle: ({ user }) => getMe(user),
});
