import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { addInvite, APP_USAGE_OWNER_ID, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, readDbConfig, usageCounterPeriod } from "@bytereel/db";
import { isStorageKey, R2ArtifactStore, readR2Config } from "@bytereel/storage";
import { ObjectId } from "mongodb";

/**
 * F23 end-to-end check over real HTTP: Approve & generate video → narration (the STAND-IN voice,
 * E2E_FAKE_ELEVENLABS=1: ZERO ElevenLabs calls) → timing + captions → a REAL local render → MP4
 * checks → thumbnail → a REAL upload to the dev R2 bucket under the test user's ids → video_ready.
 * Also: the one-at-a-time queue ("Waiting to start…"), Cancel (waiting and while rendering), a
 * failure + Try again, cached narration reused, the limits in order (language → videos/day → voice
 * characters → the app-wide guard), the older video kept after an edit, owner-only access.
 * Code review fixes: every ElevenLabs request counted before it is sent (`voice.sentKeys`) and logged in
 * providerUsage; ready recordings keep no audio bytes; "Edit storyboard" from a failed or ready video
 * (the storyboard opens, with "Back to video").
 * The storyboard comes from the local Gemini stand-in (E2E_FAKE_GEMINI=1: ZERO Gemini calls).
 * Two full renders (about 3 min each on the dev machine) and one cancelled one: allow ~15 minutes.
 *
 * TEMP FILES: never in /tmp. In every terminal used below, first run from the repo root:
 *   mkdir -p runs/.tmp && export TMPDIR="$PWD/runs/.tmp"
 * SAFETY: only the separate test database `bytereel_test`, ports 3230–3239 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. (in runs/f23-work/inngest) npx --yes inngest-cli@1.49.0 dev --no-discovery -u http://localhost:3238/api/inngest --port 8299 \
 *        --connect-gateway-port 8298 --connect-gateway-grpc-port 50062 --connect-executor-grpc-port 50063
 *   3. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3238 E2E_FAKE_GEMINI=1 E2E_FAKE_ELEVENLABS=1 \
 *        INNGEST_DEV=http://localhost:8299 REMOTION_SERVE_PORT=3240 npx next start -p 3238
 *   4. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3238 E2E_FAKE_GEMINI=1 E2E_FAKE_ELEVENLABS=1 npx tsx tools/e2e/f23-generate.ts
 *   5. drop the bytereel_test database afterwards. The R2 files stay (listed at the end).
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has E2E_FAKE_GEMINI=1, E2E_FAKE_ELEVENLABS=1, MONGODB_DB=bytereel_test and
 * INNGEST_DEV on port 8299 and REMOTION_SERVE_PORT 3240–3249 (Remotion's render server; never 3000). Presigned links are never printed (they contain the token's key id).
 */

const TEST_DB = "bytereel_test";
process.loadEnvFile(".env");
const base = process.env.E2E_BASE_URL ?? "";
if (!/^http:\/\/localhost:323\d$/.test(base)) throw new Error("Set E2E_BASE_URL to http://localhost:3230–3239 (never port 3000).");
if (process.env.E2E_FAKE_GEMINI !== "1" || process.env.E2E_FAKE_ELEVENLABS !== "1") throw new Error("Run with E2E_FAKE_GEMINI=1 and E2E_FAKE_ELEVENLABS=1: this check must never call the real Gemini or ElevenLabs.");
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
if (!serverSettings(new URL(base).port)) throw new Error("Stopping before any request: the server must run with E2E_FAKE_GEMINI=1, E2E_FAKE_ELEVENLABS=1, MONGODB_DB=bytereel_test and INNGEST_DEV=http://localhost:8299 and REMOTION_SERVE_PORT=3240–3249 (the render's own server: never port 3000).");

const ROOT = process.cwd();
const tag = randomBytes(4).toString("hex");
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

type Json = Record<string, any>;
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const key = () => randomBytes(16).toString("hex");
const send = async (cookie: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${url}`, {
    method,
    redirect: "manual",
    headers: { origin: base, cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, headers: r.headers, json: (await r.json().catch(() => ({}))) as Json };
};
const page = async (cookie: string, url: string) => {
  const r = await fetch(`${base}${url}`, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location") ?? "", html: (await r.text()).replace(/<!-- -->/g, "") };
};
const oid = (id: string) => new ObjectId(id);
const projectOf = (id: string) => db.collection("projects").findOne({ _id: oid(id) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll C6 until `done` says so (or the time is up); collects every progress message seen. */
async function waitFor(cookie: string, projectId: string, done: (s: Json) => boolean, timeoutMs: number, seen?: Set<string>): Promise<Json> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await send(cookie, "GET", `/api/v1/projects/${projectId}/status`);
    const message = r.json.activeJob?.progress?.message;
    if (seen && typeof message === "string") seen.add(message);
    if (done(r.json) || Date.now() > end) return r.json;
    await sleep(700);
  }
}

async function signUp(label: string): Promise<{ cookie: string; id: ObjectId }> {
  const email = `f23-e2e-${label}-${tag}@example.com`;
  await addInvite(db, email, { note: "F23 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `F23 Tester ${label}`, email, password: `E2e-${randomBytes(9).toString("base64url")}` }),
  });
  check(`test account ${label} created`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId };
}

async function newStoryboard(cookie: string, text: string): Promise<string> {
  const r = await send(cookie, "POST", "/api/v1/projects", { inputType: "topic", text, language: "en", voiceGender: "female" }, { "idempotency-key": key() });
  const id = r.json.project?.id as string;
  const done = await waitFor(cookie, id, (s) => s.pollAfterMs === null && s.state !== "planning", 90_000);
  check(`storyboard made for "${text}"`, done.state === "storyboard_ready", done.state);
  return id;
}

async function current(cookie: string, projectId: string) {
  const [p, v] = await Promise.all([send(cookie, "GET", `/api/v1/projects/${projectId}`), send(cookie, "GET", `/api/v1/projects/${projectId}/plan-versions/current`)]);
  return { project: p.json, version: v.json };
}

async function approve(cookie: string, projectId: string, idemKey = key()) {
  const { project, version } = await current(cookie, projectId);
  const body = { planVersionId: version.id, planHash: version.planHash, expectedStateVersion: project.stateVersion };
  return { ...(await send(cookie, "POST", `/api/v1/projects/${projectId}/storyboard-approval`, body, { "idempotency-key": idemKey })), body };
}

async function counter(ownerId: ObjectId | string, kind: string, timezone: string): Promise<number> {
  const { period } = usageCounterPeriod(kind as "videos", timezone);
  const doc = await db.collection("usageCounters").findOne({ ownerId: typeof ownerId === "string" ? oid(ownerId) : ownerId, kind, period });
  return (doc?.count as number | undefined) ?? 0;
}
async function setCounter(ownerId: ObjectId | string, kind: string, timezone: string, count: number) {
  const { period, expiresAt } = usageCounterPeriod(kind as "videos", timezone);
  await db.collection("usageCounters").updateOne({ ownerId: typeof ownerId === "string" ? oid(ownerId) : ownerId, kind, period }, { $set: { count }, $setOnInsert: { expiresAt } }, { upsert: true });
}

const uploaded: string[] = [];
async function verifyInR2(label: string, keys: string[], shaOf: Record<string, string> = {}) {
  let ok = true;
  for (const k of keys) {
    if (!isStorageKey(k)) {
      ok = false;
      continue;
    }
    const head = await files.head(k);
    if (!head || head.bytes === 0 || (shaOf[k] && head.sha256 !== shaOf[k])) ok = false;
    else if (!uploaded.includes(k)) uploaded.push(k);
  }
  check(label, ok, `${keys.length} file(s)`);
}

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F14", "F15", "F18", "F20", "F21", "F23"]));
  const names = async (c: string) => (await db.collection(c).indexes()).map((i) => i.name);
  check("F23 indexes created on the test database", (await names("speechArtifacts")).includes("ownerId_cacheKey_unique") && (await names("renders")).includes("projectId_renderNumber_unique"));
  await db.collection("rateLimits").deleteMany({});
  const a = await signUp("a");
  const b = await signUp("b");
  const tz = "Asia/Kolkata";
  const appBefore = await counter(APP_USAGE_OWNER_ID, "appVoiceChars", "UTC");

  // ---------- language switch: refused before anything is counted ----------
  const hiPid = await newStoryboard(a.cookie, "How do rainbows form?");
  await db.collection("projects").updateOne({ _id: oid(hiPid) }, { $set: { language: "hi" } });
  let r: Awaited<ReturnType<typeof send>> & { body?: unknown } = await approve(a.cookie, hiPid);
  check("D8 on a Hindi project → 422 LANGUAGE_UNAVAILABLE; no approval, no job, nothing counted", r.status === 422 && r.json.error?.code === "LANGUAGE_UNAVAILABLE" && (await db.collection("jobs").countDocuments({ projectId: oid(hiPid), type: "generate" })) === 0 && (await db.collection("storyboardApprovals").countDocuments({ projectId: oid(hiPid) })) === 0 && (await counter(a.id, "videos", tz)) === 0, `${r.status} ${r.json.error?.code}`);
  check("Hindi project: no approve/generate buttons", !(await current(a.cookie, hiPid)).project.allowedActions.some((x: string) => x === "approve_storyboard" || x === "generate_video"));

  // ---------- P1: approve & generate → the full pipeline ----------
  const p1 = await newStoryboard(a.cookie, "How does the water cycle work?");
  const p2 = await newStoryboard(a.cookie, "Why does it rain?");
  let view = await page(a.cookie, `/projects/${p1}/storyboard`);
  check("storyboard button reads 'Approve & generate video'", view.html.includes("Approve &amp; generate video"));
  const p1Key = key();
  r = await approve(a.cookie, p1, p1Key);
  const p1Job = r.json.job?.id as string;
  check("D8 → 202 { approval, job (generate, queued, gen:{version}), project (generating, cancel_job) }", r.status === 202 && r.json.job?.type === "generate" && r.json.job?.state === "queued" && r.json.project?.state === "generating" && r.json.project?.allowedActions?.join() === "cancel_job" && r.json.approval?.planVersionId === r.json.project?.approvedPlanVersionId, `status ${r.status}`);
  check("the job key is gen:{planVersionId}; videos today = 1", (await db.collection("jobs").findOne({ _id: oid(p1Job) }))?.idempotencyKey === `gen:${r.json.approval?.planVersionId}` && (await counter(a.id, "videos", tz)) === 1);
  // The same click again (same key, same body): the first answer comes back, no second job.
  const replay = await send(a.cookie, "POST", `/api/v1/projects/${p1}/storyboard-approval`, r.body, { "idempotency-key": p1Key });
  check("D8 repeated with the same key → replayed, one job", replay.headers.get("idempotent-replayed") === "true" && (await db.collection("jobs").countDocuments({ projectId: oid(p1), type: "generate" })) === 1);

  // P2 right behind it: waits for its turn ("Waiting to start…"), then is cancelled while waiting.
  r = await approve(a.cookie, p2);
  const p2Job = r.json.job?.id as string;
  let st = await waitFor(a.cookie, p2, (s) => typeof s.activeJob?.queue?.ahead === "number" && s.activeJob.queue.ahead >= 1, 20_000);
  check("a second video waits for its turn: queued, with videos ahead (one render at a time)", st.activeJob?.state === "queued" && st.activeJob?.queue?.ahead >= 1, JSON.stringify(st.activeJob?.queue));
  const cards = await send(a.cookie, "GET", "/api/v1/projects?tab=drafts");
  check("its card says it is waiting (activeJobState queued)", cards.json.items?.find((i: Json) => i.id === p2)?.activeJobState === "queued");
  r = await send(a.cookie, "POST", `/api/v1/jobs/${p2Job}/cancel`, {});
  check("E3 Cancel while waiting → cancelled at once; back to the storyboard, approval kept, Generate video offered", r.status === 202 && r.json.state === "cancelled" && (await projectOf(p2))?.state === "storyboard_ready" && (await current(a.cookie, p2)).project.allowedActions.includes("generate_video"), `${r.status} ${r.json.state}`);
  r = await send(a.cookie, "POST", `/api/v1/jobs/${p2Job}/cancel`, {});
  check("E3 again on a finished job → 409 INVALID_STATE", r.status === 409 && r.json.error?.code === "INVALID_STATE");

  const seen = new Set<string>();
  const started = Date.now();
  st = await waitFor(a.cookie, p1, (s) => s.pollAfterMs === null, 12 * 60_000, seen);
  console.log(`      (P1 took ${((Date.now() - started) / 1000).toFixed(0)} s; progress seen: ${[...seen].filter((m) => !/Rendering · \d/.test(m) || /0%$/.test(m)).join(" | ")})`);
  check("P1 video ready", st.state === "video_ready" && typeof st.currentRenderId === "string", `${st.state} ${JSON.stringify(st.lastError)}`);
  check("progress went through Recording narration → … → Rendering · N%", [...seen].some((m) => /^Recording narration · scene 1 of \d+$/.test(m)) && [...seen].some((m) => /^Rendering · \d+%$/.test(m)));
  const job1 = await db.collection("jobs").findOne({ _id: oid(p1Job) });
  check("job succeeded, every stage succeeded, result.renderId", job1?.state === "succeeded" && job1.stages.every((s: Json) => s.status === "succeeded") && job1.result?.renderId?.toHexString() === st.currentRenderId);
  const render1 = await db.collection("renders").findOne({ _id: oid(st.currentRenderId) });
  check("renders: ready, video 1, mp4Sha256, qa ok, keys under the test user", render1?.status === "ready" && render1.renderNumber === 1 && /^sha256:[0-9a-f]{64}$/.test(render1.mp4Sha256) && render1.qa?.ok === true && String(render1.mp4Key).startsWith(`users/${a.id.toHexString()}/projects/${p1}/renders/${st.currentRenderId}/`));
  await verifyInR2("R2: output.mp4 (same SHA-256 as renders.mp4Sha256), thumbnail.jpg, timeline/captions/qa", [render1!.mp4Key, render1!.thumbnailKey, render1!.timelineKey, render1!.captionsKey, render1!.qaKey], { [render1!.mp4Key]: render1!.mp4Sha256 });
  const timeline = JSON.parse(Buffer.from((await files.get(render1!.timelineKey))!).toString("utf8"));
  check("timeline v2 in R2 (60–90 s)", timeline.schemaVersion === 2 && timeline.totalFrames >= 1800 && timeline.totalFrames <= 2700, `${timeline.totalFrames} frames`);
  const speech = await db.collection("speechArtifacts").find({ ownerId: a.id }).toArray();
  check("speechArtifacts: one ready recording per scene, paid by this job, no pending lock left, no audio bytes kept", speech.length === render1!.speech.length && speech.every((s) => s.status === "ready" && s.claim === null && s.response === null && !("audio" in s) && s.paidByJobId?.toHexString() === p1Job));
  const usage1 = await db.collection("providerUsage").find({ jobId: oid(p1Job), provider: "elevenlabs" }).toArray();
  check("providerUsage: one ElevenLabs row per request (final ok, characters logged, cost 0)", usage1.length === speech.length && usage1.every((u) => u.status === "final" && u.outcome === "ok" && u.operation === "tts_with_timestamps" && u.units?.characters > 0 && u.estCostInr === 0), `${usage1.length} rows`);
  check("job.voice: every request counted before it was sent (sentKeys), no unused reservation left, its month noted", job1?.voice?.sentKeys?.length === speech.length && job1.voice.cacheKeys.length === 0 && typeof job1.voice.period?.user === "string" && typeof job1.voice.period?.app === "string");
  await verifyInR2("R2: narration audio + both timing files per recording (SHA-256 checked)", speech.flatMap((s) => [s.audioKey, s.alignmentKey, s.normalizedAlignmentKey]), Object.fromEntries(speech.map((s) => [s.audioKey, s.audioSha256])));
  const chars1 = speech.reduce((sum, s) => sum + (s.characters as number), 0);
  check("voice characters counted for the creator AND the app (once per recording)", (await counter(a.id, "voiceChars", tz)) === chars1 && (await counter(APP_USAGE_OWNER_ID, "appVoiceChars", "UTC")) === appBefore + chars1, `${chars1} characters`);
  const card = (await send(a.cookie, "GET", "/api/v1/projects?tab=ready")).json.items?.find((i: Json) => i.id === p1);
  check("C1 card: video ready with a thumbnail link, not an older version", card?.state === "video_ready" && typeof card.thumbnailUrl === "string" && card.videoFromOlderVersion === false);
  const thumb = card?.thumbnailUrl ? await fetch(card.thumbnailUrl) : null;
  check("the thumbnail link opens a JPEG", thumb?.status === 200 && (thumb.headers.get("content-type") ?? "").startsWith("image/jpeg"));
  const redirected = await page(a.cookie, `/projects/${p1}`);
  check("/projects/[id] sends the video step to /video", (redirected.status >= 300 && redirected.status < 400 && redirected.location.endsWith(`/projects/${p1}/video`)) || redirected.html.includes(`/projects/${p1}/video`), `${redirected.status}`);
  view = await page(a.cookie, `/projects/${p1}/video`);
  check("video page (ready): the player and Download MP4 (F24)", view.status === 200 && view.html.includes('data-testid="video-player"') && view.html.includes("Download MP4"));
  check("video page (ready): 'Edit storyboard' opens the storyboard", view.html.includes("Edit storyboard") && view.html.includes(`href="/projects/${p1}/storyboard"`));
  const readyBoard = await page(a.cookie, `/projects/${p1}/storyboard`);
  check("…and the storyboard of a ready video opens (no redirect) with 'Back to video'", readyBoard.status === 200 && readyBoard.html.includes("Back to video") && readyBoard.html.includes("Approved · Version"), `${readyBoard.status} ${readyBoard.location}`);
  check("the job's work folder was removed", !existsSync(path.join(ROOT, "runs", ".tmp", "generate", st.currentRenderId)));

  // ---------- decision 5: an edit keeps the older video until a new one is made ----------
  let { project, version } = await current(a.cookie, p1);
  const approvedId = version.id;
  const scene0 = version.plan.scenes[0];
  r = await send(a.cookie, "POST", `/api/v1/projects/${p1}/narration-edits`, { basePlanVersionId: version.id, sceneId: scene0.id, blocks: [{ narrationId: scene0.narration[0].id, text: `${scene0.narration[0].text} Really.` }], expectedStateVersion: project.stateVersion });
  const afterEdit = await projectOf(p1);
  check("D3 after the video: storyboard_ready, approval cleared, currentRenderId KEPT", r.status === 201 && afterEdit?.state === "storyboard_ready" && afterEdit.approvedPlanVersionId === null && afterEdit.currentRenderId?.toHexString() === st.currentRenderId);
  const older = (await send(a.cookie, "GET", "/api/v1/projects?tab=drafts")).json.items?.find((i: Json) => i.id === p1);
  check("C1 card: the old thumbnail with the 'older version' flag", typeof older?.thumbnailUrl === "string" && older.videoFromOlderVersion === true);
  check("storyboard page notes the earlier video", (await page(a.cookie, `/projects/${p1}/storyboard`)).html.includes("Your earlier video (made from an older version)"));
  ({ project } = await current(a.cookie, p1));
  r = await send(a.cookie, "POST", `/api/v1/projects/${p1}/plan-versions/${approvedId}/restore`, { expectedStateVersion: project.stateVersion });
  check("D7 undo back to the approved version → its approval counts again, the video is still there", r.status === 200 && r.json.approvedPlanVersionId === approvedId && r.json.currentRenderId === st.currentRenderId && r.json.allowedActions?.includes("generate_video"));
  const videosBefore = await counter(a.id, "videos", tz);
  r = await approve(a.cookie, p1);
  check("Generate video on a version that already has a video → 200, video_ready again, no new job, nothing counted", r.status === 200 && r.json.project?.state === "video_ready" && r.json.project?.currentRenderId === st.currentRenderId && r.json.job?.id === p1Job && (await counter(a.id, "videos", tz)) === videosBefore && (await db.collection("jobs").countDocuments({ projectId: oid(p1), type: "generate" })) === 1);

  // ---------- P2: a failure, Try again, Cancel while rendering, then cached narration reused ----------
  ({ project, version } = await current(a.cookie, p2));
  const busyScene = version.plan.scenes[2];
  const busyText = `${busyScene.narration[0].text} e2e voice busy ${tag}.`;
  r = await send(a.cookie, "POST", `/api/v1/projects/${p2}/narration-edits`, { basePlanVersionId: version.id, sceneId: busyScene.id, blocks: [{ narrationId: busyScene.narration[0].id, text: busyText }], expectedStateVersion: project.stateVersion });
  check("P2: edit one scene (the stand-in voice will be busy for it)", r.status === 201);
  const userBefore = await counter(a.id, "voiceChars", tz);
  r = await approve(a.cookie, p2);
  const p2Job2 = r.json.job?.id as string;
  check("approve the new version → a new job (videos today + 1)", r.status === 202 && p2Job2 !== p2Job && (await counter(a.id, "videos", tz)) === videosBefore + 1);
  st = await waitFor(a.cookie, p2, (s) => s.pollAfterMs === null, 3 * 60_000);
  const failedJob = await db.collection("jobs").findOne({ _id: oid(p2Job2) });
  check("busy voice → generate_failed, PROVIDER_BUSY (retryable), Try again offered", st.state === "generate_failed" && failedJob?.error?.code === "PROVIDER_BUSY" && failedJob.error.retryable === true && st.allowedActions?.includes("retry_job"), `${st.state} ${failedJob?.error?.code}`);
  const edited = await db.collection("speechArtifacts").find({ ownerId: a.id, sceneId: busyScene.id, status: "failed" }).toArray();
  const editedChars = (edited[0]?.characters as number | undefined) ?? 0;
  check("only the changed scene needed new narration (the others reused for free); its 3 attempts were counted", edited.length === 1 && (await counter(a.id, "voiceChars", tz)) === userBefore + 3 * editedChars, `${editedChars} chars × 3`);
  view = await page(a.cookie, `/projects/${p2}/video`);
  check("video page shows the plain error and Try again", view.html.includes("Voice service busy. Please try again in a few minutes.") && view.html.includes("Try again"));
  check("video page (failed): 'Edit storyboard' is offered", view.html.includes("Edit storyboard") && view.html.includes(`href="/projects/${p2}/storyboard"`));
  const failedBoard = await page(a.cookie, `/projects/${p2}/storyboard`);
  check("…and the storyboard of a failed video opens (no redirect) with 'Back to video', still editable", failedBoard.status === 200 && failedBoard.html.includes("Back to video") && (await current(a.cookie, p2)).project.allowedActions.includes("edit_storyboard"), `${failedBoard.status} ${failedBoard.location}`);
  const usage2 = await db.collection("providerUsage").find({ jobId: oid(p2Job2), provider: "elevenlabs" }).toArray();
  check("providerUsage: the 3 busy requests are logged as failed (busy), none left reserved", usage2.length === 3 && usage2.every((u) => u.status === "failed" && u.outcome === "busy"), `${usage2.length} rows`);
  check("the failed recording's lock was released (failed, no claim)", edited[0]?.claim === null);
  r = await send(a.cookie, "POST", `/api/v1/jobs/${p2Job2}/retry`, {}, { "idempotency-key": key() });
  check("E2 Try again → 202, same job, attempt 2, generating", r.status === 202 && r.json.id === p2Job2 && r.json.attempt === 2 && (await projectOf(p2))?.state === "generating", `${r.status} ${JSON.stringify(r.json.error ?? null)}`);
  st = await waitFor(a.cookie, p2, (s) => s.activeJob?.progress?.stage === "render" || s.pollAfterMs === null, 6 * 60_000);
  check("…the voice works now and the render starts", st.activeJob?.progress?.stage === "render", `${st.state} ${st.activeJob?.progress?.message}`);
  const renderingId = (await db.collection("jobs").findOne({ _id: oid(p2Job2) }))?.render?.renderId?.toHexString() as string;
  r = await send(a.cookie, "POST", `/api/v1/jobs/${p2Job2}/cancel`, {});
  check("E3 Cancel while rendering → 202, cancel requested", r.status === 202 && r.json.cancelRequestedAt !== null);
  const cancelledAt = Date.now();
  st = await waitFor(a.cookie, p2, (s) => s.pollAfterMs === null, 60_000);
  const cancelledJob = await db.collection("jobs").findOne({ _id: oid(p2Job2) });
  check("…the render stops within seconds; job cancelled; back to the storyboard", cancelledJob?.state === "cancelled" && st.state === "storyboard_ready", `${((Date.now() - cancelledAt) / 1000).toFixed(1)} s`);
  await sleep(1500);
  check("no video saved for the cancelled render; its work folder is gone", (await db.collection("renders").countDocuments({ _id: oid(renderingId) })) === 0 && !existsSync(path.join(ROOT, "runs", ".tmp", "generate", renderingId)));
  const charsAfterCancel = await counter(a.id, "voiceChars", tz);
  check("characters spent stay counted (no refund, no extra)", charsAfterCancel === userBefore + 4 * editedChars || charsAfterCancel === userBefore + 3 * editedChars, `${charsAfterCancel - userBefore}`);
  r = await approve(a.cookie, p2);
  check("Generate video again → the same job, attempt 3", r.status === 202 && r.json.job?.id === p2Job2 && r.json.job?.attempt === 3);
  st = await waitFor(a.cookie, p2, (s) => s.pollAfterMs === null, 12 * 60_000);
  check("P2 video ready, all narration reused (no new characters)", st.state === "video_ready" && (await counter(a.id, "voiceChars", tz)) === charsAfterCancel, `${st.state} ${JSON.stringify(st.lastError)}`);
  const render2 = await db.collection("renders").findOne({ _id: oid(st.currentRenderId) });
  await verifyInR2("R2: P2's video files", [render2!.mp4Key, render2!.thumbnailKey, render2!.timelineKey, render2!.captionsKey, render2!.qaKey], { [render2!.mp4Key]: render2!.mp4Sha256 });
  check("each render attempt had its own renderId (the cancelled one wrote no video)", render2!._id.toHexString() !== renderingId);
  const editedReady = await db.collection("speechArtifacts").findOne({ ownerId: a.id, sceneId: busyScene.id, status: "ready", paidByJobId: oid(p2Job2) });
  await verifyInR2("R2: the edited scene's narration (recorded after Try again)", editedReady ? [editedReady.audioKey, editedReady.alignmentKey, editedReady.normalizedAlignmentKey] : ["missing"]);

  // ---------- the limits, in order ----------
  const p3 = await newStoryboard(a.cookie, "What is evaporation?");
  ({ project, version } = await current(a.cookie, p3));
  const s3 = version.plan.scenes[1];
  r = await send(a.cookie, "POST", `/api/v1/projects/${p3}/narration-edits`, { basePlanVersionId: version.id, sceneId: s3.id, blocks: [{ narrationId: s3.narration[0].id, text: `${s3.narration[0].text} New words ${tag}.` }], expectedStateVersion: project.stateVersion });
  const jobsBefore = await db.collection("jobs").countDocuments({ projectId: oid(p3), type: "generate" });
  await setCounter(a.id, "videos", tz, 3);
  r = await approve(a.cookie, p3);
  check("videos/day: 4th → 429 QUOTA_EXCEEDED videos_per_day; no job", r.status === 429 && r.json.error?.details?.quota === "videos_per_day" && (await db.collection("jobs").countDocuments({ projectId: oid(p3), type: "generate" })) === jobsBefore);
  await setCounter(a.id, "videos", tz, 0);
  await setCounter(a.id, "voiceChars", tz, 2990);
  r = await approve(a.cookie, p3);
  // F27: the message says needed vs left and the reset date (tools/e2e/f27-limits.ts checks the exact words).
  check("the creator's 3,000 voice characters → 429 (F27 wording: needed vs 10 left); videos/day not counted", r.status === 429 && /^This video needs about [\d,]+ voice characters, but you have 10 left this month\. The limit resets on \d+ \w+\.$/.test(r.json.error?.message ?? "") && r.json.error?.details?.quota === "voice_characters_per_month" && (await counter(a.id, "videos", tz)) === 0, `${r.status} ${r.json.error?.message}`);
  await setCounter(a.id, "voiceChars", tz, 0);
  const appNow = await counter(APP_USAGE_OWNER_ID, "appVoiceChars", "UTC");
  await setCounter(APP_USAGE_OWNER_ID, "appVoiceChars", "UTC", 8990);
  r = await approve(a.cookie, p3);
  check("the app-wide 9,000 a month → 503 SPEND_CEILING (F27 wording: paused for everyone)", r.status === 503 && r.json.error?.code === "SPEND_CEILING" && /^Video making is paused for everyone until \d+ \w+[ ,]/.test(r.json.error?.message ?? ""), `${r.status} ${r.json.error?.code}`);
  await setCounter(APP_USAGE_OWNER_ID, "appVoiceChars", "UTC", appNow);

  // ---------- owner only ----------
  const p1Status = await projectOf(p1);
  for (const [label, res] of [
    ["D8", await send(b.cookie, "POST", `/api/v1/projects/${p1}/storyboard-approval`, { planVersionId: approvedId, planHash: `sha256:${"0".repeat(64)}`, expectedStateVersion: p1Status?.stateVersion }, { "idempotency-key": key() })],
    ["E1", await send(b.cookie, "GET", `/api/v1/jobs/${p1Job}`)],
    ["E2", await send(b.cookie, "POST", `/api/v1/jobs/${p2Job2}/retry`, {}, { "idempotency-key": key() })],
    ["E3", await send(b.cookie, "POST", `/api/v1/jobs/${p1Job}/cancel`, {})],
  ] as const) check(`another user: ${label} → 404 NOT_FOUND`, res.status === 404, `status ${res.status}`);
  check("another user: video page → 404", (await page(b.cookie, `/projects/${p1}/video`)).status === 404);
  check("another user's My videos lists none of these", ((await send(b.cookie, "GET", "/api/v1/projects")).json.items ?? []).length === 0);
  check("signed out: E3 → 401", (await send("", "POST", `/api/v1/jobs/${p1Job}/cancel`, {})).status === 401);

  // ---------- nothing left behind in the project's temp folder ----------
  const leftovers = existsSync(path.join(ROOT, "runs", ".tmp", "generate")) ? readdirSync(path.join(ROOT, "runs", ".tmp", "generate")) : [];
  check("no render work folders left in runs/.tmp/generate", leftovers.length === 0, leftovers.join(", "));

  console.log("\nR2 files uploaded by this check (dev bucket, test user ids; kept):");
  for (const k of uploaded) console.log(`  ${k}`);
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error("E2E crashed:", error instanceof Error ? error.stack : error);
  })
  .finally(async () => {
    await closeMongoClient();
    console.log(failures === 0 ? "\nAll F23 checks passed." : `\n${failures} check(s) failed.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
