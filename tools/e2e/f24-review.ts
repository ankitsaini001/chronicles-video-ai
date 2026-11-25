import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { addInvite, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, readDbConfig, type ProjectDocument, type RenderDocument } from "@bytereel/db";
import { isStorageKey, R2ArtifactStore, readR2Config } from "@bytereel/storage";
import { ObjectId } from "mongodb";

/**
 * F24 end-to-end check over real HTTP: the Step 3 review screen, F1 (video versions) and F3 (private
 * links to play and download). NO video is made and NO AI or voice call is possible: the check seeds
 * a project and two `renders` documents that point at real videos F23's e2e left in the dev R2
 * bucket (one F23 test user's two render folders, below), with their real SHA-256 from qa.json.
 * It only READS from R2 (never uploads or deletes). Downloads go to runs/f24-work/.
 *
 * TEMP FILES: never in /tmp. In every terminal used below, first run from the repo root:
 *   mkdir -p runs/.tmp && export TMPDIR="$PWD/runs/.tmp"
 * SAFETY: only the separate test database `bytereel_test`, ports 3230–3239 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3234 E2E_FAKE_GEMINI=1 E2E_FAKE_ELEVENLABS=1 \
 *        INNGEST_DEV=http://localhost:8299 REMOTION_SERVE_PORT=3240 npx next start -p 3234
 *      (no Inngest is started: nothing listens on 8299, so even a mistaken job event could never reach
 *       the founder's Inngest on 8288)
 *   3. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3234 npx tsx tools/e2e/f24-review.ts
 *   4. stop the server (by its pid) and drop the bytereel_test database afterwards.
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has MONGODB_DB=bytereel_test, E2E_FAKE_GEMINI=1, E2E_FAKE_ELEVENLABS=1 and
 * INNGEST_DEV on port 8299 and REMOTION_SERVE_PORT 3240–3249 (Remotion's render server; never 3000). Presigned links are never printed (they contain the token's key id).
 */

const TEST_DB = "bytereel_test";
process.loadEnvFile(".env");
const base = process.env.E2E_BASE_URL ?? "";
if (!/^http:\/\/localhost:323\d$/.test(base)) throw new Error("Set E2E_BASE_URL to http://localhost:3230–3239 (never port 3000).");
const settings = readDbConfig(process.env);
if (!settings.ok) throw new Error(settings.problems.join(" "));
if (settings.config.dbName !== TEST_DB) throw new Error(`Refusing to run: MONGODB_DB must be ${TEST_DB}.`);
const db = getDb(settings.config);
const r2 = readR2Config(process.env);
if (!r2.ok) throw new Error(r2.problems.join(" "));
const files = R2ArtifactStore.fromConfig(r2.config);

function serverSettings(port: string) {
  const listing = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
  const pid = /pid=(\d+)/.exec(listing)?.[1];
  if (!pid) throw new Error(`No server process found on port ${port}.`);
  const env = new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  return env.get("E2E_FAKE_GEMINI") === "1" && env.get("E2E_FAKE_ELEVENLABS") === "1" && env.get("MONGODB_DB") === TEST_DB && env.get("INNGEST_DEV") === "http://localhost:8299" && /^324\d$/.test(env.get("REMOTION_SERVE_PORT") ?? "");
}
if (!serverSettings(new URL(base).port)) throw new Error("Stopping before any request: the server must run with MONGODB_DB=bytereel_test, E2E_FAKE_GEMINI=1, E2E_FAKE_ELEVENLABS=1 and INNGEST_DEV=http://localhost:8299 and REMOTION_SERVE_PORT=3240–3249 (the render's own server: never port 3000).");

/**
 * Two finished videos of ONE F23 e2e test user (dev bucket, from runs/f23-work/r2-keys-all.txt), the
 * older one first. They sit in two different project folders of that user; the keys are taken as
 * stored (F3 signs the key saved on the render document).
 */
const SOURCE_USER = "6af9f09fa4ee0f759abd79e4";
const SOURCE_RENDERS = [
  { renderId: "6af9f0aca4ee0f759abd7a09", folder: `users/${SOURCE_USER}/projects/6af9f0a1a4ee0f759abd79f1/renders/6af9f0aca4ee0f759abd7a09` },
  { renderId: "6af9f1c1a4ee0f759abd7a23", folder: `users/${SOURCE_USER}/projects/6af9f0a2a4ee0f759abd79f6/renders/6af9f1c1a4ee0f759abd7a23` },
];
const TITLE = 'Why is the sky "blue"? / F24 e2e';
const EXPECTED_NAME = "Why is the sky blue - F24 e2e.mp4";
const WORK = path.join(process.cwd(), "runs", "f24-work");

const tag = randomBytes(4).toString("hex");
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

type Json = Record<string, any>;
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const send = async (cookie: string, url: string) => {
  const r = await fetch(`${base}${url}`, { redirect: "manual", headers: { cookie } });
  return { status: r.status, headers: r.headers, json: (await r.json().catch(() => ({}))) as Json };
};
const page = async (cookie: string, url: string) => {
  const r = await fetch(`${base}${url}`, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, html: (await r.text()).replace(/<!-- -->/g, "") };
};

async function signUp(label: string): Promise<{ cookie: string; id: ObjectId }> {
  const email = `f24-e2e-${label}-${tag}@example.com`;
  await addInvite(db, email, { note: "F24 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `F24 Tester ${label}`, email, password: `E2e-${randomBytes(9).toString("base64url")}` }),
  });
  check(`test account ${label} created`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId };
}

/** Downloads a link's body into runs/f24-work/<name> and returns its "sha256:<hex>" (the link is never printed). */
async function downloadTo(link: string, name: string): Promise<{ status: number; disposition: string; type: string; sha256: string; bytes: number }> {
  const r = await fetch(link);
  const disposition = r.headers.get("content-disposition") ?? "";
  const type = r.headers.get("content-type") ?? "";
  if (r.status !== 200 || !r.body) return { status: r.status, disposition, type, sha256: "", bytes: 0 };
  const file = path.join(WORK, name);
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(Readable.fromWeb(r.body as unknown as WebReadableStream<Uint8Array>), async function* (source) {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      hash.update(chunk);
      bytes += chunk.length;
      yield chunk;
    }
  }, createWriteStream(file));
  return { status: r.status, disposition, type, sha256: `sha256:${hash.digest("hex")}`, bytes };
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F14", "F15", "F18", "F20", "F21", "F23"]));

  // The two real videos in R2 (read only): their qa.json gives the MP4's SHA-256, size and length.
  const sources: { renderId: ObjectId; mp4Key: string; thumbnailKey: string; mp4Sha256: string; bytes: number; durationMs: number }[] = [];
  for (const s of SOURCE_RENDERS) {
    const key = (name: string) => {
      const k = `${s.folder}/${name}`;
      if (!isStorageKey(k)) throw new Error(`not a storage key: ${name}`);
      return k;
    };
    const qaBytes = await files.get(key("qa.json"));
    const head = await files.head(key("output.mp4"));
    const qa = qaBytes ? (JSON.parse(Buffer.from(qaBytes).toString("utf8")) as Json) : null;
    const sha = typeof qa?.sha256 === "string" ? (qa.sha256.startsWith("sha256:") ? qa.sha256 : `sha256:${qa.sha256}`) : "";
    check(`R2 source video ${s.renderId}: qa.json and output.mp4 exist, same SHA-256 on the object`, qa !== null && head !== null && /^sha256:[0-9a-f]{64}$/.test(sha) && head.sha256 === sha);
    // A fresh document id each run (re-runs never clash); the file keys stay those of the R2 folder.
    sources.push({ renderId: new ObjectId(), mp4Key: key("output.mp4"), thumbnailKey: key("thumbnail.jpg"), mp4Sha256: sha, bytes: Number(qa?.bytes ?? head?.bytes ?? 0), durationMs: Math.round(Number(qa?.measured?.durationSeconds ?? 0) * 1000) });
  }

  const a = await signUp("a");
  const b = await signUp("b");

  // Seed: one project of user A with two ready videos (version 1 from the older storyboard version).
  const now = new Date();
  const projectId = new ObjectId();
  const [planV1, planV2] = [new ObjectId(), new ObjectId()];
  const project: ProjectDocument = {
    _id: projectId,
    ownerId: a.id,
    schemaVersion: 1,
    title: TITLE,
    language: "en",
    voiceGender: "female",
    input: { type: "topic", text: "Why is the sky blue?", brainstormChoice: null },
    state: "video_ready",
    currentPlanVersionId: planV2,
    approvedPlanVersionId: planV2,
    currentRenderId: sources[1]!.renderId,
    activeJobId: null,
    stateVersion: 7,
    planRequestCount: 1,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  await db.collection<ProjectDocument>("projects").insertOne(project);
  const renderDoc = (i: number, overrides: Partial<RenderDocument> = {}): RenderDocument => {
    const s = sources[i]!;
    const folder = s.mp4Key.slice(0, -"/output.mp4".length);
    return {
      _id: s.renderId,
      ownerId: a.id,
      projectId,
      schemaVersion: 1,
      planVersionId: i === 0 ? planV1 : planV2,
      planHash: `sha256:${(i === 0 ? "1" : "2").repeat(64)}`,
      renderNumber: i + 1,
      speech: [],
      captionOverrideSetId: null,
      timelineKey: `${folder}/timeline.json`,
      captionsKey: `${folder}/captions.json`,
      mp4Key: s.mp4Key,
      thumbnailKey: s.thumbnailKey,
      qaKey: `${folder}/qa.json`,
      previewFrameKeys: [],
      renderInputHash: `sha256:${"c".repeat(64)}`,
      mp4Sha256: s.mp4Sha256,
      qa: {},
      status: "ready",
      metrics: { renderMs: 180000, bundleMs: 9000, bytes: s.bytes, durationMs: s.durationMs, frames: 0 },
      error: null,
      createdAt: new Date(now.getTime() - (2 - i) * 60_000),
      readyAt: new Date(now.getTime() - (2 - i) * 60_000 + 30_000),
      ...overrides,
    };
  };
  await db.collection<RenderDocument>("renders").insertMany([renderDoc(0), renderDoc(1)]);
  const P = `/api/v1/projects/${projectId.toHexString()}`;
  const [v1, v2] = [sources[0]!.renderId.toHexString(), sources[1]!.renderId.toHexString()];

  // F1: both versions, newest first, the project's video marked; thumbnail links open a JPEG.
  const list = await send(a.cookie, `${P}/renders`);
  const items = (list.json.items ?? []) as Json[];
  check("F1 lists both videos, newest first", list.status === 200 && items.map((i) => i.renderNumber).join() === "2,1" && items[0]?.id === v2 && items[1]?.id === v1, `${list.status} ${items.map((i) => i.renderNumber).join()}`);
  check("F1: isCurrent only on the project's video; nextCursor null", items[0]?.isCurrent === true && items[1]?.isCurrent === false && list.json.nextCursor === null);
  check("F1: the summary carries the real SHA-256 and 1080×1920 at 30 fps", items[0]?.mp4Sha256 === sources[1]!.mp4Sha256 && items[0]?.width === 1080 && items[0]?.height === 1920 && items[0]?.fps === 30);
  check("F1: Cache-Control no-store and a request id", list.headers.get("cache-control") === "no-store" && /^req_/.test(list.headers.get("x-request-id") ?? ""));
  const thumb = typeof items[1]?.thumbnailUrl === "string" ? await fetch(items[1].thumbnailUrl) : null;
  check("F1: version 1's thumbnail link opens a JPEG", thumb?.status === 200 && (thumb.headers.get("content-type") ?? "").startsWith("image/jpeg"));
  const paged = await send(a.cookie, `${P}/renders?limit=1`);
  const page2 = typeof paged.json.nextCursor === "string" ? await send(a.cookie, `${P}/renders?limit=1&cursor=${encodeURIComponent(paged.json.nextCursor)}`) : null;
  check("F1 pages: limit=1 → version 2, then the cursor → version 1 (last page)", paged.json.items?.[0]?.renderNumber === 2 && page2?.json.items?.[0]?.renderNumber === 1 && page2?.json.nextCursor === null);

  // F3 video: a link that streams (an HTTP Range request answers 206 with MP4 bytes).
  const video = await send(a.cookie, `${P}/renders/current/media?kind=video`);
  const expiresIn = Date.parse(video.json.expiresAt ?? "") - Date.now();
  check("F3 kind=video (current): 200 with a link valid about 15 minutes", video.status === 200 && video.json.kind === "video" && typeof video.json.url === "string" && expiresIn > 13 * 60_000 && expiresIn <= 15 * 60_000 + 5000, `${video.status}`);
  const ranged = typeof video.json.url === "string" ? await fetch(video.json.url, { headers: { Range: "bytes=0-65535" } }) : null;
  const rangeBody = ranged ? Buffer.from(await ranged.arrayBuffer()) : Buffer.alloc(0);
  check("F3 video link streams: Range request → 206, video/mp4, the first 64 KB", ranged?.status === 206 && (ranged.headers.get("content-type") ?? "").startsWith("video/mp4") && rangeBody.length === 65536 && rangeBody.subarray(4, 8).toString("latin1") === "ftyp", `${ranged?.status}`);
  check("F3 video link plays inline (no attachment)", !(ranged?.headers.get("content-disposition") ?? "").includes("attachment"));

  // F3 download (redirect, like the Download MP4 button): an attachment with the title's name and the exact bytes.
  const dl2 = await fetch(`${base}${P}/renders/${v2}/media?kind=download&redirect=true`, { redirect: "manual", headers: { cookie: a.cookie } });
  const location2 = dl2.headers.get("location") ?? "";
  check("F3 download redirect=true → 302 to the private link, no-store", dl2.status === 302 && location2.startsWith("https://") && dl2.headers.get("cache-control") === "no-store", `${dl2.status}`);
  const got2 = location2 ? await downloadTo(location2, "download-version-2.mp4") : null;
  check("F3 download is an attachment named after the cleaned title", got2?.status === 200 && (got2.disposition.startsWith("attachment;") && got2.disposition.includes(`filename="${EXPECTED_NAME}"`)), got2?.disposition ?? "");
  check("F3 download: SHA-256 of the downloaded bytes equals renders.mp4Sha256 (version 2)", got2?.sha256 === sources[1]!.mp4Sha256, `${got2?.bytes ?? 0} bytes`);

  // Version 1 (an earlier video) is still downloadable, byte for byte.
  const dl1 = await send(a.cookie, `${P}/renders/${v1}/media?kind=download`);
  const got1 = typeof dl1.json.url === "string" ? await downloadTo(dl1.json.url, "download-version-1.mp4") : null;
  check("version 1 is still downloadable: SHA-256 equals its mp4Sha256", dl1.status === 200 && got1?.sha256 === sources[0]!.mp4Sha256, `${got1?.bytes ?? 0} bytes`);
  const t1 = await send(a.cookie, `${P}/renders/${v1}/media?kind=thumbnail`);
  check("F3 kind=thumbnail: 200 with a link", t1.status === 200 && t1.json.kind === "thumbnail" && typeof t1.json.url === "string");
  const badKind = await send(a.cookie, `${P}/renders/current/media?kind=mp4`);
  check("F3 without a valid kind → 400 INVALID_INPUT", badKind.status === 400 && badKind.json.error?.code === "INVALID_INPUT");

  // Another user: 404 everywhere, never a link.
  const bList = await send(b.cookie, `${P}/renders`);
  const bVideo = await send(b.cookie, `${P}/renders/${v2}/media?kind=video`);
  const bDl = await fetch(`${base}${P}/renders/current/media?kind=download&redirect=true`, { redirect: "manual", headers: { cookie: b.cookie } });
  check("another user gets 404 (F1, F3, F3 redirect) and no link", bList.status === 404 && bVideo.status === 404 && bDl.status === 404 && !bDl.headers.get("location") && bVideo.json.url === undefined);
  const bPage = await page(b.cookie, `/projects/${projectId.toHexString()}/video`);
  check("another user: the review page is 404", bPage.status === 404, `${bPage.status}`);
  const anon = await send("", `${P}/renders`);
  check("no session → 401", anon.status === 401);

  // A video that isn't ready: 409 INVALID_STATE, no link.
  const pending = renderDoc(1, { _id: new ObjectId(), renderNumber: 3, status: "rendering", readyAt: null });
  await db.collection<RenderDocument>("renders").insertOne(pending);
  const notReady = await send(a.cookie, `${P}/renders/${pending._id.toHexString()}/media?kind=download`);
  check("a render that isn't ready → 409 INVALID_STATE (renderStatus rendering), no link", notReady.status === 409 && notReady.json.error?.code === "INVALID_STATE" && notReady.json.error?.details?.renderStatus === "rendering" && notReady.json.url === undefined, `${notReady.status}`);
  await db.collection<RenderDocument>("renders").deleteOne({ _id: pending._id });

  // The review page: the player and the Download link; the picker; publish not offered yet.
  const view = await page(a.cookie, `/projects/${projectId.toHexString()}/video`);
  check("review page: 200 with the player (<video controls playsInline>)", view.status === 200 && /<video[^>]*data-testid="video-player"/.test(view.html) && /<video[^>]*controls/.test(view.html) && /<video[^>]*playsinline/i.test(view.html), `${view.status}`);
  check("review page: Download MP4 links to F3 kind=download&redirect=true for the shown video", view.html.includes("Download MP4") && view.html.includes(`href="${P}/renders/${v2}/media?kind=download&amp;redirect=true"`));
  check("review page: 'Video ready', 'Video version 2', 'Publish — coming soon', Back to My videos, Edit storyboard", ["Video ready", "Video version 2", "Publish — coming soon", "Back to My videos", "Edit storyboard"].every((t) => view.html.includes(t)));
  check("review page: no Captions tab or Ask for changes; no older-storyboard note for the current video", !view.html.includes("Ask for changes") && !view.html.includes("Made from an older version"));
  check("review page: the old 'next update' text is gone", !view.html.includes("Watching and downloading"));

  const dashboard = await page(a.cookie, "/dashboard?tab=ready");
  check("My videos (Ready tab): the ready card opens this screen (/video)", dashboard.status === 200 && dashboard.html.includes(`href="/projects/${projectId.toHexString()}/video"`), `${dashboard.status}`);
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error("E2E crashed:", error instanceof Error ? error.message : error);
  })
  .finally(async () => {
    await closeMongoClient();
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
