// Words on the Published screen (F30; Stitch "ByteReel — Published"). Plain functions (no React, no
// database), so the tests check them.

/** "12 Nov 2026, 7:02 pm" in the creator's timezone. */
export function postedAtLabel(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(at);
}

/** The post's own link; without one (Instagram didn't give it), the account's profile. Only https Instagram addresses. */
export function viewOnInstagramHref(permalink: string | null, username: string): string {
  if (permalink && /^https:\/\/(www\.)?instagram\.com\//.test(permalink)) return permalink;
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}
