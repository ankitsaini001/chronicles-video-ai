import type { InstagramConfig } from "./config";

// Instagram API with Instagram Login (F28, server only; ARCHITECTURE §17.2, decision 2). Checked
// against Meta's docs on 2026-11-22 ("Business Login for Instagram" and "Get started"):
//   1. browser → https://www.instagram.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope&state
//   2. POST https://api.instagram.com/oauth/access_token (form: client_id, client_secret,
//      grant_type=authorization_code, redirect_uri, code) → short-lived token + granted permissions
//      (the docs show the answer inside `data: [ … ]`; older answers were flat: both are read). Its
//      user_id is NOT used (F28 review): it can be a 17-digit JSON number that JavaScript rounds.
//   3. GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret&access_token
//      → long-lived token, expires_in (≈ 60 days)
//   4. GET https://graph.instagram.com/v27.0/me?fields=user_id,username,account_type,profile_picture_url
//      &access_token=… (as Meta's "Get started" page shows; the token exchange in step 3 puts it in
//      the address too, and nothing logs fetch addresses). account_type is
//      "Business" or "Media_Creator" in the docs (compared in any case). The id we store is /me's
//      user_id: a string is used as is; a JSON number only if it is exact (≤ 2^53), otherwise the
//      answer is refused (bad_answer) rather than storing a rounded id.
// Every call has a time limit. Tokens, the app secret and Instagram's own error text never go
// into an error message or a log: an error says only which step failed and the HTTP status.

export const INSTAGRAM_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
export const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
export const INSTAGRAM_GRAPH_URL = "https://graph.instagram.com";
/** The Graph API version used for /me (the version shown in Meta's "Get started" page, 2026-11-22). */
export const INSTAGRAM_GRAPH_VERSION = "v27.0";
export const INSTAGRAM_SCOPE = "instagram_business_basic,instagram_business_content_publish";
export const INSTAGRAM_TIMEOUT_MS = 15_000;

export type InstagramStep = "code_exchange" | "long_lived_token" | "profile";

/** A failed call to Instagram. Its message never holds a token, the secret or Instagram's text. */
export class InstagramApiError extends Error {
  override name = "InstagramApiError";
  constructor(
    readonly step: InstagramStep,
    readonly kind: "rejected" | "unavailable" | "timeout" | "bad_answer",
    readonly status: number | null = null,
  ) {
    super(`Instagram ${step} failed: ${kind}${status !== null ? ` (HTTP ${status})` : ""}.`);
  }
}

/** `permissions`: what the creator allowed, or null when Instagram sent no list (unknown). */
export type ShortLivedToken = { accessToken: string; permissions: string[] | null };
export type LongLivedToken = { accessToken: string; expiresInSeconds: number };
export type InstagramProfile = { userId: string; username: string; accountType: string | null; profilePictureUrl: string | null };

/** What G2/G3 need from Instagram (the real client below, or the e2e stand-in). */
export interface InstagramApi {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<ShortLivedToken>;
  longLivedToken(shortLivedToken: string): Promise<LongLivedToken>;
  profile(accessToken: string): Promise<InstagramProfile>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function authorizeUrlFor(authorizeBase: string, config: Pick<InstagramConfig, "appId" | "redirectUri">, state: string): string {
  const url = new URL(authorizeBase);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Meta's answers come flat or as `{ data: [ {...} ] }`. */
function firstRecord(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (Array.isArray(data)) return data[0] && typeof data[0] === "object" ? (data[0] as Record<string, unknown>) : null;
  return json as Record<string, unknown>;
}

/** An Instagram id: digits as text, or a JSON number only when it is exact (a 17-digit number has been rounded already). */
const idText = (value: unknown): string | null =>
  typeof value === "string" && /^\d{1,40}$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

export class MetaInstagramApi implements InstagramApi {
  constructor(
    private readonly config: InstagramConfig,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs: number = INSTAGRAM_TIMEOUT_MS,
  ) {}

  authorizeUrl(state: string): string {
    return authorizeUrlFor(INSTAGRAM_AUTHORIZE_URL, this.config, state);
  }

  private async call(step: InstagramStep, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs), cache: "no-store" });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      throw new InstagramApiError(step, name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable");
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) throw new InstagramApiError(step, response.status >= 500 || response.status === 429 ? "unavailable" : "rejected", response.status);
    const record = firstRecord(json);
    if (!record) throw new InstagramApiError(step, "bad_answer", response.status);
    return record;
  }

  async exchangeCode(code: string): Promise<ShortLivedToken> {
    const form = new URLSearchParams({
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      grant_type: "authorization_code",
      redirect_uri: this.config.redirectUri,
      code,
    });
    const record = await this.call("code_exchange", INSTAGRAM_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const accessToken = nonEmpty(record.access_token);
    if (!accessToken) throw new InstagramApiError("code_exchange", "bad_answer");
    const permissions =
      typeof record.permissions === "string"
        ? record.permissions.split(",").map((p) => p.trim()).filter(Boolean)
        : Array.isArray(record.permissions)
          ? record.permissions.filter((p): p is string => typeof p === "string")
          : null;
    return { accessToken, permissions: permissions && permissions.length > 0 ? permissions : null };
  }

  async longLivedToken(shortLivedToken: string): Promise<LongLivedToken> {
    const url = new URL(`${INSTAGRAM_GRAPH_URL}/access_token`);
    url.searchParams.set("grant_type", "ig_exchange_token");
    url.searchParams.set("client_secret", this.config.appSecret);
    url.searchParams.set("access_token", shortLivedToken);
    const record = await this.call("long_lived_token", url.toString());
    const accessToken = nonEmpty(record.access_token);
    const expiresIn = typeof record.expires_in === "number" ? record.expires_in : Number(record.expires_in);
    if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new InstagramApiError("long_lived_token", "bad_answer");
    return { accessToken, expiresInSeconds: Math.floor(expiresIn) };
  }

  async profile(accessToken: string): Promise<InstagramProfile> {
    const url = new URL(`${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_GRAPH_VERSION}/me`);
    url.searchParams.set("fields", "user_id,username,account_type,profile_picture_url");
    url.searchParams.set("access_token", accessToken);
    const record = await this.call("profile", url.toString());
    const userId = idText(record.user_id);
    const username = nonEmpty(record.username);
    if (!userId || !username) throw new InstagramApiError("profile", "bad_answer");
    const picture = nonEmpty(record.profile_picture_url);
    return { userId, username, accountType: nonEmpty(record.account_type), profilePictureUrl: picture && picture.startsWith("https://") ? picture : null };
  }
}
