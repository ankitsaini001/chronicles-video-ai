import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { addInvite, APP_USAGE_OWNER_ID, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, readDbConfig, usageCounterPeriod } from "@bytereel/db";
import { isStorageKey, R2ArtifactStore, readR2Config } from "@bytereel/storage";
import { ObjectId } from "mongodb";

/**
 * F26 end-to-end check over real HTTP: make video 1 with the STAND-IN voice (E2E_FAKE_ELEVENLABS=1:
 * ZERO ElevenLabs calls) and the STAND-IN Gemini (E2E_FAKE_GEMINI=1: ZERO Gemini calls) → "Ask for
 * changes" on the video (D5 `stage: video`) → the storyboard shows the new version and the cost note →
 * approve (D8) → video 2, rendered for real on this computer and uploaded create-only to the dev R2
 * bucket under the test user's ids. It proves: video 2's captions have the new words; voice requests
 * and characters rise ONLY for the changed scene (providerUsage, the stand-in's own call log, the
 * usage counters); every other scene uses the SAME recording as video 1 (ids, keys, SHA-256); videos
 * today +1; video 1 is still listed and downloadable. Also: an unclear request ends with a reply and
 * no new version (the project stays video_ready with video 1); another user gets 404; while a change
 * runs a caption fix gets 409 JOB_ALREADY_RUNNING, the video still downloads and the page says the
 * captions wait; a failed change stays on the video page with Try again. Two full renders (about
 * 3 min each on the dev machine): allow ~10 minutes.
 *
 * The stand-in Gemini (apps/web/lib/brainstorm/fake-gemini.ts) answers a change request by adding
 * " Simple as that." to the first narration block of the requested scene; "e2e nochange" → no
 * change; "e2e busy" → 503 every time.
 *
 * TEMP FILES: never in /tmp. In every terminal used below, first run from the repo root:
 *   mkdir -p runs/.tmp && export TMPDIR="$PWD/runs/.tmp"
 * SAFETY: only the separate test database `bytereel_test`, ports 3230–3239 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. (in runs/f26-work/inngest) npx --yes inngest-cli@1.49.0 dev --no-discovery -u http://localhost:3236/api/inngest --port 8299 \
 *        --connect-gateway-port 8298 --connect-gateway-grpc-port 50062 --connect-executor-grpc-port 50063
 *   3. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3236 E2E_FAKE_GEMINI=1 E2E_FAKE_ELEVENLABS=1 \
 *        INNGEST_DEV=http://localhost:8299 npx next start -p 3236
 *   4. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3236 E2E_FAKE_GEMINI=1 E2E_FAKE_ELEVENLABS=1 npx tsx tools/e2e/f26-video-revision.ts
 *   5. drop the bytereel_test database afterwards. The R2 files stay (listed at the end).
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has E2E_FAKE_GEMINI=1, E2E_FAKE_ELEVENLABS=1, MONGODB_DB=bytereel_test and
 * INNGEST_DEV on port 8299. Presigned links are never printed (they contain the token's key id).
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
  return env.get("E2E_FAKE_GEMINI") === "1" && env.get("E2E_FAKE_ELEVENLABS") === "1" && env.get("MONGODB_DB") === TEST_DB && env.get("INNGEST_DEV") === "http://localhost:8299";
}
if (!serverSettings(new URL(base).port)) throw new Error("Stopping before any request: the server must run with E2E_FAKE_GEMINI=1, E2E_FAKE_ELEVENLABS=1, MONGODB_DB=bytereel_test and INNGEST_DEV=http://localhost:8299.");

const ROOT = process.cwd();
/** One line per stand-in voice call, written by the test server (apps/web/lib/video/fake-elevenlabs.ts). */
const STAND_IN_LOG = path.join(ROOT, "runs", ".tmp", "e2e", "elevenlabs-stand-in-calls.log");
const standInCalls = () => (existsSync(STAND_IN_LOG) ? readFileSync(STAND_IN_LOG, "utf8").split("\n").filter(Boolean).length : 0);
const tag = randomBytes(4).toString("hex");
let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  else passes++;
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
/** A page as HTML text with React's comment markers and the common entities decoded. */
const page = async (cookie: string, url: string) => {
  const r = await fetch(`${base}${url}`, { headers: { cookie }, redirect: "manual" });
  const html = (await r.text()).replace(/<!-- -->/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
  return { status: r.status, location: r.headers.get("location"), html };
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
    await sleep(500);
  }
}

async function signUp(label: string): Promise<{ cookie: string; id: ObjectId }> {
  const email = `f26-e2e-${label}-${tag}@example.com`;
  await addInvite(db, email, { note: "F26 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `F26 Tester ${label}`, email, password: `E2e-${randomBytes(9).toString("base64url")}` }),
  });
  check(`test account ${label} created`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId };
}

async function counter(ownerId: ObjectId | string, kind: string, timezone: string): Promise<number> {
  const { period } = usageCounterPeriod(kind as "videos", timezone);
  const doc = await db.collection("usageCounters").findOne({ ownerId: typeof ownerId === "string" ? oid(ownerId) : ownerId, kind, period });
  return (doc?.count as number | undefined) ?? 0;
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
const readJson = async (k: string) => JSON.parse(Buffer.from((await files.get(k as never))!).toString("utf8")) as Json;

/** Everything that moves when a voice request is made (or counted). */
async function voiceSnapshot(owner: ObjectId, tz: string) {
  return {
    providerUsage: await db.collection("providerUsage").countDocuments({ provider: "elevenlabs" }),
    standIn: standInCalls(),
    userChars: await counter(owner, "voiceChars", tz),
    appChars: await counter(APP_USAGE_OWNER_ID, "appVoiceChars", "UTC"),
    speechArtifacts: await db.collection("speechArtifacts").countDocuments({}),
    videosToday: await counter(owner, "videos", tz),
  };
}

/** Is video `renderId` still downloadable (F3 download link opens the MP4)? */
async function downloadable(cookie: string, projectId: string, renderId: string): Promise<{ ok: boolean; detail: string }> {
  const r = await send(cookie, "GET", `/api/v1/projects/${projectId}/renders/${renderId}/media?kind=download`);
  const file = r.status === 200 ? await fetch(r.json.url, { headers: { Range: "bytes=0-15" } }) : null;
  return { ok: r.status === 200 && (file?.status === 206 || file?.status === 200) && /attachment/.test(file?.headers.get("content-disposition") ?? ""), detail: `${r.status} ${file?.status}` };
}

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F14", "F15", "F18", "F20", "F21", "F23"]));
  await db.collection("rateLimits").deleteMany({});
  const a = await signUp("a");
  const b = await signUp("b");
  const tz = "Asia/Kolkata";

  // ---------- 1. video 1 with the stand-in voice ----------
  const created = await send(a.cookie, "POST", "/api/v1/projects", { inputType: "topic", text: "How does the water cycle work?", language: "en", voiceGender: "female" }, { "idempotency-key": key() });
  const pid = created.json.project?.id as string;
  let st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null && s.state !== "planning", 90_000);
  check("storyboard made (stand-in Gemini)", st.state === "storyboard_ready", st.state);
  const [p0, v0] = await Promise.all([send(a.cookie, "GET", `/api/v1/projects/${pid}`), send(a.cookie, "GET", `/api/v1/projects/${pid}/plan-versions/current`)]);
  let view = await page(a.cookie, `/projects/${pid}/storyboard`);
  check("storyboard before any video: 'Approve & generate video', no cost note, no Back to video", view.html.includes("Approve & generate video") && !view.html.includes("Approve & make new video") && !view.html.includes("In your new video") && !view.html.includes("Back to video"));
  let r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/storyboard-approval`, { planVersionId: v0.json.id, planHash: v0.json.planHash, expectedStateVersion: p0.json.stateVersion }, { "idempotency-key": key() });
  check("Approve & generate video → 202", r.status === 202, `status ${r.status}`);
  let started = Date.now();
  st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null, 12 * 60_000);
  console.log(`      (video 1 took ${((Date.now() - started) / 1000).toFixed(0)} s)`);
  check("video 1 ready", st.state === "video_ready" && typeof st.currentRenderId === "string", `${st.state} ${JSON.stringify(st.lastError)}`);
  const render1Id = st.currentRenderId as string;
  const render1 = (await db.collection("renders").findOne({ _id: oid(render1Id) }))!;
  const scenes = v0.json.plan.scenes as Json[];
  const changedIndex = scenes.findIndex((s) => s.id === "scene-condensation");
  const changed = scenes[changedIndex]!;
  check("the storyboard has the scene this check changes (scene 3, plain narration)", changedIndex === 2 && !changed.narration[0].speech && !changed.narration[0].display, `${changedIndex}`);

  // ---------- 2. the video page offers Ask for changes ----------
  let project = (await send(a.cookie, "GET", `/api/v1/projects/${pid}`)).json;
  check("C3 on the ready video: request_revision and edit_captions offered", project.allowedActions?.includes("request_revision") && project.allowedActions?.includes("edit_captions"), project.allowedActions?.join());
  view = await page(a.cookie, `/projects/${pid}/video`);
  check("video page: the Captions and Ask for changes tabs, Whole video + scene choices", view.status === 200 && view.html.includes(">Captions<") && view.html.includes(">Ask for changes<") && view.html.includes("Whole video") && view.html.includes("Scene 03"));
  const baseline = await voiceSnapshot(a.id, tz);
  check("baseline: video 1's voice requests were logged (so the counts below mean something)", baseline.providerUsage === scenes.length && baseline.standIn > 0 && baseline.userChars > 0 && baseline.videosToday === 1, JSON.stringify(baseline));
  const versionsBefore = await db.collection("planVersions").countDocuments({ projectId: oid(pid) });
  const reviseUrl = `/api/v1/projects/${pid}/revisions`;
  const videoBody = (message: string, more: Json = {}) => ({ stage: "video", scope: "project", message, basePlanVersionId: v0.json.id, expectedStateVersion: project.stateVersion, ...more });

  // ---------- 3. owner only, and the body rules ----------
  r = await send(b.cookie, "POST", reviseUrl, videoBody("make the ending punchier"), { "idempotency-key": key() });
  check("D5 stage video on another user's project → 404", r.status === 404, `status ${r.status}`);
  r = await send(b.cookie, "GET", `${reviseUrl}?stage=video`);
  check("D6 stage=video on another user's project → 404", r.status === 404, `status ${r.status}`);
  r = await send(a.cookie, "POST", reviseUrl, videoBody("x".repeat(501)), { "idempotency-key": key() });
  check("D5 stage video, 501 characters → 400", r.status === 400, `status ${r.status}`);
  check("refusals saved nothing (no revision, no job)", (await db.collection("revisions").countDocuments({ projectId: oid(pid) })) === 0 && (await projectOf(pid))?.activeJobId === null);

  // ---------- 4. an unclear request: a reply, no new version, video 1 stays ----------
  r = await send(a.cookie, "POST", reviseUrl, videoBody("e2e nochange: make it better"), { "idempotency-key": key() });
  check("D5 stage video (unclear request) → 202, revision stage video", r.status === 202 && r.json.revision?.stage === "video" && r.json.job?.type === "revise", `${r.status} ${JSON.stringify(r.json.error ?? null)}`);
  const unclearId = r.json.revision?.id as string;
  st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null, 90_000);
  const unclear = await db.collection("revisions").findOne({ _id: oid(unclearId) });
  check("unclear → revision rejected with a reply question, job needs_input", unclear?.status === "rejected" && /Try saying exactly what to change/.test(unclear.assistantReply ?? "") && (await db.collection("jobs").findOne({ _id: unclear.jobId }))?.state === "needs_input");
  check("…no new version; the project is still video_ready with video 1", (await db.collection("planVersions").countDocuments({ projectId: oid(pid) })) === versionsBefore && st.state === "video_ready" && st.currentRenderId === render1Id && st.currentPlanVersionId === v0.json.id);
  r = await send(a.cookie, "GET", `${reviseUrl}?stage=video`);
  const storyboardHistory = await send(a.cookie, "GET", `${reviseUrl}?stage=storyboard`);
  check("D6 stage=video lists it with the reply; stage=storyboard doesn't", r.json.items?.[0]?.id === unclearId && r.json.items[0].status === "rejected" && storyboardHistory.json.items?.length === 0);
  view = await page(a.cookie, `/projects/${pid}/video`);
  check("the video page shows the request and the reply (no redirect)", view.status === 200 && view.html.includes("make it better") && view.html.includes("Try saying exactly what to change"));

  // ---------- 5. while a change runs (a busy AI keeps it running, then it fails) ----------
  project = (await send(a.cookie, "GET", `/api/v1/projects/${pid}`)).json;
  r = await send(a.cookie, "POST", reviseUrl, videoBody("e2e busy: shorter"), { "idempotency-key": key() });
  const busyJob = r.json.job?.id as string;
  check("D5 stage video → 202 (the stand-in AI answers busy every time)", r.status === 202, `${r.status}`);
  const captionPhrases = ((await send(a.cookie, "GET", `/api/v1/projects/${pid}/renders/current`)).json.captions ?? []) as Json[];
  const phrase = captionPhrases[1]!;
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/renders/current/caption-overrides`, { edits: [{ sceneId: phrase.sceneId, phraseIndex: phrase.phraseIndex, text: "Water rises." }], expectedStateVersion: project.stateVersion + 1 }, { "idempotency-key": key() });
  check("F4 caption fix while the change runs → 409 JOB_ALREADY_RUNNING", r.status === 409 && r.json.error?.code === "JOB_ALREADY_RUNNING", `${r.status} ${r.json.error?.code}`);
  r = await send(a.cookie, "POST", reviseUrl, { ...videoBody("make the ending punchier"), expectedStateVersion: project.stateVersion + 1 }, { "idempotency-key": key() });
  check("a second change while one runs → 409 JOB_ALREADY_RUNNING", r.status === 409 && r.json.error?.code === "JOB_ALREADY_RUNNING", `${r.status} ${r.json.error?.code}`);
  const whileRunning = await downloadable(a.cookie, pid, render1Id);
  check("…video 1 still downloads while the change runs", whileRunning.ok, whileRunning.detail);
  const running = (await send(a.cookie, "GET", `/api/v1/projects/${pid}/status`)).json;
  view = await page(a.cookie, `/projects/${pid}/video`);
  // The progress line is the job's own message: "Updating your storyboard…", then (busy AI) "Our AI is busy, trying again…".
  const shows = {
    progress: view.html.includes('aria-label="Change progress"') && /Updating your storyboard…|Our AI is busy, trying again…/.test(view.html),
    captionsWait: view.html.includes("Caption fixes wait until your change request is finished."),
  };
  check(
    "…the video page (still video_ready) shows the progress line and says caption fixes wait",
    running.activeJob?.type === "revise" && running.state === "video_ready" && view.status === 200 && shows.progress && shows.captionsWait,
    `${running.activeJob?.type} ${running.state} ${JSON.stringify(shows)}`,
  );
  st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null, 3 * 60_000);
  r = await send(a.cookie, "GET", `/api/v1/jobs/${busyJob}`);
  check("busy → the change failed (PROVIDER_BUSY, retryable); video_ready with video 1; Try again offered", r.json.state === "failed" && r.json.error?.code === "PROVIDER_BUSY" && st.state === "video_ready" && st.currentRenderId === render1Id && st.allowedActions?.includes("retry_job"), `${r.json.state} ${r.json.error?.code}`);
  view = await page(a.cookie, `/projects/${pid}/video`);
  check("…the video page shows the failure message and Try again", view.html.includes(r.json.error?.message ?? "(none)") && view.html.includes("Try again"));
  check("no voice request so far (changes only call the AI)", (await voiceSnapshot(a.id, tz)).standIn === baseline.standIn);

  // ---------- 6. the real change: scene 3 on the video ----------
  project = (await send(a.cookie, "GET", `/api/v1/projects/${pid}`)).json;
  const MESSAGE = "Say this scene more simply";
  r = await send(a.cookie, "POST", reviseUrl, videoBody(MESSAGE, { scope: "scene", sceneId: changed.id, expectedStateVersion: project.stateVersion }), { "idempotency-key": key() });
  const changeJob = r.json.job?.id as string;
  const changeRevision = r.json.revision?.id as string;
  check("D5 stage video, scene 3 → 202 (Updating scene 3…)", r.status === 202 && r.json.revision?.scope === "scene" && r.json.job?.progress?.message === "Updating scene 3…", `${r.status} ${JSON.stringify(r.json.error ?? null)}`);
  const seen = new Set<string>();
  st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null, 90_000, seen);
  const v1 = (await send(a.cookie, "GET", `/api/v1/projects/${pid}/plan-versions/current`)).json;
  const rev = await db.collection("revisions").findOne({ _id: oid(changeRevision) });
  check("success: a new ai_revision version, only scene 3 Changed; the revision succeeded", (await db.collection("jobs").findOne({ _id: oid(changeJob) }))?.state === "succeeded" && v1.source === "ai_revision" && v1.changedSceneIds?.join() === changed.id && rev?.status === "succeeded" && rev.stage === "video");
  const changedProject = (await send(a.cookie, "GET", `/api/v1/projects/${pid}`)).json;
  check(
    "project → storyboard_ready, not approved, video 1 kept as its video (currentRenderId)",
    changedProject.state === "storyboard_ready" && changedProject.currentPlanVersionId === v1.id && changedProject.approvedPlanVersionId === null && changedProject.currentRenderId === render1Id,
    `${changedProject.state} approved=${changedProject.approvedPlanVersionId} render=${changedProject.currentRenderId === render1Id}`,
  );
  check("the new narration of scene 3 has the new words", v1.plan.scenes[changedIndex].narration[0].text.endsWith("Simple as that."));

  // ---------- 7. the storyboard: Changed tag, cost note, button, Back to video ----------
  view = await page(a.cookie, `/projects/${pid}/storyboard`);
  const note = /In your new video, scene 3 gets new narration \(about ([\d,]+) voice characters\)\. The other (\d+) scenes reuse their recordings\. It counts as 1 of your 3 videos today \(2 left\)\./.exec(view.html);
  const noteChars = note ? Number(note[1]!.replace(/,/g, "")) : NaN;
  check("storyboard: the cost note names ONLY scene 3, with its characters, the other 5 scenes reuse", note !== null && note[2] === String(scenes.length - 1) && noteChars > 0, note?.[0] ?? "(no note)");
  check("storyboard: 'Approve & make new video', Back to video, the Changed tag", view.html.includes("Approve & make new video") && !view.html.includes("Approve & generate video") && view.html.includes("Back to video") && view.html.includes("Changed"));
  check("…no voice request or count from showing the note", JSON.stringify(await voiceSnapshot(a.id, tz)) === JSON.stringify(baseline));
  view = await page(a.cookie, `/projects/${pid}/video`);
  check("Back to video: the video page shows video 1 with a note to approve the new storyboard", view.status === 200 && view.html.includes("Your storyboard has changes that aren't in this video yet.") && view.html.includes("Back to storyboard") && view.html.includes("so its captions can't be fixed now") && view.html.includes("Ask for more changes on the storyboard."));
  const meanwhile = await downloadable(a.cookie, pid, render1Id);
  check("…video 1 still downloads", meanwhile.ok, meanwhile.detail);
  project = (await send(a.cookie, "GET", `/api/v1/projects/${pid}`)).json;
  r = await send(a.cookie, "POST", reviseUrl, { stage: "video", scope: "project", message: "make the ending punchier", basePlanVersionId: v1.id, expectedStateVersion: project.stateVersion }, { "idempotency-key": key() });
  check("D5 stage video after the change (storyboard_ready) → 409 INVALID_STATE, nothing saved", r.status === 409 && r.json.error?.code === "INVALID_STATE" && (await projectOf(pid))?.activeJobId === null, `${r.status} ${r.json.error?.code}`);

  // ---------- 7b. Undo back to the video's own version (code review): video_ready again, no job, nothing counted ----------
  const beforeUndo = await voiceSnapshot(a.id, tz);
  const jobsBeforeUndo = await db.collection("jobs").countDocuments({ projectId: oid(pid) });
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/plan-versions/${v0.json.id}/restore`, { expectedStateVersion: project.stateVersion });
  check(
    "D7 Undo to video 1's version → video_ready with the SAME video, approved again, no job",
    r.status === 200 && r.json.state === "video_ready" && r.json.currentRenderId === render1Id && r.json.approvedPlanVersionId === v0.json.id && r.json.activeJobId === null && (await db.collection("jobs").countDocuments({ projectId: oid(pid) })) === jobsBeforeUndo,
    `${r.status} ${r.json.state} ${JSON.stringify(r.json.error ?? null)}`,
  );
  check("…nothing counted (voice, videos today)", JSON.stringify(await voiceSnapshot(a.id, tz)) === JSON.stringify(beforeUndo));
  view = await page(a.cookie, `/projects/${pid}/video`);
  check("…the video page: no 'changes' note, captions and changes offered again", view.status === 200 && !view.html.includes("Your storyboard has changes that aren't in this video yet.") && !view.html.includes("its captions can't be fixed now") && !view.html.includes("Ask for more changes on the storyboard") && r.json.allowedActions?.includes("request_revision") && r.json.allowedActions?.includes("edit_captions"));
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/plan-versions/${v1.id}/restore`, { expectedStateVersion: r.json.stateVersion });
  check("D7 back to the changed version → storyboard_ready (not approved), video 1 kept", r.status === 200 && r.json.state === "storyboard_ready" && r.json.approvedPlanVersionId === null && r.json.currentRenderId === render1Id, `${r.status} ${r.json.state}`);
  project = r.json;

  // ---------- 8. approve → video 2 ----------
  const before = await voiceSnapshot(a.id, tz);
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/storyboard-approval`, { planVersionId: v1.id, planHash: v1.planHash, expectedStateVersion: project.stateVersion }, { "idempotency-key": key() });
  check("D8 Approve & make new video → 202, a new generate job", r.status === 202 && r.json.job?.type === "generate" && r.json.job?.state === "queued", `${r.status} ${JSON.stringify(r.json.error ?? null)}`);
  const genJob = r.json.job?.id as string;
  const videoSeen = new Set<string>();
  started = Date.now();
  st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null, 12 * 60_000, videoSeen);
  console.log(`      (video 2 took ${((Date.now() - started) / 1000).toFixed(0)} s)`);
  check("video 2 ready: video_ready with a NEW current video", st.state === "video_ready" && st.currentRenderId !== render1Id, `${st.state} ${JSON.stringify(st.lastError)}`);
  const recordingSteps = [...videoSeen].filter((m) => /Recording narration/.test(m));
  console.log(`      (recording steps seen: ${recordingSteps.join(" | ") || "none"})`);
  const render2 = (await db.collection("renders").findOne({ _id: oid(st.currentRenderId) }))!;
  check("video 2: ready, renderNumber 2 (Video version 2), made from the new storyboard version", render2.status === "ready" && render2.renderNumber === 2 && render2.planVersionId.toHexString() === v1.id);
  await verifyInR2("R2: video 2's output.mp4 (SHA-256 = renders.mp4Sha256), thumbnail, timeline, captions, qa", [render2.mp4Key, render2.thumbnailKey, render2.timelineKey, render2.captionsKey, render2.qaKey], { [render2.mp4Key]: render2.mp4Sha256 });

  // The change is in the new video.
  const captions1 = await readJson(render1.captionsKey);
  const captions2 = await readJson(render2.captionsKey);
  const textOf = (c: Json, sceneId: string) => (c.captions as Json[]).filter((p) => p.sceneId === sceneId).map((p) => p.text).join(" ");
  check("video 2's captions.json has the new words in scene 3 (video 1's doesn't)", textOf(captions2, changed.id).includes("Simple as that.") && !textOf(captions1, changed.id).includes("Simple as that."), textOf(captions2, changed.id).slice(-60));
  check("…every other scene's captions read exactly as in video 1", scenes.filter((s) => s.id !== changed.id).every((s) => textOf(captions1, s.id) === textOf(captions2, s.id)));

  // Voice: only the changed scene was recorded and counted.
  const after = await voiceSnapshot(a.id, tz);
  check("voice requests +1 ONLY: providerUsage and the stand-in's own call log", after.providerUsage === before.providerUsage + 1 && after.standIn === before.standIn + 1, `providerUsage ${before.providerUsage} → ${after.providerUsage}, stand-in ${before.standIn} → ${after.standIn}`);
  const newSpeech = await db.collection("speechArtifacts").find({ paidByJobId: oid(genJob) }).toArray();
  check("one new recording, for scene 3 only, paid by the new video's job", after.speechArtifacts === before.speechArtifacts + 1 && newSpeech.length === 1 && newSpeech[0]!.sceneId === changed.id, `${newSpeech.map((s) => s.sceneId).join()}`);
  const usage = await db.collection("providerUsage").find({ provider: "elevenlabs", jobId: oid(genJob) }).toArray();
  check("providerUsage: the new video's one voice request", usage.length === 1, `${usage.length}`);
  check(
    "voice characters rose by exactly scene 3's characters = the storyboard note's number (creator and app)",
    after.userChars - before.userChars === newSpeech[0]?.characters && after.appChars - before.appChars === newSpeech[0]?.characters && newSpeech[0]?.characters === noteChars,
    `creator +${after.userChars - before.userChars}, app +${after.appChars - before.appChars}, recording ${newSpeech[0]?.characters}, note ${noteChars}`,
  );
  check("videos today +1 (a generate job)", after.videosToday === before.videosToday + 1, `${before.videosToday} → ${after.videosToday}`);
  // (The progress line names every scene it checks, "Recording narration · scene N of 6", also those that
  // reuse their recording; the counts above prove only scene 3 was really recorded.)

  // Every other scene: the SAME recording as video 1.
  const speechOf = async (render: Json) => {
    const docs = await db.collection("speechArtifacts").find({ _id: { $in: render.speech.map((s: Json) => s.speechArtifactId) } }).toArray();
    return new Map(render.speech.map((s: Json) => [s.sceneId, docs.find((d) => d._id.equals(s.speechArtifactId))]));
  };
  const [speech1, speech2] = [await speechOf(render1), await speechOf(render2)];
  const same = scenes.filter((s) => s.id !== changed.id).every((s) => {
    const x = speech1.get(s.id) as Json | undefined;
    const y = speech2.get(s.id) as Json | undefined;
    return x && y && x._id.equals(y._id) && x.cacheKey === y.cacheKey && x.audioKey === y.audioKey && x.audioSha256 === y.audioSha256;
  });
  check(`the other ${scenes.length - 1} scenes use the SAME recording as video 1 (id, cache key, audio key, SHA-256)`, same && render2.speech.length === scenes.length);
  const s1 = speech1.get(changed.id) as Json | undefined;
  const s2 = speech2.get(changed.id) as Json | undefined;
  check("scene 3 uses its NEW recording (another cache key and audio)", s1 && s2 && !s1._id.equals(s2._id) && s1.cacheKey !== s2.cacheKey && s2._id.equals(newSpeech[0]?._id));
  await verifyInR2("R2: scene 3's new recording (audio SHA-256, alignment files)", [s2!.audioKey, s2!.alignmentKey, s2!.normalizedAlignmentKey], { [s2!.audioKey]: s2!.audioSha256 });

  // Older video kept.
  const versions = await send(a.cookie, "GET", `/api/v1/projects/${pid}/renders`);
  check("F1: two versions, video 2 current, video 1 kept", versions.json.items?.length === 2 && versions.json.items[0].renderNumber === 2 && versions.json.items[0].isCurrent === true && versions.json.items[1].id === render1Id && versions.json.items[1].isCurrent === false);
  const old = await downloadable(a.cookie, pid, render1Id);
  check("video 1 is still downloadable", old.ok, old.detail);
  view = await page(a.cookie, `/projects/${pid}/video`);
  check("video page: video 2 ready with both tabs again (no 'storyboard changed' note)", view.status === 200 && view.html.includes("Video version 2") && view.html.includes(">Ask for changes<") && !view.html.includes("Your storyboard has changes that aren't in this video yet."));
  view = await page(a.cookie, `/projects/${pid}/storyboard`);
  check("storyboard after video 2: approved, no cost note", view.html.includes("Approved · Version") && !view.html.includes("In your new video"));

  // ---------- 9. owner only (jobs) and signed out ----------
  for (const [label, res] of [
    ["E1 on the change job", await send(b.cookie, "GET", `/api/v1/jobs/${changeJob}`)],
    ["E2 on the failed change", await send(b.cookie, "POST", `/api/v1/jobs/${busyJob}/retry`, {}, { "idempotency-key": key() })],
    ["the video page", await page(b.cookie, `/projects/${pid}/video`)],
  ] as const) check(`another user: ${label} → 404`, res.status === 404, `status ${res.status}`);
  check("signed out: D6 → 401", (await send("", "GET", `${reviseUrl}?stage=video`)).status === 401);

  const leftovers = existsSync(path.join(ROOT, "runs", ".tmp", "generate")) ? readdirSync(path.join(ROOT, "runs", ".tmp", "generate")) : [];
  check("no render work folders left in runs/.tmp/generate", leftovers.length === 0, leftovers.join(", "));

  // The R2 files of this check (dev bucket, test user ids; kept).
  for (const s of speech1.values() as Iterable<Json>) uploaded.push(s.audioKey, s.alignmentKey, s.normalizedAlignmentKey);
  uploaded.push(render1.mp4Key, render1.thumbnailKey, render1.timelineKey, render1.captionsKey, render1.qaKey);
  console.log("\nR2 files uploaded by this check (dev bucket, test user ids; kept):");
  for (const k of [...new Set(uploaded)]) console.log(`  ${k}`);
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error("E2E crashed:", error instanceof Error ? error.stack : error);
  })
  .finally(async () => {
    await closeMongoClient();
    console.log(failures === 0 ? `\nAll F26 checks passed (${passes}).` : `\n${failures} check(s) failed, ${passes} passed.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
