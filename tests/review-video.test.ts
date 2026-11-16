import { API_RATE_LIMITS, findProjectRender, InvalidCursorError, listProjectRenders, toRenderSummary, type ProjectDocument, type RenderDocument, type RateLimitResult } from "@bytereel/db";
import { attachmentContentDisposition } from "@bytereel/storage";
import { type Db, ObjectId } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiDeps } from "../apps/web/lib/api/v1";
import type { SessionUser } from "../apps/web/lib/auth/session";
import { downloadFilename, listRenderSummaries, mediaQuery, renderMedia, videoMediaDeps, type VideoMediaDeps } from "../apps/web/lib/video/media";

// F24 "Step 3: watch and download the video": F1 (the project's video versions) and F3 (a private
// link to play, download or show one) through the real /api/v1 pipeline with fakes for the session,
// the database and R2; the database queries (owner + project scoped, newest first, `current`); the
// download's file name; and that a presigned link never reaches a log. The real database, R2 and
// the page are checked by tools/e2e/f24-review.ts.

const APP = "http://localhost:3000";
const OWNER = new ObjectId("67330c1a9f1e4b2a7c0d1e01");
const PROJECT = new ObjectId("67330d5e9f1e4b2a7c0d2a10");
const V1 = new ObjectId("67330e019f1e4b2a7c0d2b02");
const V2 = new ObjectId("67330e019f1e4b2a7c0d2b03");
const R1 = new ObjectId("67330f109f1e4b2a7c0d6f01");
const R2 = new ObjectId("67330f109f1e4b2a7c0d6f02");
const NOW = new Date("2026-11-16T05:00:00.000Z");
const SECRET_LINK = "https://bucket.example.r2.cloudflarestorage.com/users/x/output.mp4?X-Amz-Credential=FAKEKEYID&X-Amz-Signature=deadbeef";

const user: SessionUser = {
  id: OWNER.toHexString(),
  name: "Ananya Iyer",
  email: "ananya.iyer@example.in",
  role: "creator",
  timezone: "Asia/Kolkata",
  defaultLanguage: "en",
  defaultVoiceGender: "female",
  createdAt: "2026-11-12T04:30:00.000Z",
};
const otherUser: SessionUser = { ...user, id: "67330c1a9f1e4b2a7c0d1e99", email: "someone.else@example.in" };
const allowed: RateLimitResult = { allowed: true, count: 1, limit: 300, resetsAt: new Date(), retryAfterSeconds: 60 };

function projectDoc(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    _id: PROJECT,
    ownerId: OWNER,
    schemaVersion: 1,
    title: "Why is the sky blue?",
    language: "en",
    voiceGender: "female",
    input: { type: "topic", text: "Why is the sky blue?", brainstormChoice: null },
    state: "video_ready",
    currentPlanVersionId: V2,
    approvedPlanVersionId: V2,
    currentRenderId: R2,
    activeJobId: null,
    stateVersion: 9,
    planRequestCount: 1,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

const folder = (id: ObjectId) => `users/${OWNER.toHexString()}/projects/${PROJECT.toHexString()}/renders/${id.toHexString()}`;
function renderDoc(id: ObjectId, renderNumber: number, overrides: Partial<RenderDocument> = {}): RenderDocument {
  return {
    _id: id,
    ownerId: OWNER,
    projectId: PROJECT,
    schemaVersion: 1,
    planVersionId: renderNumber === 1 ? V1 : V2,
    planHash: `sha256:${"a".repeat(64)}`,
    renderNumber,
    speech: [],
    captionOverrideSetId: null,
    timelineKey: `${folder(id)}/timeline.json`,
    captionsKey: `${folder(id)}/captions.json`,
    mp4Key: `${folder(id)}/output.mp4`,
    thumbnailKey: `${folder(id)}/thumbnail.jpg`,
    qaKey: `${folder(id)}/qa.json`,
    previewFrameKeys: [],
    renderInputHash: `sha256:${"b".repeat(64)}`,
    mp4Sha256: `sha256:${String(renderNumber).repeat(64)}`,
    qa: {},
    status: "ready",
    metrics: { renderMs: 180000, bundleMs: 9000, bytes: 6_900_000 + renderNumber, durationMs: 67000, frames: 2010 },
    error: null,
    createdAt: NOW,
    readyAt: NOW,
    ...overrides,
  };
}

/** Fake database + R2 for the handlers: only OWNER's project and its two videos exist. */
function setup(options: { renders?: RenderDocument[]; project?: ProjectDocument; presignFails?: boolean } = {}) {
  const project = options.project ?? projectDoc();
  const renders = options.renders ?? [renderDoc(R2, 2), renderDoc(R1, 1)];
  const presigned: { key: string; options: { downloadFilename?: string } | undefined }[] = [];
  const logs: string[] = [];
  const deps: VideoMediaDeps = {
    findProject: vi.fn(async (userId: string, projectId: string) => (userId === OWNER.toHexString() && projectId === PROJECT.toHexString() ? project : null)),
    listRenders: vi.fn(async (_p, page) => {
      if (page.cursor === "bad") throw new InvalidCursorError();
      return { items: renders, nextCursor: null };
    }),
    findRender: vi.fn(async (p, renderId) => {
      const id = renderId === "current" ? p.currentRenderId?.toHexString() : renderId;
      return renders.find((r) => r._id.toHexString() === id) ?? null;
    }),
    presign: vi.fn(async (key: string, opts?: { downloadFilename?: string }) => {
      presigned.push({ key, options: opts });
      if (options.presignFails) throw new Error(`R2 refused ${SECRET_LINK}`);
      return { url: `${SECRET_LINK}&key=${encodeURIComponent(key)}`, expiresAt: new Date(NOW.getTime() + 900_000) };
    }),
  };
  const apiDeps = (who: SessionUser): ApiDeps => ({
    appOrigins: [APP],
    getUser: async () => who,
    hitRateLimit: vi.fn(async () => allowed),
    logError: (message, error) => void logs.push(`${message} ${error instanceof Error ? error.message : String(error)}`),
    newRequestId: () => "req_TEST0000000000",
  });
  const get = (path: string, who: SessionUser = user) => {
    const url = `${APP}${path}`;
    const parts = new URL(url).pathname.split("/");
    const projectId = parts[4]!;
    const endpoint =
      parts.length === 6
        ? { rateLimit: API_RATE_LIMITS.readsPerUser, handle: ({ user: u }: { user: SessionUser }) => listRenderSummaries(deps, u.id, projectId, new URL(url)) }
        : { rateLimit: API_RATE_LIMITS.readsPerUser, handle: ({ user: u }: { user: SessionUser }) => renderMedia(deps, u.id, projectId, parts[6]!, new URL(url)) };
    return handleApiRequest(new Request(url, { method: "GET" }), endpoint, apiDeps(who));
  };
  return { deps, presigned, logs, get };
}

const P = `/api/v1/projects/${PROJECT.toHexString()}`;

describe("F1 GET /renders: the project's video versions", () => {
  it("newest first, the project's video marked isCurrent, each with a 15-minute thumbnail link", async () => {
    const { get, presigned } = setup();
    const r = await get(`${P}/renders`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(body.items.map((i) => [i.renderNumber, i.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toMatchObject({ id: R2.toHexString(), projectId: PROJECT.toHexString(), planVersionId: V2.toHexString(), status: "ready", width: 1080, height: 1920, fps: 30, durationMs: 67000, bytes: 6_900_002, mp4Sha256: `sha256:${"2".repeat(64)}`, captionOverrideSetId: null, error: null, readyAt: NOW.toISOString() });
    expect(String(body.items[1]!.thumbnailUrl)).toContain(encodeURIComponent(renderDoc(R1, 1).thumbnailKey));
    expect(presigned.map((p) => p.key)).toEqual([renderDoc(R2, 2).thumbnailKey, renderDoc(R1, 1).thumbnailKey]);
  });

  it("another user's project, a missing one and a malformed id → 404; nothing is signed", async () => {
    const { get, presigned } = setup();
    for (const [path, who] of [
      [`${P}/renders`, otherUser],
      [`/api/v1/projects/67330d5e9f1e4b2a7c0d2a99/renders`, user],
      [`/api/v1/projects/not-an-id/renders`, user],
    ] as const) {
      const r = await get(path, who);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: { code: "NOT_FOUND", message: "We couldn't find this project.", requestId: "req_TEST0000000000" } });
    }
    expect(presigned).toEqual([]);
  });

  it("a bad cursor or limit → 400 INVALID_INPUT", async () => {
    const { get } = setup();
    expect((await get(`${P}/renders?cursor=bad`)).status).toBe(400);
    expect((await get(`${P}/renders?limit=0`)).status).toBe(400);
    expect((await get(`${P}/renders?limit=51`)).status).toBe(400);
  });

  it("a thumbnail link that can't be made never hides the video (thumbnailUrl null)", async () => {
    const { get } = setup({ presignFails: true });
    const r = await get(`${P}/renders`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { thumbnailUrl: unknown }[] };
    expect(body.items.map((i) => i.thumbnailUrl)).toEqual([null, null]);
  });
});

describe("F3 GET /renders/{renderId}/media: a private link", () => {
  it("kind=video → the MP4, inline (no download name); 15 minutes", async () => {
    const { get, presigned } = setup();
    const r = await get(`${P}/renders/${R1.toHexString()}/media?kind=video`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as Record<string, string>;
    expect(body.kind).toBe("video");
    expect(body.url).toContain(encodeURIComponent(renderDoc(R1, 1).mp4Key));
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + 900_000).toISOString());
    expect(presigned).toEqual([{ key: renderDoc(R1, 1).mp4Key, options: {} }]);
  });

  it("kind=download → the MP4 as an attachment named after the project title", async () => {
    const { get, presigned } = setup();
    const r = await get(`${P}/renders/${R2.toHexString()}/media?kind=download`);
    expect(r.status).toBe(200);
    expect(presigned).toEqual([{ key: renderDoc(R2, 2).mp4Key, options: { downloadFilename: "Why is the sky blue.mp4" } }]);
  });

  it("kind=thumbnail → the JPEG", async () => {
    const { get, presigned } = setup();
    const r = await get(`${P}/renders/${R2.toHexString()}/media?kind=thumbnail`);
    expect(((await r.json()) as { kind: string }).kind).toBe("thumbnail");
    expect(presigned.map((p) => p.key)).toEqual([renderDoc(R2, 2).thumbnailKey]);
  });

  it("`current` is the project's video (currentRenderId)", async () => {
    const { get, presigned } = setup();
    const r = await get(`${P}/renders/current/media?kind=video`);
    expect(r.status).toBe(200);
    expect(presigned[0]!.key).toBe(renderDoc(R2, 2).mp4Key);
  });

  it("`current` when the project has no video yet → 404 with reason no_video_yet", async () => {
    const { get } = setup({ project: projectDoc({ state: "storyboard_ready", currentRenderId: null }) });
    const r = await get(`${P}/renders/current/media?kind=video`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: { details: unknown } }).error.details).toEqual({ reason: "no_video_yet" });
  });

  it("redirect=true → 302 to the link (still no-store, with the request id)", async () => {
    const { get } = setup();
    const r = await get(`${P}/renders/${R1.toHexString()}/media?kind=download&redirect=true`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain(encodeURIComponent(renderDoc(R1, 1).mp4Key));
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-request-id")).toBe("req_TEST0000000000");
    expect((await get(`${P}/renders/${R1.toHexString()}/media?kind=video&redirect=false`)).status).toBe(200);
  });

  it("another user, another project's video, a missing or malformed video → 404; nothing is signed", async () => {
    const { get, presigned } = setup();
    expect((await get(`${P}/renders/${R1.toHexString()}/media?kind=video`, otherUser)).status).toBe(404);
    expect((await get(`/api/v1/projects/67330d5e9f1e4b2a7c0d2a99/renders/${R1.toHexString()}/media?kind=video`)).status).toBe(404);
    const missing = await get(`${P}/renders/67330f109f1e4b2a7c0d6f99/media?kind=download&redirect=true`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toBe("We couldn't find this video.");
    expect((await get(`${P}/renders/..%2F..%2Fsecret/media?kind=video`)).status).toBe(404);
    expect(presigned).toEqual([]);
  });

  it("a video that isn't ready → 409 INVALID_STATE with its status; nothing is signed", async () => {
    const R3 = new ObjectId("67330f109f1e4b2a7c0d6f03");
    const { get, presigned } = setup({ renders: [renderDoc(R3, 3, { status: "rendering", readyAt: null }), renderDoc(new ObjectId("67330f109f1e4b2a7c0d6f04"), 4, { status: "failed" })] });
    const r = await get(`${P}/renders/${R3.toHexString()}/media?kind=video`);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: { code: "INVALID_STATE", message: "This video is still being made.", details: { renderStatus: "rendering" }, requestId: "req_TEST0000000000" } });
    const failed = await get(`${P}/renders/67330f109f1e4b2a7c0d6f04/media?kind=download&redirect=true`);
    expect(failed.status).toBe(409);
    expect(((await failed.json()) as { error: { details: unknown } }).error.details).toEqual({ renderStatus: "failed" });
    expect(presigned).toEqual([]);
  });

  it("kind is required and checked; redirect only true/false; each given once (400 before the owner check)", async () => {
    const { get, deps } = setup();
    for (const query of ["", "?kind=mp4", "?kind=video&redirect=yes", "?kind=video&kind=download", "?kind=video&redirect=true&redirect=false"]) {
      const r = await get(`${P}/renders/current/media${query}`);
      expect(r.status, query).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
    }
    expect(deps.findProject).not.toHaveBeenCalled();
    expect(mediaQuery(new URL(`${APP}/x?kind=thumbnail`))).toEqual({ kind: "thumbnail", redirect: false });
  });
});

describe("presigned links never reach a log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("F1 and F3 (success, redirect, refusals, a storage failure) write no link to any log", async () => {
    const printed: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(" ")));
    const ok = setup();
    await ok.get(`${P}/renders`);
    await ok.get(`${P}/renders/current/media?kind=video`);
    await ok.get(`${P}/renders/current/media?kind=download&redirect=true`);
    await ok.get(`${P}/renders/current/media?kind=thumbnail`);
    await ok.get(`${P}/renders/current/media?kind=video`, otherUser);
    const broken = setup({ presignFails: true });
    expect((await broken.get(`${P}/renders/current/media?kind=video`)).status).toBe(500);
    const all = [...printed, ...ok.logs, ...broken.logs].join("\n");
    expect(all).not.toContain("X-Amz");
    expect(all).not.toContain("r2.cloudflarestorage.com");
    expect(broken.logs.join("\n")).toContain("Could not make a private video link: unknown storage error");
  });

  it("the real storage wrapper: a signed link (dummy keys, signed locally, no network) is returned, never printed; the download carries the attachment name", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "0123456789abcdef0123456789abcdef");
    vi.stubEnv("R2_ACCESS_KEY_ID", "FAKEACCESSKEYID0000000000000000a");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "fakesecretfakesecretfakesecretfakesecretfakesecretfakesecret0000");
    vi.stubEnv("R2_BUCKET", "reel-app-dev");
    const printed: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(" ")));
    try {
      const media = videoMediaDeps({} as Db);
      const key = renderDoc(R1, 1).mp4Key;
      const inline = await media.presign(key);
      expect(inline.url).toContain("X-Amz-Expires=900");
      expect(inline.url).not.toContain("response-content-disposition");
      const download = await media.presign(key, { downloadFilename: "Why is the sky blue.mp4" });
      expect(decodeURIComponent(download.url)).toContain('attachment; filename="Why is the sky blue.mp4"');
      await expect(media.presign("../../etc/passwd")).rejects.toThrow("not a valid storage key");
      expect(printed.join("\n")).not.toContain("X-Amz");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the download's file name (from the project title)", () => {
  it("keeps spaces, apostrophes, accents, Hindi and emoji; always ends in .mp4", () => {
    expect(downloadFilename("How UPI payments work")).toBe("How UPI payments work.mp4");
    expect(downloadFilename("Let's talk about rain")).toBe("Let's talk about rain.mp4");
    expect(downloadFilename("Café culture 🌧️ in Mumbai")).toBe("Café culture 🌧️ in Mumbai.mp4");
    expect(downloadFilename("बारिश कैसे होती है")).toBe("बारिश कैसे होती है.mp4");
    expect(downloadFilename("Recap.MP4")).toBe("Recap.mp4");
    expect(downloadFilename("Recap.mp4.mp4")).toBe("Recap.mp4");
  });

  it("removes double quotes and backticks; Windows-forbidden characters; collapses spaces", () => {
    expect(downloadFilename('The "best" `idea`')).toBe("The best idea.mp4");
    expect(downloadFilename("\u201CSmart\u201D quotes")).toBe("Smart quotes.mp4");
    expect(downloadFilename("UPI: what * is? <it> | really")).toBe("UPI what is it really.mp4");
  });

  it("slashes and path bits never make a path or a hidden file", () => {
    expect(downloadFilename("Input/Output\\Basics")).toBe("Input-Output-Basics.mp4");
    expect(downloadFilename("../../etc/passwd")).toBe("etc-passwd.mp4");
    expect(downloadFilename(".hidden")).toBe("hidden.mp4");
    expect(downloadFilename("Ends with dots...")).toBe("Ends with dots.mp4");
  });

  it("control characters (CR/LF, NUL, tab), invisible characters and a broken surrogate are removed", () => {
    expect(downloadFilename("Line one\r\nSet-Cookie: x=1")).toBe("Line oneSet-Cookie x=1.mp4");
    expect(downloadFilename("Tab\there\u0000 and\u202E bidi\u200B")).toBe("Tabhere and bidi.mp4");
    expect(downloadFilename("Broken \uD83D surrogate")).toBe("Broken \uFFFD surrogate.mp4");
  });

  it("an empty or nothing-left title → video.mp4", () => {
    for (const title of ["", "   ", '""', "../..", "\r\n", "///", ".mp4", "?*:"]) expect(downloadFilename(title), JSON.stringify(title)).toBe("video.mp4");
  });

  it("a very long title is cut to 80 characters (whole characters, never half an emoji) + .mp4", () => {
    const long = downloadFilename("Why ".repeat(60));
    expect(long).toBe(`${"Why ".repeat(20).trim()}.mp4`);
    const emoji = downloadFilename("🌧".repeat(100));
    expect([...emoji.replace(/\.mp4$/, "")]).toHaveLength(80);
    expect(emoji).toBe(`${"🌧".repeat(80)}.mp4`);
  });

  it("the header the browser gets is safe: ASCII fallback + UTF-8 name, no line breaks or stray quotes", () => {
    const header = attachmentContentDisposition(downloadFilename('Rain "in" India 🌧\r\nX: y'));
    expect(header).toBe(`attachment; filename="Rain in India X y.mp4"; filename*=UTF-8''Rain%20in%20India%20%F0%9F%8C%A7X%20y.mp4`);
    expect(header).not.toMatch(/[\r\n]/);
  });
});

/**
 * A database that answers each "collection.method" with the given handler and records every call
 * (find returns a chain: sort → limit → toArray).
 */
function fakeDb(handlers: Record<string, (...args: any[]) => unknown>) {
  const calls: { name: string; args: any[]; sort?: unknown; limit?: unknown }[] = [];
  const collection = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => (...args: any[]) => {
          const call: (typeof calls)[number] = { name: `${name}.${method}`, args };
          calls.push(call);
          const handler = handlers[call.name];
          if (!handler) throw new Error(`unexpected ${call.name}`);
          const value = handler(...args);
          if (method !== "find") return Promise.resolve(value);
          const chain = {
            sort: (s: unknown) => ((call.sort = s), chain),
            limit: (l: unknown) => ((call.limit = l), chain),
            toArray: async () => value,
          };
          return chain;
        },
      },
    );
  return { db: { collection } as unknown as Db, calls };
}

describe("the database queries (owner AND project scoped)", () => {
  it("findProjectRender: by id or `current`, always with ownerId and projectId", async () => {
    const { db, calls } = fakeDb({ "renders.findOne": () => renderDoc(R1, 1) });
    const project = projectDoc();
    await findProjectRender(db, project, R1.toHexString());
    await findProjectRender(db, project, "current");
    expect(calls.map((c) => c.args[0])).toEqual([
      { _id: R1, ownerId: OWNER, projectId: PROJECT },
      { _id: R2, ownerId: OWNER, projectId: PROJECT },
    ]);
  });

  it("findProjectRender: a malformed id, or `current` without a video → null without asking the database", async () => {
    const { db, calls } = fakeDb({});
    expect(await findProjectRender(db, projectDoc(), "../x")).toBeNull();
    expect(await findProjectRender(db, projectDoc(), R1.toHexString().toUpperCase())).toBeNull();
    expect(await findProjectRender(db, projectDoc({ currentRenderId: null }), "current")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("listProjectRenders: newest first (renderNumber desc), pages by the last number shown", async () => {
    const docs = [renderDoc(R2, 3), renderDoc(R1, 2), renderDoc(new ObjectId(), 1)];
    const { db, calls } = fakeDb({ "renders.find": () => docs });
    const first = await listProjectRenders(db, projectDoc(), { limit: 2, cursor: null });
    expect(first.items.map((r) => r.renderNumber)).toEqual([3, 2]);
    expect(first.nextCursor).not.toBeNull();
    expect(calls[0]!.args[0]).toEqual({ projectId: PROJECT, ownerId: OWNER });
    expect(calls[0]!.sort).toEqual({ renderNumber: -1 });
    expect(calls[0]!.limit).toBe(3);
    await listProjectRenders(db, projectDoc(), { limit: 2, cursor: first.nextCursor });
    expect(calls[1]!.args[0]).toEqual({ projectId: PROJECT, ownerId: OWNER, renderNumber: { $lt: 2 } });
  });

  it("listProjectRenders: the last page has no cursor; a tampered cursor is refused", async () => {
    const { db } = fakeDb({ "renders.find": () => [renderDoc(R1, 1)] });
    expect((await listProjectRenders(db, projectDoc(), { limit: 20, cursor: null })).nextCursor).toBeNull();
    for (const cursor of ["!!", Buffer.from('{"v":2}').toString("base64url"), Buffer.from('{"n":0}').toString("base64url"), Buffer.from('{"n":"2"}').toString("base64url")]) {
      await expect(listProjectRenders(db, projectDoc(), { limit: 20, cursor })).rejects.toBeInstanceOf(InvalidCursorError);
    }
  });

  it("toRenderSummary: isCurrent follows the project's currentRenderId", () => {
    expect(toRenderSummary(renderDoc(R2, 2), projectDoc(), null).isCurrent).toBe(true);
    expect(toRenderSummary(renderDoc(R1, 1), projectDoc(), null).isCurrent).toBe(false);
    expect(toRenderSummary(renderDoc(R1, 1), projectDoc({ currentRenderId: null }), "t").thumbnailUrl).toBe("t");
  });
});
