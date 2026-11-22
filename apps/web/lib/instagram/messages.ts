import { SITE } from "../site";

// The plain messages for the way back from Instagram (F28 decision 3; API.md §4.3). The callback
// sends `?instagram_error=<CODE>[&reason=<reason>]` or `?instagram=connected`; the page turns them
// into one of these lines. Never an error page, never Instagram's own text. No imports from the
// server, so pages and client components can use it.

export type InstagramNotice = { tone: "success" | "problem"; text: string };

export const INSTAGRAM_MESSAGES = {
  connected: "Instagram connected.",
  ineligible: "This Instagram account is personal. Switch it to a Creator or Business account in Instagram settings, then connect again. Download still works.",
  inUse: `This Instagram account is already connected to another ${SITE.name} account.`,
  denied: "You cancelled on Instagram, so nothing was connected. You can connect any time.",
  invalidState: "That Instagram login took too long or was started somewhere else. Please connect again.",
  exchangeFailed: "Instagram didn't finish connecting. Please try again in a few minutes.",
  notSetUp: "Connecting Instagram isn't set up yet. You can still download your video.",
  rateLimited: "You're going a bit fast. Please wait a minute, then connect again.",
  missingPermission: "Please allow posting when Instagram asks, then connect again.",
  disconnected: "Instagram disconnected. We no longer have access to your account.",
  needsReconnect: "Instagram needs reconnecting. Please connect again.",
} as const;

type Query = { [key: string]: string | string[] | undefined };
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The notice for the query the callback added, or null. */
export function instagramNotice(query: Query): InstagramNotice | null {
  const code = one(query.instagram_error);
  const reason = one(query.reason);
  if (code === undefined) return one(query.instagram) === "connected" ? { tone: "success", text: INSTAGRAM_MESSAGES.connected } : null;
  switch (code) {
    case "INSTAGRAM_ACCOUNT_INELIGIBLE":
      return { tone: "problem", text: INSTAGRAM_MESSAGES.ineligible };
    case "INSTAGRAM_ACCOUNT_IN_USE":
      return { tone: "problem", text: INSTAGRAM_MESSAGES.inUse };
    case "RATE_LIMITED":
      return { tone: "problem", text: INSTAGRAM_MESSAGES.rateLimited };
    case "INSTAGRAM_OAUTH_FAILED":
      if (reason === "access_denied") return { tone: "problem", text: INSTAGRAM_MESSAGES.denied };
      if (reason === "invalid_state") return { tone: "problem", text: INSTAGRAM_MESSAGES.invalidState };
      if (reason === "not_set_up") return { tone: "problem", text: INSTAGRAM_MESSAGES.notSetUp };
      if (reason === "missing_permission") return { tone: "problem", text: INSTAGRAM_MESSAGES.missingPermission };
      return { tone: "problem", text: INSTAGRAM_MESSAGES.exchangeFailed };
    default:
      return { tone: "problem", text: INSTAGRAM_MESSAGES.exchangeFailed };
  }
}
