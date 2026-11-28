import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  addInvite,
  closeMongoClient,
  ensureIndexes,
  getDb,
  indexesForFeatures,
  istDateTimeLabel,
  POST_MESSAGES,
  readDbConfig,
  SCHEDULE_MESSAGES,
  type PostDocument,
  type ProjectDocument,
  type RenderDocument,
} from "@bytereel/db";
import { ObjectId } from "mongodb";

/**
 * F31 end-to-end check over real HTTP ("Schedule a post") with the Instagram STAND-IN
 * (E2E_FAKE_INSTAGRAM=1: ZERO calls to Meta) and a PRIVATE Inngest Dev Server on 8299 that runs the real
 * `publish-post` job, including its real sleep (step.sleepUntil) and wake. Like F30 it seeds ready
 * projects in the TEST database; the stand-in Instagram is the `e2eFakeInstagram` collection, so the
 * check counts the reels that went live.
 *
 * TIME SHIFT (test database only): the earliest time H2 accepts is 10 minutes away. So that a case
 * doesn't wait 10 minutes, the check approves with H2 at a real allowed time, then moves the post's
 * `scheduledAt` in the TEST database (to a few seconds from now, or into the past for the missed
 * rule) and hands the SAME job to the private Inngest once more with a new event id (exactly what a
 * re-delivered event looks like). That new run reads the new time, really sleeps until it, and wakes.
 * The first run keeps sleeping until the original time; when it wakes, the post is no longer
 * `scheduled`, so it ends quietly (the wake step lets only one run publish).
 *
 * It proves: H2 Schedule refusals (too soon, more than 7 days, off the 5-minute step, missing / bad
 * time) save nothing; H2 Schedule → 202 (post `scheduled`, attempts 0, project `scheduled` with no active
 * job, the job queued "Scheduled for …"); a second approval → 409; the Step 4 Scheduled view, the C3
 * allowedActions (cancel_post) and the My videos card with the time in IST; reads before the time
 * change nothing; at its time it posts EXACTLY ONE reel; Cancel (H5) → cancelled + job cancelled +
 * project video_ready, again → 200 unchanged, another user's → 404, while publishing → 409, published →
 * 409, and nothing is sent when the run wakes; each kind of change (H7 caption edit, D3 narration edit,
 * D4 voice, C5 archive, G3 another account, G4 Disconnect) → `approval_invalidated` (+ notification, job
 * cancelled; archive → cancelled) and nothing is posted at the time; the Needs approval view; approving
 * again (Schedule, and Publish now) posts exactly once; missed (> 1 hour late) when the job wakes late
 * AND at read time → never posted, SCHEDULE_MISSED, notification, Try again refused, the Missed view,
 * approving again posts once; up to 1 hour late still posts; an expired token at the time →
 * INSTAGRAM_TOKEN_EXPIRED, reconnect the same account, Try again posts once. Code review: a SECOND run (a
 * fresh event id) of an already-woken scheduled post sends nothing (one container, one reel); H2 Schedule
 * for a time after the connection ends → 409.
 *
 * TEMP FILES: never in /tmp. In every terminal used below, first run from the repo root:
 *   mkdir -p runs/.tmp && export TMPDIR="$PWD/runs/.tmp"
 * SAFETY: only the separate test database `bytereel_test`, ports 3230–3239 and a private Inngest on
 * 8299 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. (in runs/f31-work/inngest) npx --yes inngest-cli@1.49.0 dev --no-discovery -u http://localhost:3237/api/inngest --port 8299 \
 *        --connect-gateway-port 8298 --connect-gateway-grpc-port 50062 --connect-executor-grpc-port 50063
 *   3. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3237 E2E_FAKE_INSTAGRAM=1 E2E_FAKE_GEMINI=1 \
 *        E2E_FAKE_ELEVENLABS=1 INNGEST_DEV=http://localhost:8299 TOKEN_ENCRYPTION_KEYS='{"1":"<openssl rand -base64 32>"}' \
 *        TOKEN_ENCRYPTION_ACTIVE_VERSION=1 REMOTION_SERVE_PORT=3241 npx next start -p 3237
 *   4. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3237 npx tsx tools/e2e/f31-schedule.ts
 *   5. stop the server and Inngest (by their pids) and drop the bytereel_test database afterwards.
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has E2E_FAKE_INSTAGRAM=1, MONGODB_DB=bytereel_test and INNGEST_DEV on port 8299.
 * Tokens and presigned links are never printed.
 */

const TEST_DB = "bytereel_test";
const INNGEST = "http://localhost:8299";
process.loadEnvFile(".env");
const base = process.env.E2E_BASE_URL ?? "";
if (!/^http:\/\/localhost:323\d$/.test(base)) throw new Error("Set E2E_BASE_URL to http://localhost:3230–3239 (never port 3000).");
const settings = readDbConfig(process.env);
if (!settings.ok) throw new Error(settings.problems.join(" "));
if (settings.config.dbName !== TEST_DB) throw new Error(`Refusing to run: MONGODB_DB must be ${TEST_DB}.`);
const db = getDb(settings.config);

function serverEnv(port: string): Map<string, string> {
  const listing = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
  const pid = /pid=(\d+)/.exec(listing)?.[1];
  if (!pid) throw new Error(`No server process found on port ${port}.`);
  return new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
}
const env = serverEnv(new URL(base).port);
if (env.get("E2E_FAKE_INSTAGRAM") !== "1" || env.get("MONGODB_DB") !== TEST_DB || env.get("INNGEST_DEV") !== INNGEST) {
  throw new Error("Stopping before any request: the server must run with E2E_FAKE_INSTAGRAM=1, MONGODB_DB=bytereel_test and INNGEST_DEV=http://localhost:8299.");
}

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
const unescapeHtml = (text: string) => text.replace(/<!-- -->/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const key = () => `f31-${randomBytes(12).toString("hex")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(cookie: string, path: string): Promise<{ status: number; location: string; text: string }> {
  const r = await fetch(path.startsWith("http") ? path : `${base}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location") ?? "", text: unescapeHtml(await r.text()) };
}
async function send(cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) as Json };
  } catch {
    return { status: r.status, json: {} };
  }
}

type Tester = { cookie: string; id: ObjectId; label: string };

async function signUp(label: string): Promise<Tester> {
  const email = `f31-e2e-${label}-${tag}@example.com`;
  const password = `E2e-${randomBytes(9).toString("base64url")}`;
  await addInvite(db, email, { note: "F31 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ name: `F31 Tester ${label}`, email, password }) });
  check(`test account ${label} created`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId, label };
}

type Seeded = { projectId: string; renderId: string; planVersionId: ObjectId };
const MP4 = `sha256:${"d".repeat(64)}`;

/** One ready project with one ready video and its storyboard version (no real file is needed). */
async function seedReadyProject(ownerId: ObjectId, title: string): Promise<Seeded> {
  const now = new Date();
  const projectId = new ObjectId();
  const renderId = new ObjectId();
  const planVersionId = new ObjectId();
  const project: ProjectDocument = {
    _id: projectId,
    ownerId,
    schemaVersion: 1,
    title,
    language: "en",
    voiceGender: "female",
    input: { type: "topic", text: "How rainbows form", brainstormChoice: null },
    state: "video_ready",
    currentPlanVersionId: planVersionId,
    approvedPlanVersionId: planVersionId,
    currentRenderId: renderId,
    activeJobId: null,
    stateVersion: 5,
    planRequestCount: 1,
    lastError: null,
    createdAt: new Date(now.getTime() - 60_000),
    updatedAt: new Date(now.getTime() - 60_000),
    archivedAt: null,
  };
  await db.collection<ProjectDocument>("projects").insertOne(project);
  const folder = `users/${ownerId.toHexString()}/projects/${projectId.toHexString()}/renders/${renderId.toHexString()}`;
  const render: RenderDocument = {
    _id: renderId,
    ownerId,
    projectId,
    schemaVersion: 1,
    planVersionId,
    planHash: `sha256:${"1".repeat(64)}`,
    renderNumber: 1,
    speech: [],
    captionOverrideSetId: null,
    timelineKey: `${folder}/timeline.json`,
    captionsKey: `${folder}/captions.json`,
    mp4Key: `${folder}/output.mp4`,
    thumbnailKey: `${folder}/thumbnail.jpg`,
    qaKey: `${folder}/qa.json`,
    previewFrameKeys: [],
    renderInputHash: `sha256:${"c".repeat(64)}`,
    mp4Sha256: MP4,
    qa: {},
    status: "ready",
    metrics: { renderMs: 1000, bundleMs: 1000, bytes: 1000, durationMs: 72_000, frames: 0 },
    error: null,
    createdAt: now,
    readyAt: now,
  };
  await db.collection<RenderDocument>("renders").insertOne(render);
  const plan = JSON.parse(readFileSync("fixtures/water-cycle.plan.json", "utf8"));
  Object.assign(plan, { projectId: projectId.toHexString(), ownerId: ownerId.toHexString(), versionId: planVersionId.toHexString(), parentVersionId: null });
  await db.collection("planVersions").insertOne({
    _id: planVersionId,
    ownerId,
    projectId,
    schemaVersion: 1,
    versionNumber: 1,
    parentVersionId: null,
    source: "ai_plan",
    plan,
    planHash: `sha256:${"1".repeat(64)}`,
    validation: { valid: true, issues: [], warnings: [] },
    stats: { sceneCount: plan.scenes.length, wordCount: 150, estimatedSeconds: 72 },
    plannerUsage: null,
    createdAt: now,
  });
  return { projectId: projectId.toHexString(), renderId: renderId.toHexString(), planVersionId };
}

/** G2 → stand-in → G3 with a chosen account name; returns where the callback sends the creator. */
async function connectAs(t: Tester, projectId: string, account: string): Promise<string> {
  const start = await get(t.cookie, `/api/v1/instagram/connect?returnTo=${encodeURIComponent(`publish:${projectId}`)}`);
  const state = start.location ? (new URL(start.location, base).searchParams.get("state") ?? "") : "";
  const done = await get(t.cookie, `/api/v1/instagram/callback?${new URLSearchParams({ code: `e2e.creator.${account}`, state }).toString()}`);
  return done.location;
}
const connect = async (t: Tester, projectId: string) => (await connectAs(t, projectId, `${t.label}${tag}`)).includes("instagram=connected");

const projects = () => db.collection<ProjectDocument>("projects");
const posts = () => db.collection<PostDocument>("posts");
const projectDoc = (id: string) => projects().findOne({ _id: new ObjectId(id) });
const postDoc = (id: string) => posts().findOne({ _id: new ObjectId(id) });
const jobDoc = (id: ObjectId | string | null | undefined) => (id ? db.collection("jobs").findOne({ _id: typeof id === "string" ? new ObjectId(id) : id }) : Promise.resolve(null));
const connectionIdOf = async (t: Tester) => (await db.collection("instagramConnections").findOne({ ownerId: t.id }))!._id.toHexString();
const notes = (t: Tester, type: string, postId: string) => db.collection("notifications").countDocuments({ ownerId: t.id, type, postId: new ObjectId(postId) });
const audits = (action: string, postId: string) => db.collection("auditLogs").countDocuments({ action, "subject.id": new ObjectId(postId) });
const liveReels = (caption: string) => db.collection("e2eFakeInstagram").countDocuments({ kind: "media", caption: caption.trim() });
const containersFor = (caption: string) => db.collection("e2eFakeInstagram").countDocuments({ kind: "container", caption: caption.trim() });
const attemptsOf = (postId: string) => db.collection("publishAttempts").countDocuments({ postId: new ObjectId(postId) });

type Body = { mode: string; renderId: string; mp4Sha256: string; connectionId: string; caption: string; expectedStateVersion: number; scheduledAt?: string };
const h2 = (t: Tester, projectId: string, body: Partial<Body> & Record<string, unknown>, idem: string | null = key()) =>
  send(t.cookie, "POST", `/api/v1/projects/${projectId}/posts`, body, idem ? { "idempotency-key": idem } : {});
const h5 = (t: Tester, postId: string) => send(t.cookie, "POST", `/api/v1/posts/${postId}/cancel`, {});
const h6 = (t: Tester, postId: string) => send(t.cookie, "POST", `/api/v1/posts/${postId}/retry`, {}, { "idempotency-key": key() });
const h7 = (t: Tester, projectId: string, text: string) => send(t.cookie, "PUT", `/api/v1/projects/${projectId}/caption-draft`, { text });

const STEP = 5 * 60_000;
/** A time H2 accepts: about `minutes` from now, on a 5-minute step, as ISO with +05:30 (what the page sends). */
function allowedTime(minutes = 20): { iso: string; at: Date } {
  const at = new Date(Math.ceil((Date.now() + minutes * 60_000) / STEP) * STEP);
  const ist = new Date(at.getTime() + 330 * 60_000).toISOString();
  return { iso: `${ist.slice(0, 16)}:00+05:30`, at };
}

async function bodyFor(t: Tester, p: Seeded, caption: string, mode: "now" | "scheduled" = "scheduled", minutes = 20): Promise<Body> {
  return {
    mode,
    renderId: p.renderId,
    mp4Sha256: MP4,
    connectionId: await connectionIdOf(t),
    caption,
    expectedStateVersion: (await projectDoc(p.projectId))!.stateVersion,
    ...(mode === "scheduled" ? { scheduledAt: allowedTime(minutes).iso } : {}),
  };
}

/** H2 Schedule; returns the answer and the post id. */
async function schedule(t: Tester, p: Seeded, caption: string): Promise<{ status: number; json: Json; postId: string }> {
  const r = await h2(t, p.projectId, await bodyFor(t, p, caption));
  return { ...r, postId: r.json.post?.id ?? "" };
}

/**
 * The TEST-ONLY time shift: the post's time moves to `when` in the test database, and the same job is
 * handed to the private Inngest again (new event id). Returns Inngest's id of that event.
 */
async function shiftAndRedeliver(postId: string, when: Date | null): Promise<string | null> {
  const post = await postDoc(postId);
  if (!post?.jobId) return null;
  // `when` null: no shift, only one more delivery of the same job (a second run).
  if (when) await posts().updateOne({ _id: post._id }, { $set: { scheduledAt: when } });
  const job = await jobDoc(post.jobId);
  const r = await fetch(`${INNGEST}/e/f31-e2e`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "post.publish.requested",
      id: `f31-shift-${randomBytes(8).toString("hex")}`,
      data: { jobId: post.jobId.toHexString(), projectId: post.projectId.toHexString(), ownerId: post.ownerId.toHexString(), attempt: job?.attempt ?? 1, postId },
    }),
  });
  const json = (await r.json().catch(() => ({}))) as { ids?: string[] };
  return json.ids?.[0] ?? null;
}

/** The finished run(s) of an event on the private Inngest: [{ status }] once every run is done (the Dev Server keeps no output). */
async function runsOf(eventId: string | null, timeoutMs = 90_000): Promise<{ status: string; output: unknown }[]> {
  if (!eventId) return [];
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await fetch(`${INNGEST}/v1/events/${eventId}/runs`).catch(() => null);
    const json = r ? ((await r.json().catch(() => ({}))) as { data?: { status?: string; output?: unknown }[] }) : {};
    const runs = (json.data ?? []).map((x) => ({ status: String(x.status ?? ""), output: x.output }));
    if (runs.length > 0 && runs.every((x) => /completed|failed|cancelled/i.test(x.status))) return runs;
    await sleep(1000);
  }
  return [];
}
/** Every run of the event finished normally (a quiet end, a missed post and a publish all complete). */
const completed = (runs: { status: string }[]) => runs.length > 0 && runs.every((r) => r.status === "Completed");
const statusOf = (runs: { status: string }[]) => runs.map((r) => r.status).join(",") || "no run";

/** Waits until the post leaves the given states. */
async function settled(postId: string, leaving: string[] = ["scheduled", "publishing", "outcome_unknown"], timeoutMs = 120_000): Promise<PostDocument | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const post = await postDoc(postId);
    if (post && !leaving.includes(post.state)) return post;
    await sleep(500);
  }
  return postDoc(postId);
}

const soon = (seconds: number) => new Date(Date.now() + seconds * 1000);

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F23", "F28", "F30"]));
  const a = await signUp("a");
  const b = await signUp("b");
  const c = await signUp("c");
  const d = await signUp("d");

  // ---------- H2 Schedule: refusals, then a scheduled post (user A) ----------
  const pa = await seedReadyProject(a.id, "How rainbows form / F31 e2e");
  check("A connects Instagram (stand-in)", await connect(a, pa.projectId));
  const caption = "How rainbows form 🌈 #Rainbows";
  const good = await bodyFor(a, pa, caption);
  const offStep = new Date(Math.ceil((Date.now() + 30 * 60_000) / STEP) * STEP + 2 * 60_000).toISOString();
  const tooSoon = await h2(a, pa.projectId, { ...good, scheduledAt: new Date(Math.ceil((Date.now() + 2 * 60_000) / STEP) * STEP).toISOString() });
  const tooLate = await h2(a, pa.projectId, { ...good, scheduledAt: new Date(Math.ceil((Date.now() + 8 * 86_400_000) / STEP) * STEP).toISOString() });
  const notOnStep = await h2(a, pa.projectId, { ...good, scheduledAt: offStep });
  const { scheduledAt: _omit, ...withoutTime } = good;
  const missing = await h2(a, pa.projectId, withoutTime);
  const noOffset = await h2(a, pa.projectId, { ...good, scheduledAt: good.scheduledAt!.slice(0, 19) });
  check("H2 Schedule 2 minutes away → 400 'at least 10 minutes'", tooSoon.status === 400 && tooSoon.json.error?.message === SCHEDULE_MESSAGES.TOO_SOON && tooSoon.json.error?.details?.issues?.[0]?.path === "scheduledAt", `${tooSoon.status} ${tooSoon.json.error?.message}`);
  check("H2 Schedule 8 days away → 400 'within the next 7 days'", tooLate.status === 400 && tooLate.json.error?.message === SCHEDULE_MESSAGES.TOO_LATE, `${tooLate.status}`);
  check("H2 Schedule off the 5-minute step → 400 (refused, not rounded)", notOnStep.status === 400 && notOnStep.json.error?.message === SCHEDULE_MESSAGES.NOT_ON_STEP, `${notOnStep.status}`);
  check("H2 Schedule without scheduledAt, or without an offset → 400", missing.status === 400 && noOffset.status === 400 && JSON.stringify(missing.json).includes("is required for scheduled posts"), `${missing.status} ${noOffset.status}`);
  check("none of the refusals saved a post or changed the project", (await posts().countDocuments({ ownerId: a.id })) === 0 && (await projectDoc(pa.projectId))?.state === "video_ready" && (await projectDoc(pa.projectId))?.stateVersion === 5);

  const goodTime = allowedTime(20);
  const ok = await h2(a, pa.projectId, { ...good, scheduledAt: goodTime.iso });
  const aPostId = ok.json.post?.id ?? "";
  const aPost = await postDoc(aPostId);
  const aProject = await projectDoc(pa.projectId);
  const aJob = await jobDoc(aPost?.jobId);
  check(
    "H2 Schedule → 202: post scheduled (mode scheduled, scheduledAt in UTC, attempts 0); project scheduled with NO active job; job queued 'Scheduled for …'",
    ok.status === 202 &&
      ok.json.post?.state === "scheduled" &&
      ok.json.post?.scheduledAt === goodTime.at.toISOString() &&
      aPost?.mode === "scheduled" &&
      aPost.attempts === 0 &&
      aProject?.state === "scheduled" &&
      aProject.activeJobId === null &&
      ok.json.project?.allowedActions?.includes("cancel_post") &&
      aJob?.state === "queued" &&
      aJob.progress?.message === `Scheduled for ${istDateTimeLabel(goodTime.at)}` &&
      (await audits("post.approved", aPostId)) === 1,
    `${ok.status} ${ok.json.post?.state} ${aProject?.state} ${aJob?.progress?.message}`,
  );
  const second = await h2(a, pa.projectId, await bodyFor(a, pa, caption));
  check("a second approval while one is scheduled → 409 INVALID_STATE (one post on its way)", second.status === 409 && second.json.error?.code === "INVALID_STATE", `${second.status} ${second.json.error?.code}`);

  const page = await get(a.cookie, `/projects/${pa.projectId}/publish`);
  check(
    "Step 4 Scheduled view: 'Scheduled for <IST time>', @account, the approved caption, Change time, Cancel schedule; no Publish button",
    page.status === 200 &&
      page.text.includes('data-testid="publish-scheduled"') &&
      page.text.includes(`Scheduled for ${istDateTimeLabel(goodTime.at)}`) &&
      page.text.includes(`@e2e_a${tag}`) &&
      page.text.includes("How rainbows form 🌈 #Rainbows") &&
      page.text.includes("Change time") &&
      page.text.includes("Cancel schedule") &&
      !page.text.includes('data-testid="publish-now"'),
    String(page.status),
  );
  const c3 = await send(a.cookie, "GET", `/api/v1/projects/${pa.projectId}`);
  const c1 = await send(a.cookie, "GET", "/api/v1/projects?tab=scheduled");
  const dash = await get(a.cookie, "/dashboard?tab=scheduled");
  check(
    "C3 allowedActions has cancel_post (not publish); C1 Scheduled tab carries the post's time; the card shows it in IST",
    c3.json.allowedActions?.includes("cancel_post") &&
      !c3.json.allowedActions?.includes("publish") &&
      c1.json.items?.[0]?.latestPost?.scheduledAt === goodTime.at.toISOString() &&
      dash.text.includes('data-testid="card-scheduled-at"') &&
      dash.text.includes(`Posts ${istDateTimeLabel(goodTime.at)}`),
    `${JSON.stringify(c3.json.allowedActions)} ${c1.json.items?.length}`,
  );
  const h4early = await send(a.cookie, "GET", `/api/v1/posts/${aPostId}`);
  check("reads before the time change nothing (not stuck, not missed)", h4early.status === 200 && h4early.json.state === "scheduled" && (await jobDoc(aPost?.jobId))?.state === "queued");

  // At its time (test-only shift to 15 s from now): it posts EXACTLY ONE reel.
  const aEvent = await shiftAndRedeliver(aPostId, soon(15));
  const aDone = await settled(aPostId);
  const aRuns = await runsOf(aEvent);
  check(
    "at its time the job wakes and posts: published, EXACTLY ONE reel and ONE container, attempts 1, project published, notification",
    aDone?.state === "published" &&
      aDone.igMediaId !== null &&
      aDone.attempts === 1 &&
      (await liveReels(caption)) === 1 &&
      (await containersFor(caption)) === 1 &&
      (await projectDoc(pa.projectId))?.state === "published" &&
      (await notes(a, "post_published", aPostId)) === 1 &&
      completed(aRuns),
    `${aDone?.state} reels=${await liveReels(caption)} runs=${statusOf(aRuns)}`,
  );
  const cancelPublished = await h5(a, aPostId);
  check("H5 on a published post → 409 INVALID_STATE", cancelPublished.status === 409 && cancelPublished.json.error?.code === "INVALID_STATE", String(cancelPublished.status));

  // ---------- H5 Cancel (user B) ----------
  const pb = await seedReadyProject(b.id, "How tides work / F31 e2e");
  check("B connects Instagram (stand-in)", await connect(b, pb.projectId));
  const bCaption = "How tides work 🌊 #Tides";
  const bSched = await schedule(b, pb, bCaption);
  const otherUser = await h5(a, bSched.postId);
  const cancel1 = await h5(b, bSched.postId);
  const bPost = await postDoc(bSched.postId);
  const bProject = await projectDoc(pb.projectId);
  check("H5 by another user → 404", otherUser.status === 404, String(otherUser.status));
  check(
    "H5 Cancel schedule → 200: post cancelled, its waiting job cancelled, project back to video_ready (+1), audit post.cancelled",
    bSched.status === 202 &&
      cancel1.status === 200 &&
      cancel1.json.state === "cancelled" &&
      bPost?.state === "cancelled" &&
      (await jobDoc(bPost.jobId))?.state === "cancelled" &&
      bProject?.state === "video_ready" &&
      bProject.stateVersion === 7 &&
      (await audits("post.cancelled", bSched.postId)) === 1,
    `${cancel1.status} ${bPost?.state} ${bProject?.state} v${bProject?.stateVersion}`,
  );
  const cancel2 = await h5(b, bSched.postId);
  check("H5 again on the cancelled post → 200 with the post, nothing changes", cancel2.status === 200 && cancel2.json.state === "cancelled" && (await audits("post.cancelled", bSched.postId)) === 1 && (await projectDoc(pb.projectId))?.stateVersion === 7);
  const bEvent = await shiftAndRedeliver(bSched.postId, soon(3));
  const bRuns = await runsOf(bEvent);
  check(
    "the cancelled post's run wakes and ends quietly: no container, no reel, no Instagram call",
    completed(bRuns) && (await containersFor(bCaption)) === 0 && (await liveReels(bCaption)) === 0 && (await attemptsOf(bSched.postId)) === 0 && (await postDoc(bSched.postId))?.state === "cancelled",
    statusOf(bRuns),
  );
  // Change time = cancel + the form with Schedule chosen at the old time and the caption kept.
  const changePage = await get(b.cookie, `/projects/${pb.projectId}/publish?when=schedule&at=${encodeURIComponent(allowedTime(30).at.toISOString())}`);
  check(
    "Change time: the form opens with Schedule chosen (DATE + TIME (IST), the 10 minutes–7 days line), the caption kept, 'Schedule post'",
    changePage.status === 200 &&
      changePage.text.includes('data-testid="schedule-picker"') &&
      changePage.text.includes("Between 10 minutes and 7 days from now. Shown in India time (IST).") &&
      changePage.text.includes("Time (IST)") &&
      changePage.text.includes(bCaption) &&
      changePage.text.includes("Schedule post"),
    String(changePage.status),
  );

  // H5 while publishing → 409 (a slow Publish now post on another project).
  const pslow = await seedReadyProject(b.id, "How waves break / F31 e2e");
  const slowCaption = "How waves break [e2e:slow] #Waves";
  const slow = await h2(b, pslow.projectId, await bodyFor(b, pslow, slowCaption, "now"));
  const cancelPublishing = await h5(b, slow.json.post?.id ?? "");
  check("H5 while the post is being published → 409 'being published right now'", slow.status === 202 && cancelPublishing.status === 409 && cancelPublishing.json.error?.message === POST_MESSAGES.CANCEL_PUBLISHING, `${slow.status} ${cancelPublishing.status}`);
  await settled(slow.json.post?.id ?? "");

  // An expired token at the time → INSTAGRAM_TOKEN_EXPIRED; reconnect the same account; Try again posts once.
  const ptok = await seedReadyProject(b.id, "How currents flow / F31 e2e");
  const tokCaption = "How currents flow #Currents";
  const tokSched = await schedule(b, ptok, tokCaption);
  await db.collection("instagramConnections").updateOne({ ownerId: b.id }, { $set: { tokenExpiresAt: new Date(Date.now() - 60_000) } });
  await shiftAndRedeliver(tokSched.postId, soon(3));
  const tokFailed = await settled(tokSched.postId);
  check(
    "token expired at the time → publish_failed INSTAGRAM_TOKEN_EXPIRED (retryable), nothing sent",
    tokFailed?.state === "publish_failed" && tokFailed.lastError?.code === "INSTAGRAM_TOKEN_EXPIRED" && (await containersFor(tokCaption)) === 0 && (await projectDoc(ptok.projectId))?.state === "publish_failed",
    `${tokFailed?.state} ${tokFailed?.lastError?.code}`,
  );
  check("B reconnects the same account", await connect(b, ptok.projectId));
  const tokRetry = await h6(b, tokSched.postId);
  const tokDone = await settled(tokSched.postId, ["publishing", "outcome_unknown"]);
  check("Try again after reconnecting the same account keeps the approval → published, ONE reel", tokRetry.status === 202 && tokDone?.state === "published" && (await liveReels(tokCaption)) === 1, `${tokRetry.status} ${tokDone?.state}`);

  // ---------- each kind of change cancels the approval at once (user C) ----------
  const pc1 = await seedReadyProject(c.id, "How volcanoes erupt / F31 e2e");
  check("C connects Instagram (stand-in)", await connect(c, pc1.projectId));

  /** Schedule, make the change, then wake the run: nothing may be posted. */
  async function changeCase(label: string, p: Seeded, captionText: string, change: () => Promise<{ status: number }>, expect: { state: string; reason?: string }, beforeTheTime?: (postId: string) => Promise<void>) {
    const sched = await schedule(c, p, captionText);
    const changed = await change();
    const after = await postDoc(sched.postId);
    const job = await jobDoc(after?.jobId);
    if (beforeTheTime) await beforeTheTime(sched.postId);
    const event = await shiftAndRedeliver(sched.postId, soon(3));
    const runs = await runsOf(event);
    check(
      `${label} → ${expect.state}${expect.reason ? ` (${expect.reason})` : ""} at once${expect.reason ? " + notification" : ""}, its job cancelled; at the time nothing is posted`,
      sched.status === 202 &&
        changed.status < 300 &&
        after?.state === expect.state &&
        (expect.reason ? after.invalidatedReason === expect.reason && (await notes(c, "approval_invalidated", sched.postId)) === 1 : true) &&
        job?.state === "cancelled" &&
        completed(runs) &&
        (await containersFor(captionText)) === 0 &&
        (await liveReels(captionText)) === 0,
      `${sched.status} ${changed.status} ${after?.state} ${after?.invalidatedReason} job=${job?.state} run=${statusOf(runs)}`,
    );
    return sched.postId;
  }

  // H7 caption edit (the project stays scheduled), then the Needs approval view and approving again.
  const h7Caption = "How volcanoes erupt 🌋 #Volcanoes";
  const needsApprovalView = async (postId: string) => {
    const due = (await postDoc(postId))!.scheduledAt!;
    const needs = await get(c.cookie, `/projects/${pc1.projectId}/publish`);
    check(
      "the Needs approval view: badge, 'Needs approval: you changed the caption', the time, Schedule chosen, Cancel schedule, 'Approve and schedule'",
      needs.status === 200 &&
        needs.text.includes('data-testid="publish-banner"') &&
        needs.text.includes("Needs approval: you changed the caption") &&
        needs.text.includes(`Your post for ${istDateTimeLabel(due)} won't go out until you approve this new version.`) &&
        needs.text.includes('data-testid="schedule-picker"') &&
        needs.text.includes('data-testid="publish-cancel-schedule"') &&
        needs.text.includes("Approve and schedule"),
      String(needs.status),
    );
  };
  const h7Post = await changeCase("a caption edit (H7)", pc1, h7Caption, () => h7(c, pc1.projectId, "How volcanoes REALLY erupt 🌋 #Volcanoes"), { state: "approval_invalidated", reason: "caption_edit" }, needsApprovalView);
  const c3c = await send(c.cookie, "GET", `/api/v1/projects/${pc1.projectId}`);
  check("C3 allowedActions offers publish and cancel_post", c3c.json.allowedActions?.includes("publish") && c3c.json.allowedActions?.includes("cancel_post"), JSON.stringify(c3c.json.allowedActions));
  const newCaption = "How volcanoes REALLY erupt 🌋 #Volcanoes";
  const again = await schedule(c, pc1, newCaption);
  const againEvent = await shiftAndRedeliver(again.postId, soon(5));
  const againDone = await settled(again.postId);
  await runsOf(againEvent);
  check(
    "approving again (Schedule) → a NEW post; the old one cancelled; at its time EXACTLY ONE reel",
    again.status === 202 && again.postId !== h7Post && (await postDoc(h7Post))?.state === "cancelled" && againDone?.state === "published" && (await liveReels(newCaption)) === 1 && (await liveReels(h7Caption)) === 0,
    `${again.status} ${againDone?.state}`,
  );

  // D3 narration edit, D4 voice.
  const pc2 = await seedReadyProject(c.id, "How earthquakes happen / F31 e2e");
  await changeCase(
    "a narration edit (D3)",
    pc2,
    "How earthquakes happen #Earthquakes",
    async () =>
      send(c.cookie, "POST", `/api/v1/projects/${pc2.projectId}/narration-edits`, {
        basePlanVersionId: pc2.planVersionId.toHexString(),
        sceneId: "scene-hook",
        blocks: [{ narrationId: "line-hook-question", text: "Why does the ground shake, and where does it start?" }],
        expectedStateVersion: (await projectDoc(pc2.projectId))!.stateVersion,
      }),
    { state: "approval_invalidated", reason: "narration_edit" },
  );
  const pc3 = await seedReadyProject(c.id, "How glaciers move / F31 e2e");
  await changeCase(
    "a voice switch (D4)",
    pc3,
    "How glaciers move #Glaciers",
    async () => send(c.cookie, "POST", `/api/v1/projects/${pc3.projectId}/voice`, { basePlanVersionId: pc3.planVersionId.toHexString(), voiceGender: "male", expectedStateVersion: (await projectDoc(pc3.projectId))!.stateVersion }),
    { state: "approval_invalidated", reason: "voice_switch" },
  );
  // C5 archive → cancelled.
  const pc4 = await seedReadyProject(c.id, "How deserts form / F31 e2e");
  await changeCase(
    "archiving the project (C5)",
    pc4,
    "How deserts form #Deserts",
    async () => send(c.cookie, "DELETE", `/api/v1/projects/${pc4.projectId}`, undefined, { "if-match": `"${(await projectDoc(pc4.projectId))!.stateVersion}"` }),
    { state: "cancelled" },
  );
  // G3 another Instagram account.
  const pc5 = await seedReadyProject(c.id, "How caves form / F31 e2e");
  await changeCase("connecting ANOTHER Instagram account (G3)", pc5, "How caves form #Caves", async () => ({ status: (await connectAs(c, pc5.projectId, `other${tag}`)).includes("instagram=connected") ? 200 : 500 }), {
    state: "approval_invalidated",
    reason: "instagram_account_changed",
  });
  // G4 Disconnect, then reconnect and approve again with Publish now.
  const pc6 = await seedReadyProject(c.id, "How rivers bend / F31 e2e");
  const g4Post = await changeCase("Disconnect (G4)", pc6, "How rivers bend #Rivers", () => send(c.cookie, "DELETE", "/api/v1/instagram/connection"), { state: "approval_invalidated", reason: "instagram_disconnected" });
  check("C connects Instagram again", await connect(c, pc6.projectId));
  const nowCaption = "How rivers bend, now #Rivers";
  const nowAgain = await h2(c, pc6.projectId, await bodyFor(c, pc6, nowCaption, "now"));
  const nowDone = await settled(nowAgain.json.post?.id ?? "", ["publishing", "outcome_unknown"]);
  check(
    "approving again with Publish now (project still scheduled, its post needed approval) → published, EXACTLY ONE reel; the old post cancelled",
    nowAgain.status === 202 && nowDone?.state === "published" && (await liveReels(nowCaption)) === 1 && (await postDoc(g4Post))?.state === "cancelled",
    `${nowAgain.status} ${nowDone?.state}`,
  );

  // ---------- missed (user D) ----------
  const pd1 = await seedReadyProject(d.id, "How stars shine / F31 e2e");
  check("D connects Instagram (stand-in)", await connect(d, pd1.projectId));
  // (a) the job wakes more than 1 hour late.
  const missCaption = "How stars shine ✨ #Stars";
  const miss = await schedule(d, pd1, missCaption);
  const missEvent = await shiftAndRedeliver(miss.postId, new Date(Date.now() - 61 * 60_000));
  const missRuns = await runsOf(missEvent);
  const missed = await postDoc(miss.postId);
  const missedNote = await db.collection("notifications").findOne({ ownerId: d.id, type: "post_failed", postId: new ObjectId(miss.postId) });
  check(
    "woke more than 1 hour late → never posted: publish_failed SCHEDULE_MISSED (not retryable), job failed, project publish_failed, a 'missed its time' notification",
    completed(missRuns) &&
      missed?.state === "publish_failed" &&
      missed.lastError?.code === "SCHEDULE_MISSED" &&
      (await jobDoc(missed.jobId))?.error?.retryable === false &&
      (await projectDoc(pd1.projectId))?.state === "publish_failed" &&
      String(missedNote?.title).includes("missed its time") &&
      (await containersFor(missCaption)) === 0 &&
      (await liveReels(missCaption)) === 0 &&
      (await audits("post.missed", miss.postId)) === 1,
    `${statusOf(missRuns)} ${missed?.state} ${missed?.lastError?.code}`,
  );
  const missRetry = await h6(d, miss.postId);
  check("Try again on a missed post → 409 (a new approval is needed)", missRetry.status === 409 && missRetry.json.error?.details?.reason === "schedule_missed", `${missRetry.status} ${missRetry.json.error?.details?.reason}`);
  const missPage = await get(d.cookie, `/projects/${pd1.projectId}/publish`);
  const c3d = await send(d.cookie, "GET", `/api/v1/projects/${pd1.projectId}`);
  check(
    "the Missed view: 'Missed its time', 'This post was due at <date, time> IST but couldn't go out at that time. Publish now or pick a new time.', the form; allowedActions publish (no retry_post)",
    missPage.status === 200 &&
      missPage.text.includes("Missed its time") &&
      missPage.text.includes(`This post was due at ${istDateTimeLabel(missed!.scheduledAt!)} but couldn't go out at that time. Publish now or pick a new time.`) &&
      missPage.text.includes('data-testid="publish-now"') &&
      c3d.json.allowedActions?.includes("publish") &&
      !c3d.json.allowedActions?.includes("retry_post"),
    String(missPage.status),
  );
  const missAgain = await h2(d, pd1.projectId, await bodyFor(d, pd1, missCaption, "now"));
  const missAgainDone = await settled(missAgain.json.post?.id ?? "", ["publishing", "outcome_unknown"]);
  check("Publish now after the missed post → published, EXACTLY ONE reel", missAgain.status === 202 && missAgainDone?.state === "published" && (await liveReels(missCaption)) === 1, `${missAgain.status} ${missAgainDone?.state}`);

  // (b) the job never woke (e.g. Inngest forgot the sleep): the read-time rule.
  const pd2 = await seedReadyProject(d.id, "How planets orbit / F31 e2e");
  const readCaption = "How planets orbit #Planets";
  const readMiss = await schedule(d, pd2, readCaption);
  await posts().updateOne({ _id: new ObjectId(readMiss.postId) }, { $set: { scheduledAt: new Date(Date.now() - 61 * 60_000) } });
  const readH4 = await send(d.cookie, "GET", `/api/v1/posts/${readMiss.postId}`);
  check(
    "the job never woke and the time passed more than 1 hour ago: reading the post (H4) marks it missed, never posted",
    readH4.status === 200 && readH4.json.state === "publish_failed" && readH4.json.lastError?.code === "SCHEDULE_MISSED" && (await projectDoc(pd2.projectId))?.state === "publish_failed" && (await liveReels(readCaption)) === 0,
    `${readH4.json.state} ${readH4.json.lastError?.code}`,
  );

  // Up to 1 hour late still posts.
  const pd3 = await seedReadyProject(d.id, "How comets glow / F31 e2e");
  const lateCaption = "How comets glow ☄️ #Comets";
  const late = await schedule(d, pd3, lateCaption);
  const lateEvent = await shiftAndRedeliver(late.postId, new Date(Date.now() - 30 * 60_000));
  const lateDone = await settled(late.postId);
  await runsOf(lateEvent);
  check("woke 30 minutes late (within the hour) → posted normally, EXACTLY ONE reel", lateDone?.state === "published" && (await liveReels(lateCaption)) === 1, `${lateDone?.state}`);

  // ---------- code review MUST 1: a second run of an already-woken scheduled post (user D) ----------
  const pd4 = await seedReadyProject(d.id, "How auroras glow / F31 e2e");
  const twoCaption = "How auroras glow [e2e:slow] #Auroras";
  const two = await schedule(d, pd4, twoCaption);
  await shiftAndRedeliver(two.postId, soon(3));
  let woken: PostDocument | null = null;
  for (let i = 0; i < 120 && woken?.state !== "publishing"; i++) {
    woken = await postDoc(two.postId);
    if (woken?.state === "publishing") break;
    await sleep(250);
  }
  // The first run has woken the post (it is being published, slowly): a fresh event starts a SECOND run.
  const secondEvent = await shiftAndRedeliver(two.postId, null);
  const twoDone = await settled(two.postId);
  const secondRuns = await runsOf(secondEvent);
  check(
    "a second run (fresh event id) of an already-woken scheduled post ends without any Instagram call: EXACTLY ONE container and ONE reel",
    woken?.state === "publishing" && completed(secondRuns) && twoDone?.state === "published" && (await containersFor(twoCaption)) === 1 && (await liveReels(twoCaption)) === 1 && twoDone.attempts === 1,
    `${woken?.state} ${statusOf(secondRuns)} ${twoDone?.state} containers=${await containersFor(twoCaption)} reels=${await liveReels(twoCaption)}`,
  );

  // ---------- code review NICE 4: the connection ends before the time ----------
  const pd5 = await seedReadyProject(d.id, "How meteors fall / F31 e2e");
  await db.collection("instagramConnections").updateOne({ ownerId: d.id }, { $set: { tokenExpiresAt: new Date(Date.now() + 15 * 60_000) } });
  const ends = await h2(d, pd5.projectId, await bodyFor(d, pd5, "How meteors fall #Meteors", "scheduled", 20));
  await db.collection("instagramConnections").updateOne({ ownerId: d.id }, { $set: { tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) } });
  check(
    "H2 Schedule for a time after the Instagram connection ends → 409 INSTAGRAM_TOKEN_EXPIRED 'Your Instagram connection ends before this time…', nothing saved",
    ends.status === 409 && ends.json.error?.code === "INSTAGRAM_TOKEN_EXPIRED" && ends.json.error?.message === POST_MESSAGES.TOKEN_ENDS_BEFORE && ends.json.error?.details?.reason === "expires_before_schedule" && (await posts().countDocuments({ projectId: new ObjectId(pd5.projectId) })) === 0,
    `${ends.status} ${ends.json.error?.code}`,
  );

  // ---------- no secrets saved ----------
  const saved = JSON.stringify(await db.collection("publishAttempts").find({ ownerId: { $in: [a.id, b.id, c.id, d.id] } }).toArray());
  check("nothing saved holds a token or a presigned link", !saved.includes("e2e-long") && !saved.includes("X-Amz") && !saved.includes("r2.cloudflarestorage"));

  console.log(`\n${passes} passed, ${failures} failed`);
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error(error);
  })
  .finally(async () => {
    await closeMongoClient();
    process.exitCode = failures > 0 ? 1 : 0;
  });
