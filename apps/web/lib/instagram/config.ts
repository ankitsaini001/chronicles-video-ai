// Instagram settings from the environment (F28; ARCHITECTURE §17.1). No imports, so it can be used
// anywhere on the server. Problems name the setting, never its value (the app secret is a secret).
//
//   INSTAGRAM_APP_ID        the "Instagram app ID" (Meta app → Instagram → API setup with Instagram login)
//   INSTAGRAM_APP_SECRET    the "Instagram app secret" next to it (a secret: .env / Vercel only)
//   INSTAGRAM_REDIRECT_URI  optional. Empty = BETTER_AUTH_URL + /api/v1/instagram/callback
//                           (http://localhost:3000/api/v1/instagram/callback on your computer).
//                           Whatever is used must be EXACTLY the "OAuth redirect URI" saved in Meta.

export const CALLBACK_PATH = "/api/v1/instagram/callback";

export type InstagramConfig = { appId: string; appSecret: string; redirectUri: string };

export type InstagramConfigResult = { ok: true; config: InstagramConfig } | { ok: false; problems: string[] };

const APP_ID = /^\d{5,30}$/;

export function readInstagramConfig(env: NodeJS.ProcessEnv = process.env): InstagramConfigResult {
  const problems: string[] = [];
  const appId = env.INSTAGRAM_APP_ID?.trim() ?? "";
  const appSecret = env.INSTAGRAM_APP_SECRET?.trim() ?? "";
  const explicit = env.INSTAGRAM_REDIRECT_URI?.trim() ?? "";

  if (appId === "") problems.push("INSTAGRAM_APP_ID is missing. Copy the Instagram app ID from the Meta app (Instagram → API setup with Instagram login) into .env.");
  else if (!APP_ID.test(appId)) problems.push("INSTAGRAM_APP_ID must be the numeric Instagram app ID (only digits).");
  if (appSecret === "") problems.push("INSTAGRAM_APP_SECRET is missing. Copy the Instagram app secret from the same Meta page into .env.");
  else if (appSecret.length < 16 || /\s/.test(appSecret)) problems.push("INSTAGRAM_APP_SECRET doesn't look right (too short or has a space). Copy it again.");

  let redirectUri = "";
  if (explicit !== "") {
    redirectUri = explicit;
  } else {
    const base = env.BETTER_AUTH_URL?.trim() ?? "";
    try {
      redirectUri = `${new URL(base).origin}${CALLBACK_PATH}`;
    } catch {
      problems.push("INSTAGRAM_REDIRECT_URI is empty and BETTER_AUTH_URL isn't set, so the Instagram return address is unknown.");
    }
  }
  if (redirectUri !== "" && !validRedirect(redirectUri)) {
    problems.push(`INSTAGRAM_REDIRECT_URI must be https://<your domain>${CALLBACK_PATH} (or http://localhost:<port>${CALLBACK_PATH} on your computer).`);
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, config: { appId, appSecret, redirectUri } };
}

function validRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.pathname !== CALLBACK_PATH || url.search || url.hash || url.username || url.password) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
}
