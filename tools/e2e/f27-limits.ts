import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { addInvite, APP_USAGE_OWNER_ID, closeMongoClient, endGenerateJob, ensureIndexes, getDb, indexesForFeatures, newGenerateJob, readDbConfig, usageCounterPeriod, type UsageKind } from "@bytereel/db";
import { ObjectId } from "mongodb";

/**
 * F27 end-to-end check over real HTTP ("Daily limits"): the clear limit messages with the reset time
 * in the creator's timezone, the storyboard's warning with a greyed-out Approve BEFORE the click, and
 * D8/E2 refusing with the same words. It never renders a video: it puts a test user at a limit by
 * writing the `usageCounters` of the TEST database directly (e.g. 3 of 3 videos today, 2,999 of
 * 3,000 voice characters), and the one approval D8 accepts (the 3rd video of the day, exactly enough
 * voice) is cancelled at once (E3). Storyboards come from the STAND-IN Gemini (E2E_FAKE_GEMINI=1:
 * ZERO Gemini calls); a video job that starts uses the STAND-IN voice (E2E_FAKE_ELEVENLABS=1: ZERO
 * ElevenLabs calls).
 * It proves: the 4th video of a day → 429 videos_per_day with the new wording, nothing counted, no
 * job; the storyboard shows the reason and a disabled Approve at 3/3 and when the voice won't fit
 * (1 left, 1 short), and allows exactly enough; yesterday's count doesn't count today; New York's
 * midnight for a New York user; the app's 9,000 → 503 SPEND_CEILING "paused for everyone" (with the
 * date in each creator's timezone); a video job stopped by a voice limit shows the same words on the
 * failure screen and Try again is refused the same way; B1 and the header chip follow the counters;
 * the other user is unaffected by one user's limits.
 *
 * TEMP FILES: never in /tmp. In every terminal used below, first run from the repo root:
 *   mkdir -p runs/.tmp && export TMPDIR="$PWD/runs/.tmp"
 * SAFETY: only the separate test database `bytereel_test`, ports 3230–3239 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. (in runs/f27-work/inngest) npx --yes inngest-cli@1.49.0 dev --no-discovery -u http://localhost:3236/api/inngest --port 8299 \
 *        --connect-gateway-port 8298 --connect-gateway-grpc-port 50062 --connect-executor-grpc-port 50063
 *   3. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3236 E2E_FAKE_GEMINI=1 E2E_FAKE_ELEVENLABS=1 \
 *        INNGEST_DEV=http://localhost:8299 npx next start -p 3236
 *   4. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3236 E2E_FAKE_GEMINI=1 E2E_FAKE_ELEVENLABS=1 npx tsx tools/e2e/f27-limits.ts
 *   5. drop the bytereel_test database afterwards.
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has E2E_FAKE_GEMINI=1, E2E_FAKE_ELEVENLABS=1, MONGODB_DB=bytereel_test and
 * INNGEST_DEV on port 8299. About 1–2 minutes.
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

function serverSettings(port: string) {
  const listing = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
  const pid = /pid=(\d+)/.exec(listing)?.[1];
  if (!pid) throw new Error(`No server process found on port ${port}.`);
  const env = new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  return env.get("E2E_FAKE_GEMINI") === "1" && env.get("E2E_FAKE_ELEVENLABS") === "1" && env.get("MONGODB_DB") === TEST_DB && env.get("INNGEST_DEV") === "http://localhost:8299";
}
if (!serverSettings(new URL(base).port)) throw new Error("Stopping before any request: the server must run with E2E_FAKE_GEMINI=1, E2E_FAKE_ELEVENLABS=1, MONGODB_DB=bytereel_test and INNGEST_DEV=http://localhost:8299.");

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
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Json };
};
/** A page as HTML text with React's comment markers and the common entities decoded. */
const page = async (cookie: string, url: string) => {
  const r = await fetch(`${base}${url}`, { headers: { cookie }, redirect: "manual" });
  const html = (await r.text()).replace(/<!-- -->/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
  return { status: r.status, html };
};
const oid = (id: string) => new ObjectId(id);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cookie: string, projectId: string, done: (s: Json) => boolean, timeoutMs: number): Promise<Json> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await send(cookie, "GET", `/api/v1/projects/${projectId}/status`);
    if (done(r.json) || Date.now() > end) return r.json;
    await sleep(500);
  }
}

async function signUp(label: string): Promise<{ cookie: string; id: ObjectId }> {
  const email = `f27-e2e-${label}-${tag}@example.com`;
  await addInvite(db, email, { note: "F27 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `F27 Tester ${label}`, email, password: `E2e-${randomBytes(9).toString("base64url")}` }),
  });
  check(`test account ${label} created`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId };
}

// ---------- the usage counters (TEST database only) ----------

async function counter(ownerId: ObjectId, kind: UsageKind, timezone: string, now = new Date()): Promise<number> {
  const { period } = usageCounterPeriod(kind, timezone, now);
  return ((await db.collection("usageCounters").findOne({ ownerId, kind, period }))?.count as number | undefined) ?? 0;
}
/** Put a counter at `count` for the period `now` falls in (as if the creator had used that much). */
async function setCounter(ownerId: ObjectId, kind: UsageKind, timezone: string, count: number, now = new Date()): Promise<void> {
  const { period, expiresAt } = usageCounterPeriod(kind, timezone, now);
  if (count === 0) await db.collection("usageCounters").deleteOne({ ownerId, kind, period });
  else await db.collection("usageCounters").updateOne({ ownerId, kind, period }, { $set: { count }, $setOnInsert: { expiresAt } }, { upsert: true });
}
const APP = oid(APP_USAGE_OWNER_ID);

// ---------- the expected words (written here independently of the app's own builders) ----------

const KOLKATA = "Asia/Kolkata";
const NEW_YORK = "America/New_York";
const n = (value: number) => value.toLocaleString("en-IN");
const dayIn = (instant: Date, timezone: string) => new Intl.DateTimeFormat("en-IN", { timeZone: timezone, day: "numeric", month: "long" }).format(instant);
const VIDEOS_TEXT = "You've made 3 videos today, the most for one day. You can make more after 12:00 am (midnight) your time.";
const voiceText = (needed: number, left: number, timezone: string) =>
  `This video needs about ${n(needed)} voice characters, but you have ${n(left)} left this month. The limit resets on ${dayIn(usageCounterPeriod("voiceChars", timezone).resetsAt, timezone)}.`;
const pauseText = (timezone: string) =>
  `Video making is paused for everyone until ${dayIn(usageCounterPeriod("appVoiceChars", "UTC").resetsAt, timezone)} (the app's monthly voice limit is used up). Your videos and downloads still work.`;

// ---------- the storyboard page ----------

/** The opening tag of the <button> whose text contains `label` (null when there is none). */
function buttonTag(html: string, label: string): string | null {
  const at = html.indexOf(label);
  if (at < 0) return null;
  const start = html.lastIndexOf("<button", at);
  return start < 0 ? null : html.slice(start, html.indexOf(">", start) + 1);
}
type Board = { limitNote: string | null; short: string | null; approve: { disabled: boolean; describedBy: boolean } | null; html: string };
async function storyboard(cookie: string, projectId: string, label = "Approve & generate video"): Promise<Board> {
  const { html } = await page(cookie, `/projects/${projectId}/storyboard`);
  // The limit note as rendered (id="approve-limit"), up to its closing </div>.
  const noteAt = html.indexOf('id="approve-limit"');
  const limitNote = noteAt < 0 ? null : html.slice(noteAt, html.indexOf("</div>", noteAt)).replace(/<[^>]+>/g, "").replace(/^[^>]*>/, "");
  const shortMatch = /<p class="text-xs text-danger">([^<]+)<\/p>/.exec(html);
  const tagText = buttonTag(html, label);
  return {
    limitNote,
    short: shortMatch?.[1] ?? null,
    approve: tagText ? { disabled: /\sdisabled(=""|\s|>)/.test(tagText), describedBy: tagText.includes('aria-describedby="approve-limit"') } : null,
    html,
  };
}
const shows = (board: Board, text: string) => board.limitNote !== null && board.limitNote.includes(text);
const greyedOut = (board: Board) => board.approve?.disabled === true && board.approve.describedBy;
const clear = (board: Board) => board.limitNote === null && board.short === null && board.approve?.disabled === false;
const boardDetail = (board: Board) => JSON.stringify({ note: board.limitNote?.slice(-160) ?? null, short: board.short, approve: board.approve });

/** D8 on the current version, with a fresh Idempotency-Key. */
async function approve(cookie: string, projectId: string) {
  const [p, v] = await Promise.all([send(cookie, "GET", `/api/v1/projects/${projectId}`), send(cookie, "GET", `/api/v1/projects/${projectId}/plan-versions/current`)]);
  return send(cookie, "POST", `/api/v1/projects/${projectId}/storyboard-approval`, { planVersionId: v.json.id, planHash: v.json.planHash, expectedStateVersion: p.json.stateVersion }, { "idempotency-key": key() });
}
/** Nothing happened to a project after a refused D8: same state and stateVersion, no generate job, no approval. */
async function untouched(projectId: string, before: Json): Promise<boolean> {
  const project = await db.collection("projects").findOne({ _id: oid(projectId) });
  const jobs = await db.collection("jobs").countDocuments({ projectId: oid(projectId), type: "generate" });
  const approvals = await db.collection("storyboardApprovals").countDocuments({ projectId: oid(projectId) });
  return project?.state === before.state && project?.stateVersion === before.stateVersion && jobs === 0 && approvals === 0 && project?.activeJobId === null;
}
const snapshot = async (projectId: string) => (await db.collection("projects").findOne({ _id: oid(projectId) })) as Json;
const usageOf = async (cookie: string) => (await send(cookie, "GET", "/api/v1/me")).json.usage as Json;

async function newProject(cookie: string, text: string): Promise<string> {
  const created = await send(cookie, "POST", "/api/v1/projects", { inputType: "topic", text, language: "en", voiceGender: "female" }, { "idempotency-key": key() });
  const id = created.json.project?.id as string;
  const st = await waitFor(cookie, id, (s) => s.pollAfterMs === null && s.state !== "planning", 90_000);
  check(`storyboard made (stand-in Gemini): "${text}"`, st.state === "storyboard_ready", st.state);
  return id;
}

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F14", "F15", "F18", "F20", "F21", "F23"]));
  await db.collection("rateLimits").deleteMany({});
  const a = await signUp("a");
  const b = await signUp("b");
  // B lives in New York (UTC−5 in November): its day ends at 05:00 UTC.
  await db.collection("user").updateOne({ _id: b.id }, { $set: { timezone: NEW_YORK } });
  check("B1 shows B's timezone", (await send(b.cookie, "GET", "/api/v1/me")).json.timezone === NEW_YORK);

  const p1 = await newProject(a.cookie, "How does the water cycle work?");
  const p2 = await newProject(a.cookie, "Why do clouds float?");
  const p3 = await newProject(a.cookie, "What makes rain fall?");
  const q1 = await newProject(b.cookie, "How do rainbows form?");

  // ---------- 1. room for everything ----------
  let usage = await usageOf(a.cookie);
  check("B1: videos today 0 of 3 (resets at A's next midnight), voice 0 of 3,000", usage.videosToday?.used === 0 && usage.videosToday.limit === 3 && usage.videosToday.resetsAt === usageCounterPeriod("videos", KOLKATA).resetsAt.toISOString() && usage.voiceCharactersThisMonth?.used === 0 && usage.voiceCharactersThisMonth.limit === 3000, JSON.stringify(usage));
  let board = await storyboard(a.cookie, p1);
  check("storyboard with room: no limit note, Approve & generate video enabled", clear(board), boardDetail(board));

  // ---------- 2. A has made 3 videos today: the 4th is refused ----------
  await setCounter(a.id, "videos", KOLKATA, 3);
  usage = await usageOf(a.cookie);
  check("B1 follows the counter: videos today 3 of 3", usage.videosToday?.used === 3, JSON.stringify(usage.videosToday));
  let view = await page(a.cookie, "/dashboard");
  check("header chip: 'Videos today: 3 of 3'", view.html.includes("Videos today: 3 of 3"));
  board = await storyboard(a.cookie, p1);
  check("storyboard at 3/3: the note says why and when it resets (decision 1's words)", shows(board, VIDEOS_TEXT), boardDetail(board));
  check("…Approve is greyed out, with the short reason next to it and the note as its description", greyedOut(board) && board.short === "No videos left today.", boardDetail(board));
  let before = await snapshot(p1);
  let r = await approve(a.cookie, p1);
  check("D8, 4th video of the day → 429 QUOTA_EXCEEDED videos_per_day with the same words", r.status === 429 && r.json.error?.code === "QUOTA_EXCEEDED" && r.json.error?.message === VIDEOS_TEXT, `${r.status} ${r.json.error?.message}`);
  check("…details: limit 3, used 3, resetsAt = A's next midnight (Kolkata, 18:30 UTC)", r.json.error?.details?.quota === "videos_per_day" && r.json.error.details.limit === 3 && r.json.error.details.used === 3 && r.json.error.details.resetsAt === usageCounterPeriod("videos", KOLKATA).resetsAt.toISOString(), JSON.stringify(r.json.error?.details));
  check("…nothing counted (still 3), no job, no approval, the project unchanged", (await counter(a.id, "videos", KOLKATA)) === 3 && (await untouched(p1, before)));
  board = await storyboard(b.cookie, q1);
  check("the other user is unaffected: B's storyboard has no limit note and Approve enabled", clear(board), boardDetail(board));
  check("…and B1 says B made 0 videos today", (await usageOf(b.cookie)).videosToday?.used === 0);

  // ---------- 3. yesterday's videos don't count today ----------
  await setCounter(a.id, "videos", KOLKATA, 0);
  await setCounter(a.id, "videos", KOLKATA, 3, new Date(Date.now() - 24 * 3600_000));
  board = await storyboard(a.cookie, p1);
  check("3 videos YESTERDAY: today is fresh (no note, Approve enabled, B1 0 of 3)", clear(board) && (await usageOf(a.cookie)).videosToday?.used === 0, boardDetail(board));

  // ---------- 4. a New York creator: their own midnight ----------
  await setCounter(b.id, "videos", NEW_YORK, 3);
  board = await storyboard(b.cookie, q1);
  check("B (New York) at 3/3: the same words on B's storyboard, Approve greyed out", shows(board, VIDEOS_TEXT) && greyedOut(board), boardDetail(board));
  r = await approve(b.cookie, q1);
  check("…D8 → 429 with resetsAt = B's next midnight (New York, 05:00 UTC)", r.status === 429 && r.json.error?.message === VIDEOS_TEXT && r.json.error?.details?.resetsAt === usageCounterPeriod("videos", NEW_YORK).resetsAt.toISOString() && /T05:00:00\.000Z$/.test(r.json.error.details.resetsAt), JSON.stringify(r.json.error?.details));
  await setCounter(b.id, "videos", NEW_YORK, 0);

  // ---------- 5. voice: 1 character left this month ----------
  await setCounter(a.id, "voiceChars", KOLKATA, 2999);
  before = await snapshot(p1);
  r = await approve(a.cookie, p1);
  const needed = Number(r.json.error?.details?.needed);
  check("D8 with 1 voice character left → 429 voice_characters_per_month (needed vs left, the reset date)", r.status === 429 && r.json.error?.details?.quota === "voice_characters_per_month" && needed > 1 && r.json.error.message === voiceText(needed, 1, KOLKATA), `${r.status} ${r.json.error?.message}`);
  check("…details: limit 3,000, used 2,999, resetsAt = 1st of next month in Kolkata", r.json.error?.details?.limit === 3000 && r.json.error.details.used === 2999 && r.json.error.details.resetsAt === usageCounterPeriod("voiceChars", KOLKATA).resetsAt.toISOString(), JSON.stringify(r.json.error?.details));
  check("…videos/day not counted (still 0 today), no job, the project unchanged", (await counter(a.id, "videos", KOLKATA)) === 0 && (await untouched(p1, before)));
  board = await storyboard(a.cookie, p1);
  check("storyboard: the same voice sentence, Approve greyed out with 'Not enough voice characters left this month.'", shows(board, voiceText(needed, 1, KOLKATA)) && greyedOut(board) && board.short === "Not enough voice characters left this month.", boardDetail(board));
  check("B1: voice 2,999 of 3,000", (await usageOf(a.cookie)).voiceCharactersThisMonth?.used === 2999);
  console.log(`      (the stand-in storyboard needs ${needed} voice characters)`);

  // ---------- 6. 1 short ----------
  await setCounter(a.id, "voiceChars", KOLKATA, 3000 - needed + 1);
  r = await approve(a.cookie, p1);
  check(`1 short (${n(needed)} needed, ${n(needed - 1)} left) → 429 with those numbers`, r.status === 429 && r.json.error?.message === voiceText(needed, needed - 1, KOLKATA), `${r.status} ${r.json.error?.message}`);
  board = await storyboard(a.cookie, p1);
  check("…the storyboard says the same and greys out Approve", shows(board, voiceText(needed, needed - 1, KOLKATA)) && greyedOut(board), boardDetail(board));

  // ---------- 7. the app's monthly 9,000 (everyone) ----------
  await setCounter(a.id, "voiceChars", KOLKATA, 0);
  const appBefore = await counter(APP, "appVoiceChars", "UTC");
  await setCounter(APP, "appVoiceChars", "UTC", 9000);
  board = await storyboard(a.cookie, p1);
  check("app's voice used up: the pause-for-everyone note (A, Kolkata date), Approve greyed out", shows(board, pauseText(KOLKATA)) && greyedOut(board) && board.short === "Video making is paused for everyone.", boardDetail(board));
  before = await snapshot(p1);
  r = await approve(a.cookie, p1);
  check("…D8 → 503 SPEND_CEILING with the same words; nothing counted, no job", r.status === 503 && r.json.error?.code === "SPEND_CEILING" && r.json.error?.message === pauseText(KOLKATA) && (await counter(a.id, "videos", KOLKATA)) === 0 && (await untouched(p1, before)), `${r.status} ${r.json.error?.message}`);
  board = await storyboard(b.cookie, q1);
  check(`…B is paused too, with the date in B's timezone (${dayIn(usageCounterPeriod("appVoiceChars", "UTC").resetsAt, NEW_YORK)})`, shows(board, pauseText(NEW_YORK)) && greyedOut(board), boardDetail(board));
  await setCounter(APP, "appVoiceChars", "UTC", appBefore);

  // ---------- 8. a video job stopped by a voice limit (decision 3) ----------
  // Rare (D8 checks first): the limit is reached between Approve and the job's reservation. Set up
  // here without a worker: P2 approved with its job running, then the job ends the way the worker
  // ends it (endGenerateJob with QUOTA_EXCEEDED and the characters it asked for), in a real transaction.
  await setCounter(a.id, "voiceChars", KOLKATA, 2999);
  const p2Doc = (await db.collection("projects").findOne({ _id: oid(p2) }))!;
  const p2Version = (await db.collection("planVersions").findOne({ _id: p2Doc.currentPlanVersionId }))!;
  const job = { ...newGenerateJob({ ownerId: a.id, projectId: oid(p2), version: { _id: p2Version._id, planHash: p2Version.planHash }, now: new Date() }), state: "running" as const, startedAt: new Date() };
  await db.collection("jobs").insertOne(job);
  const running = { state: "generating", activeJobId: job._id, approvedPlanVersionId: p2Version._id, updatedAt: new Date() };
  await db.collection("projects").updateOne({ _id: oid(p2) }, { $set: running, $inc: { stateVersion: 1 } });
  const ended = await endGenerateJob(db, { jobId: job._id, attempt: 1, outcome: "failed", code: "QUOTA_EXCEEDED", stage: "speech", detail: "The creator's monthly voice characters are used up", needed });
  const jobAfter = await send(a.cookie, "GET", `/api/v1/jobs/${job._id.toHexString()}`);
  check("job stopped by the creator's limit: E1 error = the same sentence (needed vs left, the date), retryable", ended && jobAfter.json.state === "failed" && jobAfter.json.error?.code === "QUOTA_EXCEEDED" && jobAfter.json.error?.message === voiceText(needed, 1, KOLKATA) && jobAfter.json.error?.retryable === true, JSON.stringify(jobAfter.json.error));
  view = await page(a.cookie, `/projects/${p2}/video`);
  check("…the failure screen shows it, with Try again", view.status === 200 && view.html.includes("We couldn't finish your video") && view.html.includes(voiceText(needed, 1, KOLKATA)) && view.html.includes("Try again"));
  r = await send(a.cookie, "POST", `/api/v1/jobs/${job._id.toHexString()}/retry`, {}, { "idempotency-key": key() });
  const retried = await db.collection("jobs").findOne({ _id: job._id });
  check("…Try again while it still doesn't fit → 429 with the same words; the job stays failed (attempt 1)", r.status === 429 && r.json.error?.message === voiceText(needed, 1, KOLKATA) && retried?.state === "failed" && retried.attempt === 1 && (await snapshot(p2)).state === "generate_failed", `${r.status} ${r.json.error?.message}`);
  await db.collection("jobs").updateOne({ _id: job._id }, { $set: { state: "running", error: null } });
  await db.collection("projects").updateOne({ _id: oid(p2) }, { $set: running, $inc: { stateVersion: 1 } });
  await endGenerateJob(db, { jobId: job._id, attempt: 1, outcome: "failed", code: "SPEND_CEILING", stage: "speech", detail: "The app's monthly voice characters are used up", needed });
  view = await page(a.cookie, `/projects/${p2}/video`);
  check("job stopped by the app's limit: the failure screen says it is paused for everyone", view.html.includes(pauseText(KOLKATA)));

  // ---------- 9. exactly enough voice, the 3rd video of the day: allowed, counters rise ----------
  await setCounter(a.id, "voiceChars", KOLKATA, 3000 - needed);
  await setCounter(a.id, "videos", KOLKATA, 2);
  board = await storyboard(a.cookie, p1);
  check(`exactly enough voice (${n(needed)} needed, ${n(needed)} left) and 1 video left: no limit note, Approve enabled`, clear(board), boardDetail(board));
  r = await approve(a.cookie, p1);
  const jobId = r.json.job?.id as string;
  check("D8 → 202 (a new video job)", r.status === 202 && r.json.job?.type === "generate", `${r.status} ${JSON.stringify(r.json.error ?? null)}`);
  // Cancel at once: no render needed for this check (any narration it recorded used the stand-in voice).
  const cancel = await send(a.cookie, "POST", `/api/v1/jobs/${jobId}/cancel`, {});
  check("…cancelled right away (E3) so nothing is rendered", cancel.status === 202, `${cancel.status}`);
  const st = await waitFor(a.cookie, p1, (s) => s.pollAfterMs === null, 3 * 60_000);
  const cancelled = await db.collection("jobs").findOne({ _id: oid(jobId) });
  check("…the job ended cancelled; the project is back on the storyboard (approval kept)", cancelled?.state === "cancelled" && st.state === "storyboard_ready", `${cancelled?.state} ${st.state}`);
  check("videos today rose 2 → 3 (counted when D8 accepted the job)", (await counter(a.id, "videos", KOLKATA)) === 3);
  usage = await usageOf(a.cookie);
  const voiceUsed = usage.voiceCharactersThisMonth?.used as number;
  check("B1: videos today 3 of 3; voice never above 3,000 (reserved in full or not at all)", usage.videosToday?.used === 3 && (voiceUsed === 3000 - needed || voiceUsed === 3000), JSON.stringify(usage));
  view = await page(a.cookie, "/dashboard");
  check("header chip: 'Videos today: 3 of 3'", view.html.includes("Videos today: 3 of 3"));

  // ---------- 10. now the 4th video for real ----------
  board = await storyboard(a.cookie, p3);
  check("another project at 3/3: the videos note, Approve greyed out", shows(board, VIDEOS_TEXT) && greyedOut(board), boardDetail(board));
  before = await snapshot(p3);
  r = await approve(a.cookie, p3);
  check("D8 on it → 429 videos_per_day; still 3, no job", r.status === 429 && r.json.error?.details?.quota === "videos_per_day" && r.json.error?.message === VIDEOS_TEXT && (await counter(a.id, "videos", KOLKATA)) === 3 && (await untouched(p3, before)), `${r.status} ${r.json.error?.message}`);
  board = await storyboard(a.cookie, p1, "Generate video");
  check("the cancelled video's 'Generate video' is NOT limited by videos/day (it queues the same job, which doesn't count again)", clear(board), boardDetail(board));

  // ---------- 11. the other user, still unaffected; owner only ----------
  board = await storyboard(b.cookie, q1);
  usage = await usageOf(b.cookie);
  check("B at the end: no limit note, Approve enabled, 0 videos today, 0 voice characters", clear(board) && usage.videosToday?.used === 0 && usage.voiceCharactersThisMonth?.used === 0, boardDetail(board));
  const [p3Project, p3Version] = await Promise.all([send(a.cookie, "GET", `/api/v1/projects/${p3}`), send(a.cookie, "GET", `/api/v1/projects/${p3}/plan-versions/current`)]);
  r = await send(b.cookie, "POST", `/api/v1/projects/${p3}/storyboard-approval`, { planVersionId: p3Version.json.id, planHash: p3Version.json.planHash, expectedStateVersion: p3Project.json.stateVersion }, { "idempotency-key": key() });
  check("B approving A's project (A's own valid body) → 404 (nothing about A's limits leaks)", r.status === 404 && r.json.error?.code === "NOT_FOUND", `${r.status} ${r.json.error?.code}`);
  check("signed out: D8 → 401", (await send("", "POST", `/api/v1/projects/${p3}/storyboard-approval`, {}, { "idempotency-key": key() })).status === 401);
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error("E2E crashed:", error instanceof Error ? error.stack : error);
  })
  .finally(async () => {
    await closeMongoClient();
    console.log(failures === 0 ? `\nAll F27 checks passed (${passes}).` : `\n${failures} check(s) failed, ${passes} passed.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
