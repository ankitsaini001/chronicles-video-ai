import { createHash, randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import { authorizeUrlFor, InstagramApiError, type InstagramApi, type InstagramProfile, type LongLivedToken, type ShortLivedToken } from "./meta-client";
import { InstagramPublishError, type ContainerStatus, type InstagramPublisher, type RecentMedia } from "./publish-client";

// A stand-in for Instagram, ONLY for automated tests and the local e2e check (E2E_FAKE_INSTAGRAM=1,
// switched on by provider.ts on a local test server only): ZERO calls to Meta. "Instagram's login
// page" is our own /api/v1/instagram/e2e-authorize page, and the "code" it hands back says what kind
// of account to pretend:
//   e2e.<kind>.<account>   kind: creator (Media_Creator) | business (Business) | personal | broken |
//                          (the code exchange fails) ; account: 1–24 of a-z 0-9 _ (the same account
//                          name gives the same Instagram id, so two test users can try ONE account);
//                          nopublish (a Creator who un-ticked "posting": no content_publish permission)
// The tokens it makes start with "e2e-" and are never valid anywhere. It works at the InstagramApi
// level (no HTTP), so how the real client sends the token (in the address for /me) doesn't matter here.

export const FAKE_AUTHORIZE_PATH = "/api/v1/instagram/e2e-authorize";
export const FAKE_KINDS = ["creator", "business", "personal", "broken", "nopublish"] as const;
export type FakeKind = (typeof FAKE_KINDS)[number];

const CODE = /^e2e\.(creator|business|personal|broken|nopublish)\.([a-z0-9_]{1,24})$/;
const TOKEN = /^e2e-(?:short|long)\.(creator|business|personal|broken|nopublish)\.([a-z0-9_]{1,24})(?:\.[A-Za-z0-9_-]+)?$/;

export function fakeCode(kind: FakeKind, account: string): string {
  return `e2e.${kind}.${account}`;
}

/** The pretend Instagram id of an account name (17841 + 12 digits, like real professional ids). */
export function fakeIgUserId(account: string): string {
  const digits = BigInt(`0x${createHash("sha256").update(account).digest("hex").slice(0, 15)}`).toString().padStart(12, "0").slice(-12);
  return `17841${digits}`;
}

const ACCOUNT_TYPE: Record<FakeKind, string> = { creator: "Media_Creator", business: "Business", personal: "Personal", broken: "Business", nopublish: "Media_Creator" };

export class FakeInstagramApi implements InstagramApi {
  constructor(private readonly appOrigin: string) {}

  authorizeUrl(state: string): string {
    return authorizeUrlFor(`${this.appOrigin}${FAKE_AUTHORIZE_PATH}`, { appId: "1000000000000001", redirectUri: `${this.appOrigin}/api/v1/instagram/callback` }, state);
  }

  async exchangeCode(code: string): Promise<ShortLivedToken> {
    const match = CODE.exec(code);
    if (!match || match[1] === "broken") throw new InstagramApiError("code_exchange", "rejected", 400);
    return { accessToken: `e2e-short.${match[1]}.${match[2]}`, permissions: match[1] === "nopublish" ? ["instagram_business_basic"] : ["instagram_business_basic", "instagram_business_content_publish"] };
  }

  async longLivedToken(shortLivedToken: string): Promise<LongLivedToken> {
    const match = TOKEN.exec(shortLivedToken);
    if (!match) throw new InstagramApiError("long_lived_token", "rejected", 400);
    return { accessToken: `e2e-long.${match[1]}.${match[2]}.${randomBytes(6).toString("base64url")}`, expiresInSeconds: 60 * 24 * 60 * 60 };
  }

  async profile(accessToken: string): Promise<InstagramProfile> {
    const match = TOKEN.exec(accessToken);
    if (!match) throw new InstagramApiError("profile", "rejected", 400);
    const kind = match[1] as FakeKind;
    const account = match[2]!;
    return { userId: fakeIgUserId(account), username: `e2e_${account}`, accountType: ACCOUNT_TYPE[kind], profilePictureUrl: null };
  }
}

/** The stand-in "Instagram login page": choose what kind of account to pretend, or cancel. */
export function fakeAuthorizePage(callbackUrl: string, state: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const link = (params: Record<string, string>) => esc(`${callbackUrl}?${new URLSearchParams({ ...params, state }).toString()}`);
  const kinds = FAKE_KINDS.map((kind) => `<li><a data-kind="${kind}" href="${link({ code: fakeCode(kind, "tester") })}">Log in as a ${kind} account (e2e_tester)</a></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Instagram stand-in</title></head>
<body style="font-family:system-ui;background:#111;color:#eee;padding:24px;max-width:560px;margin:auto">
<h1>Instagram stand-in (tests only)</h1>
<p>This is NOT Instagram. It only exists on a local test server (E2E_FAKE_INSTAGRAM=1).</p>
<form method="get" action="${esc(callbackUrl)}"><input type="hidden" name="state" value="${esc(state)}">
<label>Kind <select name="kind" id="kind">${FAKE_KINDS.map((k) => `<option>${k}</option>`).join("")}</select></label>
<label>Account <input id="account" value="tester" pattern="[a-z0-9_]{1,24}"></label>
<input type="hidden" name="code" id="code">
<button type="submit" onclick="document.getElementById('code').value='e2e.'+document.getElementById('kind').value+'.'+document.getElementById('account').value;document.getElementById('kind').disabled=true">Allow</button></form>
<ul>${kinds}</ul>
<p><a data-kind="cancel" href="${link({ error: "access_denied", error_reason: "user_denied", error_description: "The user denied your request." })}">Cancel</a></p>
</body></html>`;
}

// ---------- F30: publishing (the stand-in for /media, /media_publish, the container status) ----------
// What Instagram "does" is chosen by a word in the caption, so an e2e check can ask for each case:
//   (none)          the container is IN_PROGRESS on the first check, then FINISHED; publishing works
//   [e2e:slow]      IN_PROGRESS for the first 3 checks (slow processing), then FINISHED
//   [e2e:error]     the container ends in ERROR (Instagram couldn't process the video)
//   [e2e:busy]      creating the container fails with 503 twice, then works (automatic retries)
//   [e2e:lost]      media_publish PUBLISHES the reel but its answer is lost (a timeout) the first
//                   time: the job must find it by reconciling and must never publish again
//   [e2e:limit]     media_publish is refused with Instagram's daily-limit error (code 9 / 2207042)
// Its "Instagram" lives in the TEST database's `e2eFakeInstagram` collection (containers and posted
// media), so the e2e check can count the reels that went live. It only ever runs on bytereel_test
// (provider.ts). The video link is never fetched, stored or printed.

export const FAKE_INSTAGRAM_COLLECTION = "e2eFakeInstagram";
type FakeDoc = {
  _id: string;
  kind: "container" | "media" | "counter";
  igUserId?: string;
  caption?: string;
  checks?: number;
  status?: string;
  containerId?: string;
  timestamp?: string;
  permalink?: string;
  publishCalls?: number;
  count?: number;
};

const scenarioOf = (caption: string) => /\[e2e:(slow|error|busy|lost|limit)\]/.exec(caption)?.[1] ?? "ok";
const TOKEN_OK = /^e2e-long\./;
const digits = (n: number) => Array.from(randomBytes(n), (b) => String(b % 10)).join("");

export class FakeInstagramPublisher implements InstagramPublisher {
  constructor(private readonly db: Db) {}

  private get docs() {
    return this.db.collection<FakeDoc>(FAKE_INSTAGRAM_COLLECTION);
  }

  private checkToken(step: ConstructorParameters<typeof InstagramPublishError>[0], accessToken: string): void {
    if (!TOKEN_OK.test(accessToken)) throw new InstagramPublishError(step, "rejected", 400, 190, null);
  }

  async createReelsContainer(input: { igUserId: string; accessToken: string; videoUrl: string; caption: string }): Promise<{ containerId: string }> {
    this.checkToken("create_container", input.accessToken);
    if (!input.videoUrl.startsWith("https://")) throw new InstagramPublishError("create_container", "rejected", 400, 9004, 2207052);
    if (scenarioOf(input.caption) === "busy") {
      const key = `busy:${createHash("sha256").update(input.caption).digest("hex").slice(0, 24)}`;
      const counter = await this.docs.findOneAndUpdate({ _id: key }, { $inc: { count: 1 }, $setOnInsert: { kind: "counter" } }, { upsert: true, returnDocument: "after" });
      if ((counter?.count ?? 0) <= 2) throw new InstagramPublishError("create_container", "unavailable", 503, 2, null);
    }
    const containerId = `1790${digits(13)}`;
    await this.docs.insertOne({ _id: `container:${containerId}`, kind: "container", igUserId: input.igUserId, caption: input.caption, checks: 0, status: "IN_PROGRESS", publishCalls: 0 });
    return { containerId };
  }

  async containerStatus(input: { containerId: string; accessToken: string }): Promise<ContainerStatus> {
    this.checkToken("container_status", input.accessToken);
    const container = await this.docs.findOneAndUpdate({ _id: `container:${input.containerId}`, kind: "container" }, { $inc: { checks: 1 } }, { returnDocument: "after" });
    if (!container) throw new InstagramPublishError("container_status", "rejected", 400, 24, 2207008);
    if (container.status === "PUBLISHED") return { statusCode: "PUBLISHED", status: null };
    const scenario = scenarioOf(container.caption ?? "");
    const checks = container.checks ?? 1;
    const statusCode = scenario === "error" ? "ERROR" : checks <= (scenario === "slow" ? 3 : 1) ? "IN_PROGRESS" : "FINISHED";
    await this.docs.updateOne({ _id: container._id }, { $set: { status: statusCode } });
    return { statusCode, status: statusCode === "ERROR" ? "2207032" : null };
  }

  async publishContainer(input: { igUserId: string; accessToken: string; containerId: string }): Promise<{ mediaId: string }> {
    this.checkToken("media_publish", input.accessToken);
    const container = await this.docs.findOneAndUpdate({ _id: `container:${input.containerId}`, kind: "container" }, { $inc: { publishCalls: 1 } }, { returnDocument: "after" });
    if (!container || container.igUserId !== input.igUserId) throw new InstagramPublishError("media_publish", "rejected", 400, 24, 2207008);
    if (container.status === "PUBLISHED") throw new InstagramPublishError("media_publish", "rejected", 400, 24, 2207008);
    if (container.status !== "FINISHED") throw new InstagramPublishError("media_publish", "rejected", 400, 9007, 2207027);
    const scenario = scenarioOf(container.caption ?? "");
    if (scenario === "limit") throw new InstagramPublishError("media_publish", "rejected", 400, 9, 2207042);
    const mediaId = `1791${digits(13)}`;
    // Instagram's own rule: a container is published once; it is PUBLISHED from now on.
    const claimed = await this.docs.updateOne({ _id: container._id, status: "FINISHED" }, { $set: { status: "PUBLISHED" } });
    if (claimed.modifiedCount !== 1) throw new InstagramPublishError("media_publish", "rejected", 400, 24, 2207008);
    await this.docs.insertOne({
      _id: `media:${mediaId}`,
      kind: "media",
      igUserId: input.igUserId,
      containerId: input.containerId,
      caption: container.caption ?? "",
      timestamp: new Date().toISOString(),
      permalink: `https://www.instagram.com/reel/E2E${mediaId.slice(-8)}/`,
    });
    // The first publish of a "lost" post goes live, but the answer never reaches us.
    if (scenario === "lost" && (container.publishCalls ?? 1) === 1) throw new InstagramPublishError("media_publish", "timeout");
    return { mediaId };
  }

  async permalink(input: { mediaId: string; accessToken: string }): Promise<string | null> {
    this.checkToken("permalink", input.accessToken);
    return (await this.docs.findOne({ _id: `media:${input.mediaId}`, kind: "media" }))?.permalink ?? null;
  }

  async recentMedia(input: { igUserId: string; accessToken: string }): Promise<RecentMedia[]> {
    this.checkToken("recent_media", input.accessToken);
    const media = await this.docs.find({ kind: "media", igUserId: input.igUserId }).sort({ timestamp: -1 }).limit(25).toArray();
    return media.map((m) => ({ id: m._id.slice("media:".length), caption: m.caption ?? null, timestamp: m.timestamp ?? null, permalink: m.permalink ?? null }));
  }
}
