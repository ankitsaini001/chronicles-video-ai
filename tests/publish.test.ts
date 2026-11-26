import {
  allowedActionsFor,
  captionHash,
  CreatePostBodySchema,
  hashtagCount,
  isCheckablePost,
  isUnconfirmedPost,
  type CheckedPost,
  type ProjectDocument,
  POST_MESSAGES,
  PUBLISH_FAILURES,
  PUBLISH_MESSAGES,
  PUBLISH_RETRY_WINDOW_MS,
  publishKeyOf,
  toPostResource,
  type InstagramConnectionDocument,
  type JobDocument,
  type PostDocument,
  type PublishAttemptLog,
  type PublishContext,
  type PublishFailure,
  type PublishStage,
  type PublishStart,
  type RecheckResult,
} from "@bytereel/db";
import { confirmCheckedPost } from "@bytereel/db";
import { type Db, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { InstagramPublishError, meaningOf, MetaInstagramPublisher, type ContainerStatus, type InstagramPublisher, type RecentMedia } from "../apps/web/lib/instagram/publish-client";
import { CHECK_AGAIN_MESSAGES, checkPostAgain, type CheckAgainDeps } from "../apps/web/lib/publish/check-again";
import { postedAtLabel, viewOnInstagramHref } from "../apps/web/lib/publish/labels";
import { FAKE_DELAYS, findPublishedMedia, REAL_DELAYS, RECONCILE_SLACK_MS, runPublishJob, type PublishDelays, type PublishJobStore } from "../apps/web/lib/publish/run-publish-job";

// F30 "Publish now (approval #2)": the H2 body rules, the caption hash and the publish key, the Post
// resource, the Published screen's words, what Instagram's errors mean, the real Meta client against a
// fake fetch (the token, the video link and Meta's own words never reach an error), and the publish
// job (apps/web/lib/publish/run-publish-job.ts) against a fake store and a scripted Instagram: success,
// slow processing, busy, a processing error, the daily limit, a lost answer after media_publish
// (reconcile, never twice), a change right before publishing, Try again after an unknown outcome.
// ZERO network calls; the real database is covered by tools/e2e/f30-publish.ts.

const TOKEN = "IGAAsecret-token-value";
const VIDEO_URL = "https://bucket.r2.example/users/u/renders/r/output.mp4?X-Amz-Signature=presigned-secret";
const IG_USER = "17841400000000001";

// ---------- the H2 body ----------

const goodBody = {
  mode: "now",
  renderId: "67330f109f1e4b2a7c0d6f01",
  mp4Sha256: `sha256:${"d".repeat(64)}`,
  connectionId: "67330f109f1e4b2a7c0d6f02",
  caption: "Ever wondered where rain comes from? 🌧️\n\n#WaterCycle #Science",
  expectedStateVersion: 5,
};
const issuesOf = (body: unknown) => {
  const parsed = CreatePostBodySchema.safeParse(body);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("H2 body (CreatePostBodySchema)", () => {
  it("accepts Publish now with the exact video, account and caption", () => {
    expect(issuesOf(goodBody)).toEqual([]);
    expect(CreatePostBodySchema.parse({ ...goodBody, caption: "a\r\nb" }).caption).toBe("a\nb");
  });

  it("refuses Schedule until F31 with the plain words, and scheduledAt with Publish now", () => {
    expect(issuesOf({ ...goodBody, mode: "scheduled", scheduledAt: "2026-12-01T10:00:00Z" })).toContain(`mode: ${POST_MESSAGES.SCHEDULE_LATER}`);
    expect(issuesOf({ ...goodBody, scheduledAt: "2026-12-01T10:00:00Z" })).toContain("scheduledAt: is only for scheduled posts");
  });

  it("caption: not empty or only spaces, at most 2,200 characters (code points), at most 30 hashtags", () => {
    expect(issuesOf({ ...goodBody, caption: "   \n " })).toContain("caption: can't be empty");
    expect(issuesOf({ ...goodBody, caption: "a".repeat(2201) })).toContain("caption: must be at most 2,200 characters");
    expect(issuesOf({ ...goodBody, caption: "🌧".repeat(2200) })).toEqual([]);
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(" ");
    expect(issuesOf({ ...goodBody, caption: tags(30) })).toEqual([]);
    expect(issuesOf({ ...goodBody, caption: tags(31) })).toContain("caption: must have at most 30 hashtags");
  });

  it("is strict: unknown fields, a malformed id or fingerprint, and stateVersion 0 are refused", () => {
    expect(issuesOf({ ...goodBody, approved: true }).length).toBeGreaterThan(0);
    expect(issuesOf({ ...goodBody, renderId: "current" })).toContain("renderId: is not a valid id");
    expect(issuesOf({ ...goodBody, mp4Sha256: "d".repeat(64) })).toContain("mp4Sha256: must be sha256: and 64 hex characters");
    expect(issuesOf({ ...goodBody, expectedStateVersion: 0 })).toContain("expectedStateVersion: must be at least 1");
  });

  it("hashtagCount counts Unicode hashtags, not a lone #", () => {
    expect(hashtagCount("#Rain #बारिश # #rain_2026")).toBe(3);
    expect(hashtagCount("no tags")).toBe(0);
  });
});

// ---------- the approval's fingerprints ----------

describe("captionHash and publishKey", () => {
  it("captionHash is sha256: + hex of the NFC text: the same words always give the same hash", () => {
    expect(captionHash("Café")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(captionHash("Café")).toBe(captionHash("Café"));
    expect(captionHash("Café")).not.toBe(captionHash("Café "));
  });

  it("publishKey names the project, video, account and THIS approval (a new approval → a new key)", () => {
    const ids = { projectId: new ObjectId(), renderId: new ObjectId(), connectionId: new ObjectId() };
    const a = publishKeyOf({ ...ids, approvalId: new ObjectId() });
    const b = publishKeyOf({ ...ids, approvalId: new ObjectId() });
    expect(a).toMatch(/^pub:[0-9a-f]{24}:[0-9a-f]{24}:[0-9a-f]{24}:[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
  });
});

// ---------- the Post resource ----------

function postDoc(overrides: Partial<PostDocument> = {}): PostDocument {
  const now = new Date("2026-11-25T06:00:00.000Z");
  const ownerId = new ObjectId();
  const renderId = new ObjectId();
  const connectionId = new ObjectId();
  const projectId = new ObjectId();
  const approvalId = new ObjectId();
  const caption = "Where does rain come from? #WaterCycle";
  return {
    _id: new ObjectId(),
    ownerId,
    projectId,
    schemaVersion: 1,
    renderId,
    connectionId,
    caption,
    mode: "now",
    scheduledAt: null,
    approval: { id: approvalId, renderId, mp4Sha256: `sha256:${"d".repeat(64)}`, connectionId, igUserId: IG_USER, captionHash: captionHash(caption), approvedBy: ownerId, approvedAt: now },
    publishKey: publishKeyOf({ projectId, renderId, connectionId, approvalId }),
    state: "publishing",
    jobId: new ObjectId(),
    destination: { username: "e2e_tester", profilePictureUrl: null },
    igContainerId: null,
    containerCreatedAt: null,
    containerStatus: null,
    igMediaId: null,
    permalink: null,
    publishAttemptedAt: null,
    attempts: 1,
    nextAttemptAt: null,
    lastError: null,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Post resource (API.md §11.3)", () => {
  it("polls every 2 s only while it is being published; never shows the publish key or the container", () => {
    expect(toPostResource(postDoc()).pollAfterMs).toBe(2000);
    expect(toPostResource(postDoc({ state: "outcome_unknown" })).pollAfterMs).toBe(2000);
    const done = toPostResource(postDoc({ state: "published", igMediaId: "17910000000000001", permalink: "https://www.instagram.com/reel/abc/" }));
    expect(done.pollAfterMs).toBeNull();
    expect(done.permalink).toBe("https://www.instagram.com/reel/abc/");
    expect(Object.keys(done)).not.toContain("publishKey");
    expect(Object.keys(done)).not.toContain("igContainerId");
    expect(Object.keys(done)).not.toContain("publishAttemptedAt");
  });
});

// ---------- plain words ----------

describe("plain words", () => {
  it("every failure has a plain message without Meta's words; only a changed approval can't be tried again", () => {
    for (const [name, f] of Object.entries(PUBLISH_FAILURES)) {
      expect(f.message.length).toBeGreaterThan(20);
      expect(f.message).not.toMatch(/meta|graph|error code|exception/i);
      expect(f.retryable).toBe(name !== "approval_stale");
    }
    expect(PUBLISH_FAILURES.limit.code).toBe("PUBLISH_LIMIT_REACHED");
  });

  it("Published screen: the time in the creator's timezone; View on Instagram links only to instagram.com", () => {
    const label = postedAtLabel(new Date("2026-11-12T13:32:00Z"), "Asia/Kolkata");
    expect(label).toContain("12 Nov 2026");
    expect(label).toMatch(/7:02\s?pm/i);
    expect(viewOnInstagramHref("https://www.instagram.com/reel/abc/", "e2e_tester")).toBe("https://www.instagram.com/reel/abc/");
    expect(viewOnInstagramHref(null, "e2e_tester")).toBe("https://www.instagram.com/e2e_tester/");
    expect(viewOnInstagramHref("https://evil.example/instagram.com/", "e2e_tester")).toBe("https://www.instagram.com/e2e_tester/");
    expect(viewOnInstagramHref("javascript:alert(1)", "e2e_tester")).toBe("https://www.instagram.com/e2e_tester/");
  });
});

// ---------- what Instagram's errors mean ----------

describe("meaningOf (Meta's error codes)", () => {
  const rejected = (code: number | null, subcode: number | null) => new InstagramPublishError("media_publish", "rejected", 400, code, subcode);
  it.each([
    ["no answer in time", new InstagramPublishError("media_publish", "timeout"), "transient"],
    ["5xx / no answer", new InstagramPublishError("media_publish", "unavailable", 503), "transient"],
    ["unreadable answer", new InstagramPublishError("media_publish", "bad_answer", 200), "transient"],
    ["daily limit (9 / 2207042)", rejected(9, 2207042), "limit"],
    ["daily limit subcode only", rejected(null, 2207042), "limit"],
    ["expired token (190)", rejected(190, null), "token"],
    ["not ready (9007 / 2207027)", rejected(9007, 2207027), "not_ready"],
    ["video unreachable (2207052)", rejected(9004, 2207052), "unreachable"],
    ["Meta server error (2207001)", rejected(-1, 2207001), "transient"],
    ["rate (4)", rejected(4, null), "transient"],
    ["anything else", rejected(100, 2207026), "rejected"],
  ])("%s", (_name, error, meaning) => {
    expect(meaningOf(error)).toBe(meaning);
  });
});

// ---------- the real Meta client (fake fetch) ----------

type Sent = { url: URL; method: string; body: URLSearchParams | null };

function metaWith(answers: Array<Response | Error>) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    sent.push({ url: new URL(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? new URLSearchParams(init.body) : null });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const next = answers.shift();
    if (!next) throw new Error("no answer scripted");
    if (next instanceof Error) throw next;
    return next;
  });
  return { meta: new MetaInstagramPublisher(fetchImpl), sent };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const metaError = (status: number, code: number, subcode: number | null) =>
  new Response(JSON.stringify({ error: { message: `Meta words that mention ${TOKEN} and ${VIDEO_URL}`, type: "OAuthException", code, error_subcode: subcode, fbtrace_id: "Axyz" } }), { status });

async function caught(promise: Promise<unknown>): Promise<InstagramPublishError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InstagramPublishError);
    return error as InstagramPublishError;
  }
  throw new Error("expected a failure");
}

describe("MetaInstagramPublisher (Meta's Reels flow; fake fetch)", () => {
  it("1. creates a REELS container: POST /v27.0/{ig-user-id}/media with video_url, caption, share_to_feed", async () => {
    const { meta, sent } = metaWith([ok({ id: "17900000000000001" })]);
    expect(await meta.createReelsContainer({ igUserId: IG_USER, accessToken: TOKEN, videoUrl: VIDEO_URL, caption: "Rain #Water" })).toEqual({ containerId: "17900000000000001" });
    const s = sent[0]!;
    expect(s.method).toBe("POST");
    expect(`${s.url.origin}${s.url.pathname}`).toBe(`https://graph.instagram.com/v27.0/${IG_USER}/media`);
    expect(s.url.searchParams.get("access_token")).toBe(TOKEN);
    expect(Object.fromEntries(s.body!)).toEqual({ media_type: "REELS", video_url: VIDEO_URL, caption: "Rain #Water", share_to_feed: "true" });
  });

  it("2. reads the container's status_code; Meta's free text in `status` is dropped", async () => {
    const { meta, sent } = metaWith([ok({ status_code: "IN_PROGRESS", status: "In Progress: 2207032" }), ok({ status_code: "ERROR", status: "x".repeat(200) })]);
    expect(await meta.containerStatus({ containerId: "17900000000000001", accessToken: TOKEN })).toEqual<ContainerStatus>({ statusCode: "IN_PROGRESS", status: "In Progress: 2207032" });
    expect(sent[0]!.url.searchParams.get("fields")).toBe("status_code,status");
    expect((await meta.containerStatus({ containerId: "17900000000000001", accessToken: TOKEN })).status).toBeNull();
  });

  it("3. publishes with creation_id; 4. reads the permalink (https only); 5. lists recent media", async () => {
    const { meta, sent } = metaWith([
      ok({ id: "17910000000000001" }),
      ok({ permalink: "https://www.instagram.com/reel/abc/" }),
      ok({ permalink: "http://insecure.example/" }),
      ok({ data: [{ id: "17910000000000001", caption: "Rain", timestamp: "2026-11-25T06:00:00+0000", permalink: "https://www.instagram.com/reel/abc/" }, { id: "not-a-number" }] }),
    ]);
    expect(await meta.publishContainer({ igUserId: IG_USER, accessToken: TOKEN, containerId: "17900000000000001" })).toEqual({ mediaId: "17910000000000001" });
    expect(`${sent[0]!.url.pathname}`).toBe(`/v27.0/${IG_USER}/media_publish`);
    expect(Object.fromEntries(sent[0]!.body!)).toEqual({ creation_id: "17900000000000001" });
    expect(await meta.permalink({ mediaId: "17910000000000001", accessToken: TOKEN })).toBe("https://www.instagram.com/reel/abc/");
    expect(await meta.permalink({ mediaId: "17910000000000001", accessToken: TOKEN })).toBeNull();
    const recent = await meta.recentMedia({ igUserId: IG_USER, accessToken: TOKEN });
    expect(recent).toEqual<RecentMedia[]>([{ id: "17910000000000001", caption: "Rain", timestamp: "2026-11-25T06:00:00+0000", permalink: "https://www.instagram.com/reel/abc/" }]);
    expect(sent[3]!.url.searchParams.get("fields")).toBe("id,caption,timestamp,permalink");
  });

  it("errors carry only the step, HTTP status and Meta's numbers: never the token, the video link or Meta's words", async () => {
    const { meta } = metaWith([metaError(400, 9, 2207042), metaError(503, 2, null), metaError(429, 4, null), Object.assign(new Error("t"), { name: "TimeoutError" }), new TypeError("fetch failed"), ok({ id: "abc" })]);
    const call = () => meta.createReelsContainer({ igUserId: IG_USER, accessToken: TOKEN, videoUrl: VIDEO_URL, caption: "c" });
    const limit = await caught(call());
    expect([limit.kind, limit.status, limit.code, limit.subcode]).toEqual(["rejected", 400, 9, 2207042]);
    expect(meaningOf(limit)).toBe("limit");
    expect((await caught(call())).kind).toBe("unavailable");
    expect((await caught(call())).kind).toBe("unavailable");
    expect((await caught(call())).kind).toBe("timeout");
    expect((await caught(call())).kind).toBe("unavailable");
    expect((await caught(call())).kind).toBe("bad_answer");
    for (const text of [limit.message, String(limit.stack)]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("presigned-secret");
      expect(text).not.toContain("Meta words");
    }
  });
});

// ---------- the publish job ----------

type FakeContainer = { id: string; caption: string; status: string };

/** A scripted Instagram (in memory). `statuses`: what each status check answers (then FINISHED). */
class ScriptedInstagram implements InstagramPublisher {
  containers = new Map<string, FakeContainer>();
  media: Array<RecentMedia & { containerId: string }> = [];
  createErrors: InstagramPublishError[] = [];
  statuses: string[] = ["IN_PROGRESS"];
  /** Per media_publish call: ok | lost (posted, answer lost) | timeout (not posted) | an error | a thrown non-Instagram error. */
  publishes: Array<"ok" | "lost" | "timeout" | InstagramPublishError | Error> = [];
  calls = { create: 0, status: 0, publish: 0, permalink: 0, recent: 0 };
  tokens = new Set<string>();
  onFinished: (() => void) | null = null;
  /** Called right after a media_publish call reached Instagram (posted or not). */
  onPublish: (() => void) | null = null;
  constructor(private readonly clock: () => Date) {}

  async createReelsContainer(input: { igUserId: string; accessToken: string; videoUrl: string; caption: string }): Promise<{ containerId: string }> {
    this.calls.create++;
    this.tokens.add(input.accessToken);
    const error = this.createErrors.shift();
    if (error) throw error;
    const id = `1790000000000${String(this.containers.size + 1).padStart(4, "0")}`;
    this.containers.set(id, { id, caption: input.caption, status: "IN_PROGRESS" });
    return { containerId: id };
  }

  async containerStatus(input: { containerId: string; accessToken: string }): Promise<ContainerStatus> {
    this.calls.status++;
    const c = this.containers.get(input.containerId);
    if (!c) throw new InstagramPublishError("container_status", "rejected", 400, 24, 2207008);
    if (c.status !== "PUBLISHED") c.status = this.statuses.shift() ?? "FINISHED";
    if (c.status === "FINISHED") this.onFinished?.();
    return { statusCode: c.status, status: null };
  }

  async publishContainer(input: { igUserId: string; accessToken: string; containerId: string }): Promise<{ mediaId: string }> {
    this.calls.publish++;
    this.onPublish?.();
    const c = this.containers.get(input.containerId)!;
    const how = this.publishes.shift() ?? "ok";
    if (how instanceof Error) throw how;
    if (how === "timeout") throw new InstagramPublishError("media_publish", "timeout");
    if (c.status !== "FINISHED") throw new InstagramPublishError("media_publish", "rejected", 400, 24, 2207008);
    c.status = "PUBLISHED";
    const id = `1791000000000${String(this.media.length + 1).padStart(4, "0")}`;
    this.media.push({ id, caption: c.caption, timestamp: this.clock().toISOString(), permalink: `https://www.instagram.com/reel/T${id.slice(-4)}/`, containerId: c.id });
    if (how === "lost") throw new InstagramPublishError("media_publish", "timeout");
    return { mediaId: id };
  }

  async permalink(input: { mediaId: string }): Promise<string | null> {
    this.calls.permalink++;
    return this.media.find((m) => m.id === input.mediaId)?.permalink ?? null;
  }

  async recentMedia(): Promise<RecentMedia[]> {
    this.calls.recent++;
    return [...this.media].reverse().map(({ containerId: _c, ...m }) => m);
  }
}

/** The database side of the job, in memory: the post and what the job saved. */
class FakeStore implements PublishJobStore {
  ended: Array<{ failure: PublishFailure; stage: PublishStage }> = [];
  completed: Array<{ mediaId: string | null; permalink: string | null }> = [];
  messages: string[] = [];
  logs: PublishAttemptLog[] = [];
  rechecks = 0;
  startAnswer: PublishStart | null;
  stale = false;
  approvalOk = true;
  /** A working token for the approved account (reconcile reads with it). */
  readerOk = true;
  constructor(
    public post: PostDocument,
    private readonly clock: () => Date,
    publishSent = false,
  ) {
    this.startAnswer = { postId: post._id.toHexString(), deadline: new Date(clock().getTime() + PUBLISH_RETRY_WINDOW_MS).toISOString(), publishSent };
  }

  start = vi.fn(async () => this.startAnswer);
  load = vi.fn(async (): Promise<PublishContext | null> => (this.stale ? null : { job: { progress: { stage: "approve" } } as unknown as JobDocument, post: { ...this.post } }));
  recheck = vi.fn(async (): Promise<RecheckResult> => {
    this.rechecks++;
    if (!this.approvalOk) return { ok: false, failure: "approval_stale", reason: "caption_changed" };
    return {
      ok: true,
      project: {} as never,
      render: { mp4Key: "users/u/projects/p/renders/r/output.mp4" } as never,
      connection: { igUserId: IG_USER, accessToken: { v: 1 } } as unknown as InstagramConnectionDocument,
    };
  });
  progress = vi.fn(async (input: { message: string }) => {
    this.messages.push(input.message);
    return true;
  });
  saveContainer = vi.fn(async (input: { containerId?: string | null; status?: string | null }) => {
    if (input.containerId !== undefined) Object.assign(this.post, { igContainerId: input.containerId, containerCreatedAt: input.containerId ? this.clock() : null, containerStatus: null });
    if (input.status !== undefined) this.post.containerStatus = input.status;
    return true;
  });
  claim = vi.fn(async () => {
    if (this.post.state !== "publishing" || this.post.publishAttemptedAt !== null || this.post.igMediaId !== null) return false;
    // Like the database's update pipeline: publishAttemptedAt and lastPublishSentAt = now;
    // firstPublishAttemptedAt = $ifNull(field, now), which fills it when it is missing OR null.
    this.post.publishAttemptedAt = this.clock();
    this.post.lastPublishSentAt = this.post.publishAttemptedAt;
    this.post.firstPublishAttemptedAt ??= this.post.publishAttemptedAt;
    return true;
  });
  unknown = vi.fn(async () => {
    this.post.state = "outcome_unknown";
    return true;
  });
  release = vi.fn(async (input: { refused?: boolean }) => {
    // A clearly refused FIRST send also clears the "ever sent" mark (releasePublishClaim).
    const firstRefused = input.refused === true && this.post.publishAttemptedAt !== null && this.post.publishAttemptedAt.getTime() === this.post.firstPublishAttemptedAt?.getTime();
    Object.assign(this.post, { state: "publishing", publishAttemptedAt: null });
    // Like the database's $unset: the fields are gone (not null).
    if (firstRefused) {
      delete this.post.firstPublishAttemptedAt;
      delete this.post.lastPublishSentAt;
    }
    return true;
  });
  complete = vi.fn(async (input: { mediaId: string | null; permalink: string | null }) => {
    Object.assign(this.post, { state: "published", igMediaId: input.mediaId, permalink: input.permalink });
    this.completed.push({ mediaId: input.mediaId, permalink: input.permalink });
    return true;
  });
  end = vi.fn(async (input: { failure: PublishFailure; stage: PublishStage }) => {
    this.post.state = "publish_failed";
    this.ended.push(input);
    return true;
  });
  log = vi.fn(async (entry: PublishAttemptLog) => void this.logs.push(entry));
  reader = vi.fn(async () => (this.readerOk ? ({ igUserId: IG_USER, accessToken: { v: 1 } } as unknown as InstagramConnectionDocument) : null));
}

function jobSetup(options: { delays?: PublishDelays; post?: Partial<PostDocument>; publishSent?: boolean } = {}) {
  let t = Date.parse("2026-11-25T06:00:00.000Z");
  const clock = () => new Date(t);
  const ig = new ScriptedInstagram(clock);
  const store = new FakeStore(postDoc(options.post), clock, options.publishSent);
  const sleeps: number[] = [];
  const steps: string[] = [];
  const logs: string[] = [];
  const deps = {
    store,
    publisher: vi.fn(() => ({ ok: true as const, publisher: ig as InstagramPublisher })),
    token: vi.fn(() => TOKEN),
    videoUrl: vi.fn(async () => VIDEO_URL),
    delays: options.delays ?? FAKE_DELAYS,
    now: clock,
    log: (level: string, message: string) => void logs.push(`${level}: ${message}`),
  };
  const step = {
    run: async <T>(id: string, fn: () => Promise<T>) => {
      steps.push(id);
      return fn();
    },
    sleep: async (_id: string, ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  const run = () => runPublishJob({ event: { jobId: store.post.jobId!.toHexString(), attempt: 1 }, runId: "run-1", step }, deps);
  /** Nothing the job saved or logged holds the token, the video link or Meta's words. */
  const clean = () => {
    const saved = JSON.stringify({ logs: store.logs, ended: store.ended, messages: store.messages, serverLog: logs });
    return !saved.includes(TOKEN) && !saved.includes("presigned-secret");
  };
  return { ig, store, deps, sleeps, steps, logs, run, clean, advance: (ms: number) => void (t += ms) };
}

describe("publish job: the happy path", () => {
  it("re-checks, creates the container from the private link, waits for FINISHED, publishes ONCE, saves the permalink", async () => {
    const s = jobSetup();
    expect(await s.run()).toBe("published");
    expect(s.ig.calls).toMatchObject({ create: 1, publish: 1, permalink: 1 });
    expect(s.ig.media).toHaveLength(1);
    expect(s.store.completed).toEqual([{ mediaId: s.ig.media[0]!.id, permalink: s.ig.media[0]!.permalink }]);
    expect(s.deps.videoUrl).toHaveBeenCalledWith("users/u/projects/p/renders/r/output.mp4");
    expect(s.ig.tokens).toEqual(new Set([TOKEN]));
    // The re-check: approve, before the container, at each status check, right before media_publish.
    expect(s.store.rechecks).toBeGreaterThanOrEqual(4);
    expect(s.store.messages).toEqual(expect.arrayContaining([PUBLISH_MESSAGES.SENDING, PUBLISH_MESSAGES.PROCESSING, PUBLISH_MESSAGES.PUBLISHING]));
    expect(s.sleeps[0]).toBe(FAKE_DELAYS.firstCheckMs);
    expect(s.steps[0]).toBe("start");
    expect(s.steps[1]).toBe("approve");
    expect(s.clean()).toBe(true);
    expect(s.store.logs.map((l) => `${l.step}:${l.outcome}`)).toEqual(["create_container:ok", "poll:in_progress", "poll:finished", "publish:ok", "permalink:ok"]);
  });

  it("slow processing: keeps checking until FINISHED", async () => {
    const s = jobSetup();
    s.ig.statuses = ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS"];
    expect(await s.run()).toBe("published");
    expect(s.ig.calls.status).toBe(5);
    expect(s.ig.calls.publish).toBe(1);
  });

  it("Instagram busy (503 twice) while creating the container: tried again automatically, then published", async () => {
    const s = jobSetup();
    s.ig.createErrors = [new InstagramPublishError("create_container", "unavailable", 503), new InstagramPublishError("create_container", "unavailable", 503)];
    expect(await s.run()).toBe("published");
    expect(s.ig.calls.create).toBe(3);
    expect(s.store.messages).toContain(PUBLISH_MESSAGES.RETRYING);
    expect(s.ig.media).toHaveLength(1);
  });

  it("a good container from an earlier attempt is reused (no second container)", async () => {
    const s = jobSetup();
    s.ig.containers.set("17900000000000099", { id: "17900000000000099", caption: s.store.post.caption, status: "FINISHED" });
    Object.assign(s.store.post, { igContainerId: "17900000000000099", containerStatus: "FINISHED", containerCreatedAt: new Date() });
    expect(await s.run()).toBe("published");
    expect(s.ig.calls.create).toBe(0);
    expect(s.ig.media[0]!.containerId).toBe("17900000000000099");
  });

  it("an EXPIRED container is dropped and a new one is made", async () => {
    const s = jobSetup();
    s.ig.statuses = ["EXPIRED"];
    expect(await s.run()).toBe("published");
    expect(s.ig.calls.create).toBe(2);
    expect(s.ig.media).toHaveLength(1);
  });

  it("'media not ready' (9007) at media_publish: the claim is released, checked again, then published once", async () => {
    const s = jobSetup();
    s.ig.publishes = [new InstagramPublishError("media_publish", "rejected", 400, 9007, 2207027)];
    expect(await s.run()).toBe("published");
    expect(s.ig.calls.publish).toBe(2);
    expect(s.ig.media).toHaveLength(1);
  });
});

describe("publish job: failures (plain reason, Try again)", () => {
  it("the container ends in ERROR → processing_error at poll; nothing published", async () => {
    const s = jobSetup();
    s.ig.statuses = ["ERROR"];
    expect(await s.run()).toBe("failed");
    expect(s.store.ended).toMatchObject([{ failure: "processing_error", stage: "poll" }]);
    expect(s.ig.calls.publish).toBe(0);
  });

  it("the daily limit → limit at publish; the claim released (nothing went out); no automatic waiting", async () => {
    const s = jobSetup();
    s.ig.publishes = [new InstagramPublishError("media_publish", "rejected", 400, 9, 2207042)];
    expect(await s.run()).toBe("failed");
    expect(s.store.ended).toMatchObject([{ failure: "limit", stage: "publish" }]);
    expect(s.store.post.publishAttemptedAt).toBeNull();
    expect(s.ig.calls.publish).toBe(1);
    expect(PUBLISH_FAILURES.limit.message).toContain("daily posting limit");
  });

  it("Instagram busy for more than about 10 minutes → too_slow (Try again)", async () => {
    const s = jobSetup({ delays: REAL_DELAYS });
    s.ig.createErrors = Array.from({ length: 200 }, () => new InstagramPublishError("create_container", "unavailable", 503));
    expect(await s.run()).toBe("failed");
    expect(s.store.ended).toMatchObject([{ failure: "too_slow", stage: "create_container" }]);
    const waited = s.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(PUBLISH_RETRY_WINDOW_MS);
    expect(waited).toBeLessThan(PUBLISH_RETRY_WINDOW_MS + 60_000);
  });

  it("an expired token (190) → token_expired; Meta couldn't fetch the video → video_unreachable", async () => {
    const a = jobSetup();
    a.ig.createErrors = [new InstagramPublishError("create_container", "rejected", 400, 190, null)];
    expect(await a.run()).toBe("failed");
    expect(a.store.ended).toMatchObject([{ failure: "token_expired", stage: "create_container" }]);
    const b = jobSetup();
    b.ig.createErrors = [new InstagramPublishError("create_container", "rejected", 400, 9004, 2207052)];
    expect(await b.run()).toBe("failed");
    expect(b.store.ended).toMatchObject([{ failure: "video_unreachable" }]);
  });

  it("a token that can't be decrypted → token_expired; Instagram not set up → internal; no Meta call", async () => {
    const a = jobSetup();
    a.deps.token.mockImplementation(() => {
      throw new Error("bad key");
    });
    expect(await a.run()).toBe("failed");
    expect(a.store.ended).toMatchObject([{ failure: "token_expired", stage: "create_container" }]);
    expect(a.ig.calls.create).toBe(0);
    const b = jobSetup();
    b.deps.publisher.mockReturnValue({ ok: false, problems: ["INSTAGRAM_APP_ID is missing."] } as never);
    expect(await b.run()).toBe("failed");
    expect(b.store.ended[0]!.failure).toBe("internal");
  });
});

describe("publish job: the approval re-check", () => {
  it("a change before anything is sent → approval_stale at approve; no container", async () => {
    const s = jobSetup();
    s.store.approvalOk = false;
    expect(await s.run()).toBe("failed");
    expect(s.store.ended).toMatchObject([{ failure: "approval_stale", stage: "approve" }]);
    expect(s.ig.calls.create).toBe(0);
  });

  it("a change while Instagram processes → approval_stale RIGHT BEFORE media_publish; nothing published, nothing claimed", async () => {
    const s = jobSetup();
    s.ig.onFinished = () => {
      s.store.approvalOk = false;
    };
    expect(await s.run()).toBe("failed");
    expect(s.store.ended).toMatchObject([{ failure: "approval_stale", stage: "publish" }]);
    expect(s.ig.calls.publish).toBe(0);
    expect(s.store.post.publishAttemptedAt).toBeNull();
    expect(s.store.claim).not.toHaveBeenCalled();
  });

  it("nothing to do: no job for this attempt, a bad id, or the post no longer waits → skipped, no Meta call", async () => {
    const a = jobSetup();
    a.store.startAnswer = null;
    expect(await a.run()).toBe("skipped");
    const b = jobSetup();
    b.store.stale = true;
    expect(await b.run()).toBe("skipped");
    const c = jobSetup();
    expect(await runPublishJob({ event: { jobId: "nope", attempt: 1 }, runId: null, step: { run: (_id, fn) => fn(), sleep: async () => undefined } }, c.deps)).toBe("skipped");
    expect([a.ig.calls.create, b.ig.calls.create, c.ig.calls.create]).toEqual([0, 0, 0]);
  });
});

describe("publish job: never twice", () => {
  it("the answer to media_publish is lost (it DID go live): outcome_unknown → reconcile finds it → published, ONE media", async () => {
    const s = jobSetup();
    s.ig.publishes = ["lost"];
    expect(await s.run()).toBe("published");
    expect(s.store.unknown).toHaveBeenCalledTimes(1);
    expect(s.ig.calls.publish).toBe(1);
    expect(s.ig.media).toHaveLength(1);
    expect(s.store.completed[0]!.mediaId).toBe(s.ig.media[0]!.id);
    expect(s.store.messages).toContain(PUBLISH_MESSAGES.CHECKING);
    expect(s.store.logs.map((l) => l.outcome)).toContain("published");
  });

  it("no answer and it did NOT go live: reconcile looks twice, then publishes the SAME container once", async () => {
    const s = jobSetup();
    s.ig.publishes = ["timeout", "ok"];
    expect(await s.run()).toBe("published");
    expect(s.ig.calls.publish).toBe(2);
    expect(s.ig.calls.create).toBe(1);
    expect(s.ig.media).toHaveLength(1);
    expect(s.store.release).toHaveBeenCalledTimes(1);
  });

  it("the claim is taken by another run → no media_publish from this one", async () => {
    const s = jobSetup();
    // The other run already finished the post: the claim fails and the post no longer waits for this job.
    s.store.claim.mockImplementation(async () => {
      s.store.stale = true;
      return false;
    });
    expect(await s.run()).toBe("skipped");
    expect(s.store.claim).toHaveBeenCalledTimes(1);
    expect(s.ig.calls.publish).toBe(0);
  });

  it("a crash during media_publish (not an Instagram answer) → outcome_unknown, and the error goes to Inngest's retry", async () => {
    const s = jobSetup();
    s.ig.publishes = [new TypeError("socket hang up")];
    await expect(s.run()).rejects.toThrow("socket hang up");
    expect(s.store.post.state).toBe("outcome_unknown");
    expect(s.store.post.publishAttemptedAt).not.toBeNull();
  });

  it("Try again after an unknown outcome goes to reconcile FIRST: it was live → published, no new container, no new publish", async () => {
    const s = jobSetup({ publishSent: true });
    s.ig.containers.set("17900000000000007", { id: "17900000000000007", caption: s.store.post.caption, status: "PUBLISHED" });
    s.ig.media.push({ id: "17910000000000007", caption: s.store.post.caption, timestamp: new Date("2026-11-25T05:59:00Z").toISOString(), permalink: "https://www.instagram.com/reel/T0007/", containerId: "17900000000000007" });
    Object.assign(s.store.post, { igContainerId: "17900000000000007", publishAttemptedAt: new Date("2026-11-25T05:58:00Z"), state: "publishing" });
    expect(await s.run()).toBe("published");
    expect(s.steps).toContain("reconcile-1");
    expect(s.ig.calls).toMatchObject({ create: 0, publish: 0 });
    expect(s.store.completed).toEqual([{ mediaId: "17910000000000007", permalink: "https://www.instagram.com/reel/T0007/" }]);
  });

  it("Try again after an unknown outcome, NOT live: reconcile (twice) → the same container published once", async () => {
    const s = jobSetup({ publishSent: true });
    s.ig.containers.set("17900000000000008", { id: "17900000000000008", caption: s.store.post.caption, status: "FINISHED" });
    s.ig.statuses = [];
    Object.assign(s.store.post, { igContainerId: "17900000000000008", publishAttemptedAt: new Date("2026-11-25T05:58:00Z"), state: "publishing" });
    expect(await s.run()).toBe("published");
    expect(s.ig.calls).toMatchObject({ create: 0, publish: 1 });
    expect(s.ig.media).toHaveLength(1);
  });

  it("reconcile: the container is ERROR → nothing was posted → processing_error (claim released)", async () => {
    const s = jobSetup({ publishSent: true });
    s.ig.containers.set("17900000000000009", { id: "17900000000000009", caption: s.store.post.caption, status: "ERROR" });
    s.ig.statuses = ["ERROR"];
    Object.assign(s.store.post, { igContainerId: "17900000000000009", publishAttemptedAt: new Date("2026-11-25T05:58:00Z") });
    expect(await s.run()).toBe("failed");
    expect(s.store.ended).toMatchObject([{ failure: "processing_error", stage: "reconcile" }]);
    expect(s.store.post.publishAttemptedAt).toBeNull();
    expect(s.ig.calls.publish).toBe(0);
  });

  it("reconcile can't get a clear answer for about 10 minutes → unconfirmed (Try again checks Instagram first)", async () => {
    const s = jobSetup({ publishSent: true, delays: REAL_DELAYS });
    Object.assign(s.store.post, { igContainerId: "17900000000000010", publishAttemptedAt: new Date("2026-11-25T05:58:00Z") });
    s.ig.recentMedia = async () => {
      throw new InstagramPublishError("recent_media", "unavailable", 503);
    };
    expect(await s.run()).toBe("failed");
    expect(s.store.ended).toMatchObject([{ failure: "unconfirmed", stage: "reconcile" }]);
    expect(s.ig.calls.publish).toBe(0);
    expect(PUBLISH_FAILURES.unconfirmed.message).toContain("never posted twice");
  });

  it("reconcile: PUBLISHED but the media isn't in the list for 10 minutes → saved as published without a link", async () => {
    const s = jobSetup({ publishSent: true, delays: REAL_DELAYS });
    s.ig.containers.set("17900000000000011", { id: "17900000000000011", caption: s.store.post.caption, status: "PUBLISHED" });
    Object.assign(s.store.post, { igContainerId: "17900000000000011", publishAttemptedAt: new Date("2026-11-25T05:58:00Z") });
    expect(await s.run()).toBe("published");
    expect(s.store.completed).toEqual([{ mediaId: null, permalink: null }]);
    expect(s.ig.calls.publish).toBe(0);
  });
});

// ---------- F30 code review fixes ----------

describe("code review MUST 1: an unconfirmed attempt blocks every new approval", () => {
  const T = new Date("2026-11-25T06:00:00Z");
  it("isUnconfirmedPost: a sent media_publish without a media id, in any state but published; checkable only when settled", () => {
    for (const state of ["publish_failed", "approval_invalidated", "cancelled"] as const) {
      expect(isUnconfirmedPost({ state, firstPublishAttemptedAt: T, igMediaId: null })).toBe(true);
      expect(isCheckablePost({ state, firstPublishAttemptedAt: T, igMediaId: null })).toBe(true);
    }
    // A job is still working on it: unconfirmed (blocks H2) but not yet "Check again".
    expect(isUnconfirmedPost({ state: "outcome_unknown", firstPublishAttemptedAt: T, igMediaId: null })).toBe(true);
    expect(isCheckablePost({ state: "outcome_unknown", firstPublishAttemptedAt: T, igMediaId: null })).toBe(false);
    expect(isUnconfirmedPost({ state: "published", firstPublishAttemptedAt: T, igMediaId: null })).toBe(false);
    expect(isUnconfirmedPost({ state: "publish_failed", firstPublishAttemptedAt: null, igMediaId: null })).toBe(false);
    expect(isUnconfirmedPost({ state: "cancelled", firstPublishAttemptedAt: T, igMediaId: "17910000000000001" })).toBe(false);
  });

  it("allowedActions: only retry_post (Check again), never publish, while such a post exists, whatever the project's step", () => {
    const plan = new ObjectId();
    const project = (state: ProjectDocument["state"]) =>
      ({
        _id: new ObjectId(),
        ownerId: new ObjectId(),
        state,
        language: "en",
        activeJobId: null,
        currentRenderId: new ObjectId(),
        currentPlanVersionId: plan,
        approvedPlanVersionId: state === "storyboard_ready" ? null : plan,
        planRequestCount: 1,
      }) as unknown as ProjectDocument;
    const unconfirmed = { state: "approval_invalidated" as const, firstPublishAttemptedAt: T, igMediaId: null };
    for (const state of ["video_ready", "publish_failed", "storyboard_ready"] as const) {
      const actions = allowedActionsFor(project(state), null, null, { latestPost: unconfirmed });
      expect(actions).toContain("retry_post");
      expect(actions).not.toContain("publish");
    }
    // Once settled (the flag cleared), approving again is offered.
    expect(allowedActionsFor(project("publish_failed"), null, null, { latestPost: { ...unconfirmed, firstPublishAttemptedAt: null } })).toContain("publish");
  });
});

describe("re-review MUST 1: the 'ever sent' mark survives a released claim", () => {
  it("lost first send → FINISHED twice → release → the second send refused → caption edit: still unconfirmed (H2 refused, only Check again)", async () => {
    const s = jobSetup();
    s.ig.publishes = ["timeout", new InstagramPublishError("media_publish", "rejected", 400, 100, 2207026)];
    expect(await s.run()).toBe("failed");
    expect(s.store.ended).toMatchObject([{ failure: "rejected", stage: "publish" }]);
    expect(s.store.release).toHaveBeenCalledTimes(2); // reconcile's release, then the refusal's
    expect(s.ig.calls.publish).toBe(2);
    // The second send's claim is gone, but the FIRST send (whose answer was lost) is remembered.
    expect(s.store.post.publishAttemptedAt).toBeNull();
    expect(s.store.post.firstPublishAttemptedAt).toBeInstanceOf(Date);
    // A caption edit cancels the approval: the post must still block a new approval (H2 → retry_instead).
    s.store.post.state = "approval_invalidated";
    expect(isUnconfirmedPost(s.store.post)).toBe(true);
    expect(isCheckablePost(s.store.post)).toBe(true);
    const project = { _id: new ObjectId(), state: "publish_failed", language: "en", activeJobId: null, currentRenderId: new ObjectId(), currentPlanVersionId: new ObjectId(), approvedPlanVersionId: new ObjectId(), planRequestCount: 1 } as unknown as ProjectDocument;
    const actions = allowedActionsFor(project, null, null, { latestPost: s.store.post });
    expect(actions).toContain("retry_post");
    expect(actions).not.toContain("publish");
  });

  it("a clearly refused FIRST send (daily limit) clears the mark: nothing ever went out, approving again is allowed", async () => {
    const s = jobSetup();
    s.ig.publishes = [new InstagramPublishError("media_publish", "rejected", 400, 9, 2207042)];
    expect(await s.run()).toBe("failed");
    expect(s.store.release).toHaveBeenCalledWith(expect.objectContaining({ refused: true }));
    expect(s.store.post.firstPublishAttemptedAt).toBeUndefined();
    s.store.post.state = "approval_invalidated";
    expect(isUnconfirmedPost(s.store.post)).toBe(false);
  });
});

describe("final review MUST 1: a cleared 'ever sent' mark is set again by the next send", () => {
  it("(a) first send refused (not ready, 9007) → re-claim → the answer is lost and can't be read back → unconfirmed: H2 would be refused", async () => {
    const s = jobSetup();
    s.ig.publishes = [new InstagramPublishError("media_publish", "rejected", 400, 9007, 2207027), "lost"];
    s.store.readerOk = false; // reconcile can't confirm
    expect(await s.run()).toBe("failed");
    expect(s.store.ended).toMatchObject([{ failure: "unconfirmed", stage: "reconcile" }]);
    expect(s.ig.media).toHaveLength(1); // the second send went live
    expect(s.store.post.firstPublishAttemptedAt).toBeInstanceOf(Date);
    expect(s.store.post.lastPublishSentAt).toBeInstanceOf(Date);
    s.store.post.state = "approval_invalidated";
    expect(isUnconfirmedPost(s.store.post)).toBe(true);
  });

  it("(b) after Check again cleared the marks (explicit null or missing), Try again → lost answer → unconfirmed again", async () => {
    for (const cleared of ["null", "missing"] as const) {
      const s = jobSetup({ post: { firstPublishAttemptedAt: null, lastPublishSentAt: null, publishAttemptedAt: null } });
      if (cleared === "missing") {
        delete s.store.post.firstPublishAttemptedAt;
        delete s.store.post.lastPublishSentAt;
      }
      s.ig.publishes = ["lost"];
      s.store.readerOk = false;
      expect(await s.run()).toBe("failed");
      expect(s.store.post.firstPublishAttemptedAt).toBeInstanceOf(Date);
      s.store.post.state = "publish_failed";
      expect(isUnconfirmedPost(s.store.post)).toBe(true);
    }
  });
});

describe("code review SHOULD 3 + 4: the job's reconcile and its plain stage errors", () => {
  it("reconcile READS with the approved account's token even after the approval stopped matching: the lost reel is still found (published, one media)", async () => {
    const s = jobSetup();
    s.ig.publishes = ["lost"];
    // A change lands right after media_publish was sent: the full re-check would fail now.
    s.ig.onPublish = () => {
      s.store.approvalOk = false;
    };
    expect(await s.run()).toBe("published");
    expect(s.store.reader).toHaveBeenCalled();
    expect(s.ig.calls.publish).toBe(1);
    expect(s.ig.media).toHaveLength(1);
  });

  it("no working token for the approved account → unconfirmed at reconcile; never a second media_publish", async () => {
    const s = jobSetup();
    s.ig.publishes = ["lost"];
    s.store.readerOk = false;
    expect(await s.run()).toBe("failed");
    expect(s.store.ended).toMatchObject([{ failure: "unconfirmed", stage: "reconcile" }]);
    expect(s.ig.calls.publish).toBe(1);
  });

  it("stage errors: the store gets only the fixed plain reason; env names and details go to the server log only", async () => {
    const s = jobSetup();
    s.deps.publisher.mockReturnValue({ ok: false, problems: ["INSTAGRAM_APP_ID is missing."] } as never);
    expect(await s.run()).toBe("failed");
    const input = s.store.end.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["attempt", "failure", "jobId", "stage"]);
    expect(JSON.stringify(s.store.ended)).not.toContain("INSTAGRAM_APP_ID");
    expect(s.logs.join(" ")).toContain("INSTAGRAM_APP_ID is missing.");
  });
});

describe("code review nit 8: reconcile's time window", () => {
  const T = new Date("2026-11-25T06:00:00Z");
  const media = (secondsFromT: number, caption = "Where does rain come from? #WaterCycle"): RecentMedia => ({
    id: `1791${String(1e12 + secondsFromT + 100).slice(-13)}`,
    caption,
    timestamp: new Date(T.getTime() + secondsFromT * 1000).toISOString(),
    permalink: null,
  });

  it("only media at or after the FIRST media_publish minus about a minute", () => {
    expect(RECONCILE_SLACK_MS).toBe(60_000);
    const post = postDoc({ publishAttemptedAt: T, firstPublishAttemptedAt: T });
    expect(findPublishedMedia(post, [media(-90)], "FINISHED")).toBeUndefined();
    expect(findPublishedMedia(post, [media(-30)], "FINISHED")?.timestamp).toBe(media(-30).timestamp);
    expect(findPublishedMedia(post, [media(5, "Another reel")], "FINISHED")).toBeUndefined();
  });

  it("starts at the first send, not a later re-claim", () => {
    const later = new Date(T.getTime() + 10 * 60_000);
    expect(findPublishedMedia(postDoc({ publishAttemptedAt: later, firstPublishAttemptedAt: T }), [media(60)], "FINISHED")).toBeDefined();
    expect(findPublishedMedia(postDoc({ publishAttemptedAt: later, firstPublishAttemptedAt: null }), [media(60)], "FINISHED")).toBeUndefined();
  });

  it("captions left out of the list: the newest media in the window counts only when the container is PUBLISHED", () => {
    const post = postDoc({ publishAttemptedAt: T, firstPublishAttemptedAt: T });
    const noCaption = { ...media(10), caption: null };
    expect(findPublishedMedia(post, [noCaption], "PUBLISHED")?.id).toBe(noCaption.id);
    expect(findPublishedMedia(post, [noCaption], "FINISHED")).toBeUndefined();
  });
});

describe("Check again (H6 reconcile-only mode): reads Instagram, never posts", () => {
  const T = new Date("2026-11-25T06:00:00Z");
  const CONTAINER = "17900000000000020";

  /** `now`: when Check again runs (default 31 min after the send, so a FINISHED container is proof). */
  function checkSetup(options: { container?: string | null; containerStatus?: string; media?: boolean; post?: Partial<PostDocument>; now?: Date } = {}) {
    const ig = new ScriptedInstagram(() => new Date(T.getTime() + 5000));
    const container = options.container === undefined ? CONTAINER : options.container;
    const post = postDoc({ state: "approval_invalidated", igContainerId: container, publishAttemptedAt: T, firstPublishAttemptedAt: T, ...options.post });
    if (container) ig.containers.set(container, { id: container, caption: post.caption, status: options.containerStatus ?? "FINISHED" });
    // The scripted Instagram answers each status check from this queue (PUBLISHED containers stay PUBLISHED).
    ig.statuses = options.containerStatus && options.containerStatus !== "PUBLISHED" ? [options.containerStatus] : [];
    if (options.media) ig.media.push({ id: "17910000000000020", caption: post.caption, timestamp: new Date(T.getTime() + 5000).toISOString(), permalink: "https://www.instagram.com/reel/T0020/", containerId: container ?? "" });
    const logs: PublishAttemptLog[] = [];
    const deps = {
      reader: vi.fn(async () => ({ igUserId: IG_USER, accessToken: { v: 1 } }) as unknown as InstagramConnectionDocument),
      publisher: vi.fn(() => ({ ok: true as const, publisher: ig as InstagramPublisher })),
      token: vi.fn(() => TOKEN),
      confirm: vi.fn(async (input: { mediaId: string | null; permalink: string | null }): Promise<CheckedPost | null> => ({ post: { ...post, state: "published", igMediaId: input.mediaId, permalink: input.permalink }, project: null })),
      clear: vi.fn(async (): Promise<PostDocument | null> => ({ ...post, publishAttemptedAt: null, firstPublishAttemptedAt: null })),
      log: vi.fn(async (entry: PublishAttemptLog) => void logs.push(entry)),
      now: () => options.now ?? new Date(T.getTime() + 31 * 60_000),
    } satisfies CheckAgainDeps;
    return { ig, post, deps, logs, run: () => checkPostAgain(post, deps) };
  }

  it("final review NICE 3: the 30 minutes count from the LAST send even after its claim was released", async () => {
    // First send long ago, its claim released (publishAttemptedAt null), a second send 1 minute ago.
    const c = checkSetup({ containerStatus: "FINISHED", post: { publishAttemptedAt: null, lastPublishSentAt: new Date(T.getTime() + 30 * 60_000) } });
    expect((await c.run()).outcome).toBe("unknown");
    const old = checkSetup({ containerStatus: "FINISHED", post: { publishAttemptedAt: null, lastPublishSentAt: T } });
    expect((await old.run()).outcome).toBe("not_posted");
  });

  it("re-review MUST 2: a FINISHED container right after the send is NOT proof (unknown); ERROR / EXPIRED are proof at any time", async () => {
    const fresh = new Date(T.getTime() + 5000);
    const finished = checkSetup({ containerStatus: "FINISHED", now: fresh });
    expect((await finished.run()).outcome).toBe("unknown");
    expect(finished.deps.clear).not.toHaveBeenCalled();
    const almost = checkSetup({ containerStatus: "FINISHED", now: new Date(T.getTime() + 29 * 60_000) });
    expect((await almost.run()).outcome).toBe("unknown");
    // The LATEST send counts: an old first send with a fresh second one is still too early.
    const resent = checkSetup({ containerStatus: "FINISHED", post: { publishAttemptedAt: new Date(T.getTime() + 30 * 60_000) } });
    expect((await resent.run()).outcome).toBe("unknown");
    for (const status of ["ERROR", "EXPIRED"]) expect((await checkSetup({ containerStatus: status, now: fresh }).run()).outcome).toBe("not_posted");
  });

  it("the reel is in the recent media → published with its id and link; no container, no media_publish", async () => {
    const c = checkSetup({ containerStatus: "PUBLISHED", media: true });
    const out = await c.run();
    expect(out.outcome).toBe("published");
    expect(c.deps.confirm).toHaveBeenCalledWith({ mediaId: "17910000000000020", permalink: "https://www.instagram.com/reel/T0020/" });
    expect(c.ig.calls).toMatchObject({ create: 0, publish: 0 });
    expect(c.deps.clear).not.toHaveBeenCalled();
  });

  it("the container is PUBLISHED but the media isn't listed → published without a link", async () => {
    const c = checkSetup({ containerStatus: "PUBLISHED" });
    expect((await c.run()).outcome).toBe("published");
    expect(c.deps.confirm).toHaveBeenCalledWith({ mediaId: null, permalink: null });
  });

  it("proven NOT posted (container FINISHED / ERROR / EXPIRED, media list read, not in it) → the flag is cleared", async () => {
    for (const status of ["FINISHED", "ERROR", "EXPIRED"]) {
      const c = checkSetup({ containerStatus: status });
      expect((await c.run()).outcome).toBe("not_posted");
      expect(c.deps.clear).toHaveBeenCalledTimes(1);
      expect(c.deps.confirm).not.toHaveBeenCalled();
      expect(c.ig.calls).toMatchObject({ create: 0, publish: 0 });
    }
    // No container was ever made: only the media list decides.
    const none = checkSetup({ container: null });
    expect((await none.run()).outcome).toBe("not_posted");
  });

  it("no clear answer (media list unreadable, container status unreadable, still IN_PROGRESS) → unknown, nothing changes", async () => {
    const outage = checkSetup();
    outage.ig.recentMedia = async () => {
      throw new InstagramPublishError("recent_media", "unavailable", 503);
    };
    const unreadable = checkSetup();
    unreadable.ig.containers.clear(); // the status call fails
    const busy = checkSetup({ containerStatus: "IN_PROGRESS" });
    busy.ig.statuses = ["IN_PROGRESS"];
    for (const c of [outage, unreadable, busy]) {
      expect((await c.run()).outcome).toBe("unknown");
      expect(c.deps.confirm).not.toHaveBeenCalled();
      expect(c.deps.clear).not.toHaveBeenCalled();
    }
    expect(CHECK_AGAIN_MESSAGES.unknown).toBe("Instagram hasn't confirmed yet. Please check again in a few minutes.");
  });

  it("no working token for the approved account → not_connected; Instagram not set up → not_set_up; no call to Instagram", async () => {
    const a = checkSetup();
    a.deps.reader.mockResolvedValue(null as never);
    expect((await a.run()).outcome).toBe("not_connected");
    const b = checkSetup();
    b.deps.token.mockImplementation(() => {
      throw new Error("bad key");
    });
    expect((await b.run()).outcome).toBe("not_connected");
    const c = checkSetup();
    c.deps.publisher.mockReturnValue({ ok: false, problems: ["x"] } as never);
    expect((await c.run()).outcome).toBe("not_set_up");
    for (const s of [a, b, c]) expect(s.ig.calls).toMatchObject({ status: 0, recent: 0, create: 0, publish: 0 });
  });

  it("already settled meanwhile → changed; the attempt log has no token", async () => {
    const c = checkSetup({ containerStatus: "PUBLISHED", media: true });
    c.deps.confirm.mockResolvedValue(null);
    expect((await c.run()).outcome).toBe("changed");
    expect(c.logs).toHaveLength(1);
    expect(c.logs[0]).toMatchObject({ step: "reconcile", jobAttempt: 0, outcome: "published" });
    expect(JSON.stringify(c.logs)).not.toContain(TOKEN);
  });
});

describe("re-review SHOULD 5: confirmCheckedPost publishes the project only for the approved video (fake database)", () => {
  function confirmDb(project: Record<string, unknown>, post: PostDocument) {
    const calls: { name: string; args: any[] }[] = [];
    const handlers: Record<string, (...args: any[]) => unknown> = {
      "posts.findOne": () => post,
      "projects.findOne": () => project,
      "posts.findOneAndUpdate": (_f: unknown, update: { $set: Record<string, unknown> }) => ({ ...post, ...update.$set }),
      "projects.findOneAndUpdate": (_f: unknown, update: { $set: Record<string, unknown> }) => ({ ...project, ...update.$set }),
      "notifications.insertMany": () => ({}),
      "auditLogs.insertOne": () => ({}),
    };
    const collection = (name: string) =>
      new Proxy(
        {},
        {
          get: (_t, method: string) => (...args: any[]) => {
            calls.push({ name: `${name}.${method}`, args });
            const handler = handlers[`${name}.${method}`];
            if (!handler) throw new Error(`unexpected ${name}.${method}`);
            return Promise.resolve(handler(...args));
          },
        },
      );
    const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: async () => undefined };
    return { db: { client: { startSession: () => session }, collection } as unknown as Db, calls };
  }
  const unconfirmed = () => postDoc({ state: "approval_invalidated", publishAttemptedAt: new Date(), firstPublishAttemptedAt: new Date() });

  it("the project has a NEWER video: the post is saved as published, the project is left as it is", async () => {
    const post = unconfirmed();
    const project = { _id: post.projectId, ownerId: post.ownerId, title: "The water cycle", state: "video_ready", activeJobId: null, stateVersion: 7, currentRenderId: new ObjectId() };
    const { db, calls } = confirmDb(project, post);
    const out = await confirmCheckedPost(db, { ownerId: post.ownerId.toHexString(), postId: post._id.toHexString(), mediaId: "17910000000000099", permalink: "https://www.instagram.com/reel/X/" });
    expect(out?.post.state).toBe("published");
    expect(calls.map((c) => c.name)).not.toContain("projects.findOneAndUpdate");
    expect(out?.project).toMatchObject({ state: "video_ready" });
    expect(calls.find((c) => c.name === "auditLogs.insertOne")!.args[0].data).toMatchObject({ projectPublished: false, via: "check_again" });
  });

  it("the project still has the approved video: post AND project published (conditional on that video)", async () => {
    const post = unconfirmed();
    const project = { _id: post.projectId, ownerId: post.ownerId, title: "The water cycle", state: "publish_failed", activeJobId: null, stateVersion: 7, currentRenderId: post.approval.renderId };
    const { db, calls } = confirmDb(project, post);
    const out = await confirmCheckedPost(db, { ownerId: post.ownerId.toHexString(), postId: post._id.toHexString(), mediaId: null, permalink: null, via: "ops_cli" });
    expect(out?.project).toMatchObject({ state: "published" });
    const [filter] = calls.find((c) => c.name === "projects.findOneAndUpdate")!.args as [Record<string, unknown>];
    expect(filter).toMatchObject({ currentRenderId: post.approval.renderId, activeJobId: null, stateVersion: 7 });
    expect(calls.find((c) => c.name === "auditLogs.insertOne")!.args[0].data).toMatchObject({ projectPublished: true, via: "ops_cli" });
  });
});
