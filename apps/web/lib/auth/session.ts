import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "./server";

// "Who is signed in?" for pages (server code only; Next.js "Data Access Layer" pattern, see
// node_modules/next/dist/docs/01-app/02-guides/authentication.md).
// The session is read from the `session` collection on EVERY request (Better Auth's cookie cache is
// off), so after logging out, or after an admin removes a session, the name disappears at once.
// Checking only that a cookie exists is never enough: a page that needs login calls requireUser().

/** What pages may show about the signed-in user. Nothing else leaves the server. */
export type SessionUser = { id: string; name: string; email: string };

export const LOGIN_PATH = "/login";
export const AFTER_LOGIN_PATH = "/dashboard";

/**
 * The signed-in user, or null when signed out. Throws if the database can't be reached.
 * `cache` makes the header and the page share one database read per request.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const requestHeaders = await headers();
  return toSessionUser(await getAuth().api.getSession({ headers: requestHeaders }));
});

/**
 * The page-safe user from a Better Auth session, or null. Every server-side session read requires
 * `status: "active"` (API.md §3.1): a session that still exists for a suspended or deleting user
 * (e.g. one created before the status changed) counts as signed out.
 */
export function toSessionUser(session: { user: { id: string; name: string; email: string; status?: unknown } } | null | undefined): SessionUser | null {
  if (!session || session.user.status !== "active") return null;
  return { id: session.user.id, name: session.user.name, email: session.user.email };
}

/**
 * For public pages (home header, /login, /signup): if the database can't be reached, show the
 * signed-out view instead of an error page.
 */
export async function getSessionUserOrNull(): Promise<SessionUser | null> {
  // Read outside the try: Next.js uses an exception here to mark the page as per-request.
  await headers();
  try {
    return await getSessionUser();
  } catch (error) {
    console.error("Could not read the session:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** For pages that need login: the signed-in user, or a redirect to /login. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(LOGIN_PATH);
  return user;
}

/** For /login and /signup: already signed in → straight to My videos. */
export async function redirectIfSignedIn(): Promise<void> {
  if (await getSessionUserOrNull()) redirect(AFTER_LOGIN_PATH);
}
