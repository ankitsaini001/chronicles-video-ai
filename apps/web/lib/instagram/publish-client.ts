import { INSTAGRAM_GRAPH_URL, INSTAGRAM_GRAPH_VERSION } from "./meta-client";

// Publishing a Reel with the Instagram API with Instagram Login (F30, server only; ARCHITECTURE §17.3,
// §17.4). Checked against Meta's docs on 2026-11-24 (read only: "Content publishing", the IG User
// media / media_publish references, IG Container, IG Media, error codes, Graph API changelog):
//   1. POST graph.instagram.com/v27.0/{ig-user-id}/media  media_type=REELS, video_url, caption,
//      share_to_feed=true → { id } (the container). Meta fetches the video itself from video_url (it
//      must be reachable on the internet: our private R2 link, valid 1 hour).
//   2. GET  /{container-id}?fields=status_code,status → IN_PROGRESS | FINISHED | ERROR | EXPIRED |
//      PUBLISHED (a container expires after 24 hours; `status` holds an error subcode on ERROR).
//   3. POST /{ig-user-id}/media_publish  creation_id={container-id} → { id } (the media). A container
//      can be published only once (afterwards its status_code is PUBLISHED).
//   4. GET  /{media-id}?fields=permalink → the post's public link.
//   5. Reconcile: GET /{ig-user-id}/media?fields=id,caption,timestamp,permalink (recent media).
// The token goes in the address as `access_token=`, exactly like F28's /me call (Meta's reference
// lists it as a query parameter). Every call has a time limit. Tokens, the video link and Meta's own
// error text NEVER go into an error message or a log: an error carries only the step, the HTTP status
// and Meta's numeric error code/subcode.

export const PUBLISH_TIMEOUT_MS = 30_000;
export const STATUS_TIMEOUT_MS = 15_000;

export type PublishStep = "create_container" | "container_status" | "media_publish" | "permalink" | "recent_media";

/** A failed call. `kind`: no answer in time, no answer at all / 5xx / 429, a clear refusal (4xx), or an unreadable answer. */
export class InstagramPublishError extends Error {
  override name = "InstagramPublishError";
  constructor(
    readonly step: PublishStep,
    readonly kind: "timeout" | "unavailable" | "rejected" | "bad_answer",
    readonly status: number | null = null,
    readonly code: number | null = null,
    readonly subcode: number | null = null,
  ) {
    super(`Instagram ${step} failed: ${kind}${status !== null ? ` (HTTP ${status})` : ""}${code !== null ? ` code ${code}` : ""}${subcode !== null ? `/${subcode}` : ""}.`);
  }
}

/** What a failed call means for the post (Meta's error codes page, read 2026-11-24). */
export type PublishErrorMeaning = "transient" | "limit" | "token" | "not_ready" | "unreachable" | "rejected";

export function meaningOf(error: InstagramPublishError): PublishErrorMeaning {
  if (error.kind === "timeout" || error.kind === "unavailable" || error.kind === "bad_answer") return "transient";
  const { code, subcode } = error;
  // Code 9 / subcode 2207042: "the maximum number of posts … published by Content Publishing API" (24 h).
  if (subcode === 2207042 || code === 9) return "limit";
  // 190: invalid or expired access token (the creator must reconnect).
  if (code === 190) return "token";
  // 9007 / 2207027: "The media is not ready for publishing" → keep checking the container.
  if (code === 9007 || subcode === 2207027) return "not_ready";
  // 2207052 / 9004: Meta couldn't fetch the video from our link.
  if (subcode === 2207052 || code === 9004) return "unreachable";
  // 2207001 server error, 2207003 download took too long, code 1/2 and 4 (rate) are temporary.
  if (subcode === 2207001 || subcode === 2207003 || code === 1 || code === 2 || code === 4 || code === -1 || code === -2) return "transient";
  return "rejected";
}

export type RecentMedia = { id: string; caption: string | null; timestamp: string | null; permalink: string | null };
export type ContainerStatus = { statusCode: string; status: string | null };

/** What the publish job needs from Instagram (the real client below, or the e2e stand-in). */
export interface InstagramPublisher {
  createReelsContainer(input: { igUserId: string; accessToken: string; videoUrl: string; caption: string }): Promise<{ containerId: string }>;
  containerStatus(input: { containerId: string; accessToken: string }): Promise<ContainerStatus>;
  publishContainer(input: { igUserId: string; accessToken: string; containerId: string }): Promise<{ mediaId: string }>;
  permalink(input: { mediaId: string; accessToken: string }): Promise<string | null>;
  recentMedia(input: { igUserId: string; accessToken: string }): Promise<RecentMedia[]>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const idText = (value: unknown): string | null => (typeof value === "string" && /^\d{1,40}$/.test(value) ? value : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const httpsLink = (value: unknown): string | null => (typeof value === "string" && value.startsWith("https://") ? value : null);

export class MetaInstagramPublisher implements InstagramPublisher {
  constructor(private readonly fetchImpl: Fetch = (input, init) => fetch(input, init)) {}

  private url(path: string, accessToken: string, query: Record<string, string> = {}): string {
    const url = new URL(`${INSTAGRAM_GRAPH_URL}/${INSTAGRAM_GRAPH_VERSION}/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set("access_token", accessToken);
    return url.toString();
  }

  private async call(step: PublishStep, url: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      throw new InstagramPublishError(step, name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable");
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = (json as { error?: { code?: unknown; error_subcode?: unknown } } | null)?.error;
      const code = typeof error?.code === "number" ? error.code : null;
      const subcode = typeof error?.error_subcode === "number" ? error.error_subcode : null;
      throw new InstagramPublishError(step, response.status >= 500 || response.status === 429 ? "unavailable" : "rejected", response.status, code, subcode);
    }
    if (!json || typeof json !== "object") throw new InstagramPublishError(step, "bad_answer", response.status);
    return json as Record<string, unknown>;
  }

  private form(fields: Record<string, string>): RequestInit {
    return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
  }

  async createReelsContainer(input: { igUserId: string; accessToken: string; videoUrl: string; caption: string }): Promise<{ containerId: string }> {
    const record = await this.call(
      "create_container",
      this.url(`${input.igUserId}/media`, input.accessToken),
      this.form({ media_type: "REELS", video_url: input.videoUrl, caption: input.caption, share_to_feed: "true" }),
      PUBLISH_TIMEOUT_MS,
    );
    const containerId = idText(record.id);
    if (!containerId) throw new InstagramPublishError("create_container", "bad_answer");
    return { containerId };
  }

  async containerStatus(input: { containerId: string; accessToken: string }): Promise<ContainerStatus> {
    const record = await this.call("container_status", this.url(input.containerId, input.accessToken, { fields: "status_code,status" }), { method: "GET" }, STATUS_TIMEOUT_MS);
    const statusCode = text(record.status_code);
    if (!statusCode || !/^[A-Z_]{1,40}$/.test(statusCode)) throw new InstagramPublishError("container_status", "bad_answer");
    // `status` can carry Meta's words: only a short code-like value is kept (it goes into our log).
    const status = text(record.status);
    return { statusCode, status: status && /^[\w .:-]{1,80}$/.test(status) ? status : null };
  }

  async publishContainer(input: { igUserId: string; accessToken: string; containerId: string }): Promise<{ mediaId: string }> {
    const record = await this.call("media_publish", this.url(`${input.igUserId}/media_publish`, input.accessToken), this.form({ creation_id: input.containerId }), PUBLISH_TIMEOUT_MS);
    const mediaId = idText(record.id);
    if (!mediaId) throw new InstagramPublishError("media_publish", "bad_answer");
    return { mediaId };
  }

  async permalink(input: { mediaId: string; accessToken: string }): Promise<string | null> {
    const record = await this.call("permalink", this.url(input.mediaId, input.accessToken, { fields: "permalink" }), { method: "GET" }, STATUS_TIMEOUT_MS);
    return httpsLink(record.permalink);
  }

  async recentMedia(input: { igUserId: string; accessToken: string }): Promise<RecentMedia[]> {
    const record = await this.call("recent_media", this.url(`${input.igUserId}/media`, input.accessToken, { fields: "id,caption,timestamp,permalink" }), { method: "GET" }, STATUS_TIMEOUT_MS);
    const data = Array.isArray(record.data) ? record.data : [];
    return data.flatMap((item): RecentMedia[] => {
      const row = item as Record<string, unknown>;
      const id = idText(row.id);
      return id ? [{ id, caption: typeof row.caption === "string" ? row.caption : null, timestamp: text(row.timestamp), permalink: httpsLink(row.permalink) }] : [];
    });
  }
}
