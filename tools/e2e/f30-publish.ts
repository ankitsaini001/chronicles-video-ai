import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  addInvite,
  closeMongoClient,
  endPublishJob,
  ensureIndexes,
  getDb,
  indexesForFeatures,
  POST_MESSAGES,
  PUBLISH_FAILURES,
  readDbConfig,
  type PostDocument,
  type ProjectDocument,
  type RenderDocument,
} from "@bytereel/db";
import { ObjectId } from "mongodb";

/**
 * F30 end-to-end check over real HTTP ("Publish now (approval #2)") with the Instagram STAND-IN
 * (E2E_FAKE_INSTAGRAM=1: ZERO calls to Meta) and a PRIVATE Inngest Dev Server on 8299 that runs the
 * real `publish-post` job. No video is made: like F28/F29 it seeds ready projects (project, render,
 * storyboard version) in the TEST database; the R2 link Meta would fetch is only signed (no request
 * to R2) and the stand-in never fetches it. The caption picks what the stand-in Instagram does
 * (apps/web/lib/instagram/fake-instagram.ts): none = works, [e2e:slow], [e2e:busy], [e2e:error],
 * [e2e:lost] (it goes live but the answer is lost), [e2e:limit] (the first media_publish hits the
 * daily limit). Its "Instagram" is the test database's `e2eFakeInstagram` collection, so this check
 * counts the reels that went live.
 *
 * It proves: signed out → 401; the Step 4 form (WHEN with Publish now, Schedule "Coming soon", the
 * approval tick, Publish now); H2 refusals (no Idempotency-Key, Schedule, another MP4, another tab,
 * another account, another user's project) save nothing; H2 → 202, a double click replays ONE post;
 * while publishing a second H2, H6 and archive are refused and the page shows the progress view;
 * published: post/job/project, the notification, the audit lines, the attempt log without token or
 * link, ONE reel on the stand-in, the Published screen with View on Instagram, H3/H4 (another user →
 * 404); slow and busy Instagram still publish; a processing error → publish_failed with the plain
 * reason and Try again; a caption change then cancels the approval (notification; Try again → 409
 * APPROVAL_STALE; the form says approve again) and a NEW approval publishes; a lost answer after
 * media_publish → reconcile → published with exactly ONE reel; the daily limit → plain message, Try
 * again → published (same container, ONE reel; a replayed Try again changes nothing); a change during
 * processing → the re-check stops it (nothing posted, approve again); a narration edit (D3), archive
 * (C5) and Disconnect (G4) cancel a failed post's approval.
 * F30 code review (MUST 1, "an unconfirmed attempt blocks every new approval"): with an "outage" on the
 * stand-in (Instagram can't be read after the publish) the job can't confirm; the check ends it
 * "unconfirmed" exactly like the stuck-job rule would (endPublishJob). While it is in flight, connecting
 * ANOTHER account (G3) is refused. Then a caption edit and a narration edit cancel the approval, yet a
 * new approval (H2) is refused with "Tap Check again first"; the page shows Check again. (A) It went
 * live: Check again (H6, reads only) saves it as published, still ONE reel. (B) [e2e:dropped] (nothing
 * posted): Check again proves it, approving again works and posts exactly once.
 *
 * TEMP FILES: never in /tmp. In every terminal used below, first run from the repo root:
 *   mkdir -p runs/.tmp && export TMPDIR="$PWD/runs/.tmp"
 * SAFETY: only the separate test database `bytereel_test`, ports 3230–3239 and a private Inngest on
 * 8299 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. (in runs/f30-work/inngest) npx --yes inngest-cli@1.49.0 dev --no-discovery -u http://localhost:3236/api/inngest --port 8299 \
 *        --connect-gateway-port 8298 --connect-gateway-grpc-port 50062 --connect-executor-grpc-port 50063
 *   3. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3236 E2E_FAKE_INSTAGRAM=1 E2E_FAKE_GEMINI=1 \
 *        E2E_FAKE_ELEVENLABS=1 INNGEST_DEV=http://localhost:8299 TOKEN_ENCRYPTION_KEYS='{"1":"<openssl rand -base64 32>"}' \
 *        TOKEN_ENCRYPTION_ACTIVE_VERSION=1 REMOTION_SERVE_PORT=3240 npx next start -p 3236
 *      (this check renders nothing; REMOTION_SERVE_PORT keeps any render on the same server off the founder's 3000/3200)
 *   4. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3236 npx tsx tools/e2e/f30-publish.ts
 *   5. stop the server and Inngest (by their pids) and drop the bytereel_test database afterwards.
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has E2E_FAKE_INSTAGRAM=1, MONGODB_DB=bytereel_test and INNGEST_DEV on port 8299.
 * Tokens and presigned links are never printed.
 */

const TEST_DB = "bytereel_test";
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
if (env.get("E2E_FAKE_INSTAGRAM") !== "1" || env.get("MONGODB_DB") !== TEST_DB || env.get("INNGEST_DEV") !== "http://localhost:8299") {
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
const key = () => `f30-${randomBytes(12).toString("hex")}`;
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
  const email = `f30-e2e-${label}-${tag}@example.com`;
  const password = `E2e-${randomBytes(9).toString("base64url")}`;
  await addInvite(db, email, { note: "F30 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ name: `F30 Tester ${label}`, email, password }) });
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

/** Connect a Creator account through the Instagram stand-in (G2 → stand-in → G3). */
async function connect(t: Tester, projectId: string): Promise<boolean> {
  return (await connectAs(t, projectId, `${t.label}${tag}`)).includes("instagram=connected");
}
/** G2 → stand-in → G3 with a chosen account name; returns where the callback sends the creator. */
async function connectAs(t: Tester, projectId: string, account: string): Promise<string> {
  const start = await get(t.cookie, `/api/v1/instagram/connect?returnTo=${encodeURIComponent(`publish:${projectId}`)}`);
  const state = start.location ? (new URL(start.location, base).searchParams.get("state") ?? "") : "";
  const done = await get(t.cookie, `/api/v1/instagram/callback?${new URLSearchParams({ code: `e2e.creator.${account}`, state }).toString()}`);
  return done.location;
}

const projects = () => db.collection<ProjectDocument>("projects");
const posts = () => db.collection<PostDocument>("posts");
const projectDoc = (id: string) => projects().findOne({ _id: new ObjectId(id) });
const postDoc = (id: string) => posts().findOne({ _id: new ObjectId(id) });
const postsOf = (projectId: string) => posts().find({ projectId: new ObjectId(projectId) }).sort({ createdAt: 1 }).toArray();
const jobDoc = (id: ObjectId | string) => db.collection("jobs").findOne({ _id: typeof id === "string" ? new ObjectId(id) : id });
const connectionIdOf = async (t: Tester) => (await db.collection("instagramConnections").findOne({ ownerId: t.id }))!._id.toHexString();
const notes = (t: Tester, type: string, postId: string) => db.collection("notifications").countDocuments({ ownerId: t.id, type, postId: new ObjectId(postId) });
const audits = (action: string, postId: string) => db.collection("auditLogs").countDocuments({ action, "subject.id": new ObjectId(postId) });
const attempts = (postId: string) => db.collection("publishAttempts").find({ postId: new ObjectId(postId) }).sort({ at: 1 }).toArray();
/** Reels that went live on the stand-in Instagram with this caption (the job sends the caption trimmed). */
const liveReels = (caption: string) => db.collection("e2eFakeInstagram").countDocuments({ kind: "media", caption: caption.trim() });
const containersFor = (caption: string) => db.collection("e2eFakeInstagram").find({ kind: "container", caption: caption.trim() }).toArray();

type Body = { mode: string; renderId: string; mp4Sha256: string; connectionId: string; caption: string; expectedStateVersion: number; scheduledAt?: string };
const h2 = (t: Tester, projectId: string, body: Partial<Body> & Record<string, unknown>, idem: string | null = key()) =>
  send(t.cookie, "POST", `/api/v1/projects/${projectId}/posts`, body, idem ? { "idempotency-key": idem } : {});
const h6 = (t: Tester, postId: string, idem: string = key()) => send(t.cookie, "POST", `/api/v1/posts/${postId}/retry`, {}, { "idempotency-key": idem });
const h7 = (t: Tester, projectId: string, text: string) => send(t.cookie, "PUT", `/api/v1/projects/${projectId}/caption-draft`, { text });

async function bodyFor(t: Tester, p: Seeded, caption: string): Promise<Body> {
  return { mode: "now", renderId: p.renderId, mp4Sha256: MP4, connectionId: await connectionIdOf(t), caption, expectedStateVersion: (await projectDoc(p.projectId))!.stateVersion };
}

/** Waits until the post leaves `publishing` / `outcome_unknown` (the stand-in answers in about 1 s per step). */
async function settled(postId: string, timeoutMs = 120_000): Promise<PostDocument | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const post = await postDoc(postId);
    if (post && post.state !== "publishing" && post.state !== "outcome_unknown") return post;
    await sleep(500);
  }
  return postDoc(postId);
}

/** Approve with H2 and wait for the outcome. */
async function publish(t: Tester, p: Seeded, caption: string): Promise<{ status: number; json: Json; post: PostDocument | null }> {
  const r = await h2(t, p.projectId, await bodyFor(t, p, caption));
  const post = r.status === 202 ? await settled(r.json.post.id) : null;
  return { ...r, post };
}

/** Nothing saved for the job holds the token or the presigned link. */
async function noSecrets(postId: string, jobId: ObjectId | null): Promise<boolean> {
  const saved = JSON.stringify([await attempts(postId), jobId ? await jobDoc(jobId) : null, await postDoc(postId)]);
  return !saved.includes("e2e-long") && !saved.includes("X-Amz") && !saved.includes("r2.cloudflarestorage");
}

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F23", "F28", "F30"]));
  const a = await signUp("a");
  const b = await signUp("b");
  const c = await signUp("c");
  const d = await signUp("d");
  const e = await signUp("e");

  // ---------- signed out ----------
  const someId = new ObjectId().toHexString();
  const out2 = await send("", "POST", `/api/v1/projects/${someId}/posts`, {}, { "idempotency-key": key() });
  const out6 = await send("", "POST", `/api/v1/posts/${someId}/retry`, {}, { "idempotency-key": key() });
  const out4 = await send("", "GET", `/api/v1/posts/${someId}`);
  check("signed out: H2, H6 and H4 → 401", out2.status === 401 && out6.status === 401 && out4.status === 401, `${out2.status} ${out6.status} ${out4.status}`);

  // ---------- the Step 4 form and H2's refusals (user B, on B's own project) ----------
  const pb = await seedReadyProject(b.id, "Photosynthesis / F30 e2e");
  check("B connects Instagram (stand-in)", await connect(b, pb.projectId));
  const form = await get(b.cookie, `/projects/${pb.projectId}/publish`);
  check(
    "Step 4: WHEN with Publish now and Schedule 'Coming soon', the approval tick naming the video version and @account, Publish now",
    form.status === 200 &&
      form.text.includes('data-testid="when-now"') &&
      form.text.includes('data-testid="when-schedule"') &&
      form.text.includes("Coming soon") &&
      form.text.includes('data-testid="publish-approve"') &&
      form.text.includes(`I approve posting video version 1 to @e2e_b${tag}.`) &&
      form.text.includes('data-testid="publish-now"') &&
      !form.text.includes("Publishing comes next"),
    String(form.status),
  );
  const good = await bodyFor(b, pb, "How plants eat sunlight 🌱 #Photosynthesis");
  const noKey = await h2(b, pb.projectId, good, null);
  const scheduled = await h2(b, pb.projectId, { ...good, mode: "scheduled", scheduledAt: "2026-12-01T10:00:00Z" });
  const otherMp4 = await h2(b, pb.projectId, { ...good, mp4Sha256: `sha256:${"e".repeat(64)}` });
  const otherTab = await h2(b, pb.projectId, { ...good, expectedStateVersion: 4 });
  const otherAccount = await h2(b, pb.projectId, { ...good, connectionId: new ObjectId().toHexString() });
  const pa = await seedReadyProject(a.id, "How rainbows form / F30 e2e");
  const foreign = await h2(b, pa.projectId, good);
  check("H2 without an Idempotency-Key → 400", noKey.status === 400, `${noKey.status} ${noKey.json.error?.code}`);
  check("H2 Schedule → 400 with 'Scheduling is coming soon'", scheduled.status === 400 && JSON.stringify(scheduled.json).includes("Scheduling is coming soon"), String(scheduled.status));
  check("H2 another MP4 → 409 APPROVAL_STALE mp4_hash_mismatch", otherMp4.status === 409 && otherMp4.json.error?.code === "APPROVAL_STALE" && otherMp4.json.error.details?.reason === "mp4_hash_mismatch", `${otherMp4.status} ${otherMp4.json.error?.code}`);
  check("H2 from another tab (old stateVersion) → 409 STALE_VERSION", otherTab.status === 409 && otherTab.json.error?.code === "STALE_VERSION", `${otherTab.status} ${otherTab.json.error?.code}`);
  check("H2 another Instagram connection → 409 APPROVAL_STALE connection_changed", otherAccount.status === 409 && otherAccount.json.error?.details?.reason === "connection_changed", `${otherAccount.status}`);
  check("H2 on another user's project → 404", foreign.status === 404, String(foreign.status));
  check(
    "none of the refusals saved a post, a job or a state change",
    (await posts().countDocuments({ ownerId: { $in: [a.id, b.id] } })) === 0 && (await projectDoc(pb.projectId))?.state === "video_ready" && (await projectDoc(pb.projectId))?.stateVersion === 5,
  );

  // ---------- Publish now: the happy path (user A) ----------
  check("A connects Instagram (stand-in)", await connect(a, pa.projectId));
  const captionA = "Where rainbows come from 🌈\n\n#Rainbows #Physics";
  const bodyA = await bodyFor(a, pa, captionA);
  const idemA = key();
  const [first, double] = await Promise.all([h2(a, pa.projectId, bodyA, idemA), sleep(150).then(() => h2(a, pa.projectId, bodyA, idemA))]);
  const postIdA: string = first.json.post?.id ?? "";
  check(
    "H2 → 202: post publishing with its approval (video, MP4, account, caption hash), job queued, project publishing (+1 stateVersion)",
    first.status === 202 &&
      first.json.post?.state === "publishing" &&
      first.json.post.approval?.mp4Sha256 === MP4 &&
      first.json.post.approval.renderId === pa.renderId &&
      /^sha256:[0-9a-f]{64}$/.test(first.json.post.approval.captionHash) &&
      first.json.post.pollAfterMs === 2000 &&
      first.json.job?.type === "publish" &&
      first.json.project?.state === "publishing" &&
      first.json.project.stateVersion === 6,
    `${first.status} ${JSON.stringify(first.json).slice(0, 200)}`,
  );
  check(
    "a double click (same Idempotency-Key) replays the SAME post; ONE post saved",
    [200, 202, 409].includes(double.status) && (double.status === 409 ? double.json.error?.code === "IDEMPOTENCY_IN_PROGRESS" : double.json.post?.id === postIdA) && (await postsOf(pa.projectId)).length === 1,
    `${double.status} ${double.json.error?.code ?? double.json.post?.id}`,
  );
  const second = await h2(a, pa.projectId, { ...bodyA, expectedStateVersion: 6 });
  const retryWhile = await h6(a, postIdA);
  const archiveWhile = await send(a.cookie, "DELETE", `/api/v1/projects/${pa.projectId}`, undefined, { "if-match": `"${(await projectDoc(pa.projectId))!.stateVersion}"` });
  const progressPage = await get(a.cookie, `/projects/${pa.projectId}/publish`);
  check(
    "while publishing: a second H2 → 409, Try again → 409, archive → 409 (a post is on its way)",
    second.status === 409 && retryWhile.status === 409 && archiveWhile.status === 409 && ["INVALID_STATE", "JOB_ALREADY_RUNNING"].includes(archiveWhile.json.error?.code),
    `${second.status} ${retryWhile.status} ${archiveWhile.status} ${archiveWhile.json.error?.code}`,
  );
  check("while publishing: the page shows the progress view", progressPage.text.includes('data-testid="publish-progress"') || progressPage.text.includes('data-testid="published"'), String(progressPage.status));

  const doneA = await settled(postIdA);
  const projA = await projectDoc(pa.projectId);
  const jobA = doneA?.jobId ? await jobDoc(doneA.jobId) : null;
  check(
    "published: post published with the media id and permalink; job succeeded; project published, no active job",
    doneA?.state === "published" &&
      /^1791\d{13}$/.test(doneA.igMediaId ?? "") &&
      /^https:\/\/www\.instagram\.com\/reel\/E2E/.test(doneA.permalink ?? "") &&
      doneA.publishedAt instanceof Date &&
      jobA?.state === "succeeded" &&
      projA?.state === "published" &&
      projA.activeJobId === null,
    `${doneA?.state} ${jobA?.state} ${projA?.state}`,
  );
  check("exactly ONE reel went live on the stand-in Instagram", (await liveReels(captionA)) === 1, String(await liveReels(captionA)));
  check(
    "notification post_published; audit post.approved and post.published",
    (await notes(a, "post_published", postIdA)) === 1 && (await audits("post.approved", postIdA)) === 1 && (await audits("post.published", postIdA)) === 1,
  );
  const logA = await attempts(postIdA);
  check(
    "publishAttempts: create_container → poll → publish (+ permalink), and no token or presigned link saved anywhere",
    logA.map((l) => l.step).join(",").startsWith("create_container,poll") && logA.some((l) => l.step === "publish" && l.outcome === "ok") && (await noSecrets(postIdA, doneA?.jobId ?? null)),
    logA.map((l) => `${l.step}:${l.outcome}`).join(" "),
  );
  const publishedPage = await get(a.cookie, `/projects/${pa.projectId}/publish`);
  check(
    "the Published screen: 'Your reel is live!', posted to @account, View on Instagram → the post's link",
    publishedPage.text.includes("Your reel is live!") && publishedPage.text.includes(`was posted to @e2e_a${tag} on`) && publishedPage.text.includes(`href="${doneA?.permalink}"`),
    String(publishedPage.status),
  );
  const list = await send(a.cookie, "GET", `/api/v1/projects/${pa.projectId}/posts`);
  const one = await send(a.cookie, "GET", `/api/v1/posts/${postIdA}`);
  const notMine = await send(b.cookie, "GET", `/api/v1/posts/${postIdA}`);
  check("H3 lists the post; H4 returns it (pollAfterMs null); another user's H4 → 404", list.status === 200 && list.json.items?.length === 1 && one.json.state === "published" && one.json.pollAfterMs === null && notMine.status === 404, `${list.status} ${one.status} ${notMine.status}`);
  const again = await h2(a, pa.projectId, { ...bodyA, expectedStateVersion: projA!.stateVersion });
  check("H2 on a published project → 409 (already on Instagram); still ONE reel", again.status === 409 && (await liveReels(captionA)) === 1, String(again.status));

  // ---------- slow and busy Instagram (user C) ----------
  const ps = await seedReadyProject(c.id, "Why the sky is blue / F30 e2e");
  check("C connects Instagram (stand-in)", await connect(c, ps.projectId));
  const slowCaption = "Why the sky is blue [e2e:slow] #Sky";
  const slow = await publish(c, ps, slowCaption);
  const slowContainer = (await containersFor(slowCaption))[0];
  check("slow processing (IN_PROGRESS 3 times) → still published, ONE reel", slow.post?.state === "published" && (await liveReels(slowCaption)) === 1 && (slowContainer?.checks ?? 0) >= 4, `${slow.status} ${slow.post?.state} checks ${slowContainer?.checks}`);
  const pbusy = await seedReadyProject(c.id, "How tides work / F30 e2e");
  const busyCaption = "How tides work [e2e:busy] #Tides";
  const busy = await publish(c, pbusy, busyCaption);
  const busyLog = busy.post ? await attempts(busy.post._id.toHexString()) : [];
  check(
    "Instagram busy (503 twice) → retried automatically, published, ONE reel",
    busy.post?.state === "published" && busyLog.filter((l) => l.step === "create_container" && l.outcome === "error").length === 2 && (await liveReels(busyCaption)) === 1,
    `${busy.post?.state} ${busyLog.map((l) => `${l.step}:${l.outcome}`).join(" ")}`,
  );

  // ---------- a processing error, then the approval cancelled by a caption change (user C) ----------
  const perr = await seedReadyProject(c.id, "How volcanoes erupt / F30 e2e");
  const errCaption = "How volcanoes erupt [e2e:error] #Volcano";
  const err = await publish(c, perr, errCaption);
  const errId = err.post?._id.toHexString() ?? "";
  const errProject = await projectDoc(perr.projectId);
  check(
    "container ERROR → publish_failed with the plain reason (Try again); project publish_failed; notification post_failed; NOTHING posted",
    err.post?.state === "publish_failed" &&
      err.post.lastError?.message === PUBLISH_FAILURES.processing_error.message &&
      errProject?.state === "publish_failed" &&
      errProject.activeJobId === null &&
      (await notes(c, "post_failed", errId)) === 1 &&
      (await liveReels(errCaption)) === 0,
    `${err.post?.state} ${err.post?.lastError?.code}`,
  );
  const failedPage = await get(c.cookie, `/projects/${perr.projectId}/publish`);
  check("the failed view: the plain reason and Try again", failedPage.text.includes('data-testid="publish-failed"') && failedPage.text.includes("Instagram couldn't process this video") && failedPage.text.includes('data-testid="publish-retry"'));
  const edited = await h7(c, perr.projectId, "How volcanoes erupt 🌋 #Volcano");
  const invalidated = await postDoc(errId);
  check(
    "a caption change after approving → 200 and the post's approval is cancelled (approval_invalidated, caption_edit) with a notification",
    edited.status === 200 && invalidated?.state === "approval_invalidated" && invalidated.invalidatedReason === "caption_edit" && (await notes(c, "approval_invalidated", errId)) === 1,
    `${edited.status} ${invalidated?.state}`,
  );
  const staleRetry = await h6(c, errId);
  const againPage = await get(c.cookie, `/projects/${perr.projectId}/publish`);
  check("Try again on the cancelled approval → 409 APPROVAL_STALE; the page asks to approve again", staleRetry.status === 409 && staleRetry.json.error?.code === "APPROVAL_STALE" && againPage.text.includes("Needs your approval") && againPage.text.includes('data-testid="publish-now"'), `${staleRetry.status}`);
  const reapproved = await publish(c, perr, "How volcanoes erupt 🌋 #Volcano");
  check(
    "a NEW approval (H2) publishes the edited caption; the old post is cancelled; ONE reel",
    reapproved.status === 202 && reapproved.post?.state === "published" && (await postDoc(errId))?.state === "cancelled" && (await liveReels("How volcanoes erupt 🌋 #Volcano")) === 1 && reapproved.post.approval.id.toHexString() !== invalidated?.approval.id.toHexString(),
    `${reapproved.status} ${reapproved.post?.state}`,
  );

  // ---------- never twice: the answer to media_publish is lost (user D) ----------
  const plost = await seedReadyProject(d.id, "How magnets work / F30 e2e");
  check("D connects Instagram (stand-in)", await connect(d, plost.projectId));
  const lostCaption = "How magnets work [e2e:lost] #Magnets";
  const lost = await publish(d, plost, lostCaption);
  const lostLog = lost.post ? await attempts(lost.post._id.toHexString()) : [];
  const lostContainers = await containersFor(lostCaption);
  const lostJob = lost.post?.jobId ? await jobDoc(lost.post.jobId) : null;
  check(
    "lost answer after media_publish → outcome_unknown → reconcile found it → published with its media id; EXACTLY ONE reel, ONE publish call",
    lost.post?.state === "published" &&
      lost.post.igMediaId !== null &&
      (await liveReels(lostCaption)) === 1 &&
      lostContainers.length === 1 &&
      lostContainers[0]!.publishCalls === 1 &&
      lostLog.some((l) => l.step === "publish" && l.outcome === "unknown") &&
      lostLog.some((l) => l.step === "reconcile" && l.outcome === "published") &&
      (lostJob?.stages ?? []).some((s: { name: string }) => s.name === "reconcile"),
    `${lost.post?.state} reels ${await liveReels(lostCaption)} ${lostLog.map((l) => `${l.step}:${l.outcome}`).join(" ")}`,
  );

  // ---------- the daily limit, then Try again (user D) ----------
  const plimit = await seedReadyProject(d.id, "Why ice floats / F30 e2e");
  const limitCaption = "Why ice floats [e2e:limit] #Ice";
  const limited = await publish(d, plimit, limitCaption);
  const limitId = limited.post?._id.toHexString() ?? "";
  check(
    "daily limit → publish_failed PUBLISH_LIMIT_REACHED with the plain message; nothing posted; the publish claim released",
    limited.post?.state === "publish_failed" && limited.post.lastError?.code === "PUBLISH_LIMIT_REACHED" && limited.post.lastError.message === PUBLISH_FAILURES.limit.message && limited.post.publishAttemptedAt === null && (await liveReels(limitCaption)) === 0,
    `${limited.post?.state} ${limited.post?.lastError?.code}`,
  );
  const retryKey = key();
  const retried = await h6(d, limitId, retryKey);
  const replayed = await h6(d, limitId, retryKey);
  const afterRetry = await settled(limitId);
  const retryJob = afterRetry?.jobId ? await jobDoc(afterRetry.jobId) : null;
  check(
    "Try again (H6) → 202; a replayed Try again (same key) → the same answer, no extra attempt",
    retried.status === 202 && retried.json.post?.state === "publishing" && [200, 202].includes(replayed.status) && replayed.json.job?.attempt === retried.json.job?.attempt,
    `${retried.status} ${replayed.status}`,
  );
  check(
    "…published on the SAME container (reused), attempt 2, ONE reel",
    afterRetry?.state === "published" && afterRetry.attempts === 2 && retryJob?.attempt === 2 && (await containersFor(limitCaption)).length === 1 && (await liveReels(limitCaption)) === 1,
    `${afterRetry?.state} attempts ${afterRetry?.attempts} job ${retryJob?.attempt} containers ${(await containersFor(limitCaption)).length}`,
  );

  // ---------- a change while Instagram processes: the re-check stops it (user E) ----------
  const pchg = await seedReadyProject(e.id, "How bees make honey / F30 e2e");
  check("E connects Instagram (stand-in)", await connect(e, pchg.projectId));
  const chgCaption = "How bees make honey [e2e:slow] #Bees";
  const chg = await h2(e, pchg.projectId, await bodyFor(e, pchg, chgCaption));
  const chgId: string = chg.json.post?.id ?? "";
  let sawContainer = false;
  for (let i = 0; i < 40 && !sawContainer; i++) {
    sawContainer = Boolean((await postDoc(chgId))?.igContainerId);
    if (!sawContainer) await sleep(250);
  }
  // A different MP4 behind the approved render (the job must notice before media_publish).
  await db.collection("renders").updateOne({ _id: new ObjectId(pchg.renderId) }, { $set: { mp4Sha256: `sha256:${"f".repeat(64)}` } });
  const chgDone = await settled(chgId);
  check(
    "the MP4 changed while Instagram processed → the re-check stops it: publish_failed APPROVAL_STALE, NOTHING posted",
    sawContainer && chgDone?.state === "publish_failed" && chgDone.lastError?.code === "APPROVAL_STALE" && chgDone.publishAttemptedAt === null && (await liveReels(chgCaption)) === 0,
    `${sawContainer} ${chgDone?.state} ${chgDone?.lastError?.code}`,
  );
  const chgRetry = await h6(e, chgId);
  const chgPage = await get(e.cookie, `/projects/${pchg.projectId}/publish`);
  check("Try again → 409 APPROVAL_STALE; the page asks to approve again", chgRetry.status === 409 && chgRetry.json.error?.code === "APPROVAL_STALE" && chgPage.text.includes("Needs your approval"), String(chgRetry.status));

  // ---------- D3 (narration edit), C5 (archive) and G4 (Disconnect) cancel a failed post (user E) ----------
  const pd3 = await seedReadyProject(e.id, "How clouds form / F30 e2e");
  const d3Post = await publish(e, pd3, "How clouds form [e2e:error] #Clouds");
  const d3Id = d3Post.post?._id.toHexString() ?? "";
  const d3 = await send(e.cookie, "POST", `/api/v1/projects/${pd3.projectId}/narration-edits`, {
    basePlanVersionId: pd3.planVersionId.toHexString(),
    sceneId: "scene-hook",
    blocks: [{ narrationId: "line-hook-question", text: "Where do clouds come from, and why do they float?" }],
    expectedStateVersion: (await projectDoc(pd3.projectId))!.stateVersion,
  });
  const d3After = await postDoc(d3Id);
  const d3Retry = await h6(e, d3Id);
  check(
    "a narration edit (D3) on a failed post → 201 (allowed again in publish_failed); the approval is cancelled (narration_edit) + notification; Try again → 409",
    d3Post.post?.state === "publish_failed" && d3.status === 201 && d3After?.state === "approval_invalidated" && d3After.invalidatedReason === "narration_edit" && (await notes(e, "approval_invalidated", d3Id)) === 1 && d3Retry.status === 409,
    `${d3Post.post?.state} ${d3.status} ${d3After?.state} ${d3Retry.status}`,
  );

  const parc = await seedReadyProject(e.id, "How rain forms / F30 e2e");
  const arcPost = await publish(e, parc, "How rain forms [e2e:error] #Rain");
  const archived = await send(e.cookie, "DELETE", `/api/v1/projects/${parc.projectId}`, undefined, { "if-match": `"${(await projectDoc(parc.projectId))!.stateVersion}"` });
  check("archiving a project with a failed post (C5) → 200 and the post is cancelled", arcPost.post?.state === "publish_failed" && archived.status === 200 && (await postDoc(arcPost.post._id.toHexString()))?.state === "cancelled", `${arcPost.post?.state} ${archived.status}`);

  const pg4 = await seedReadyProject(e.id, "How snow forms / F30 e2e");
  const g4Post = await publish(e, pg4, "How snow forms [e2e:error] #Snow");
  const g4Id = g4Post.post?._id.toHexString() ?? "";
  const off = await send(e.cookie, "DELETE", "/api/v1/instagram/connection");
  const g4After = await postDoc(g4Id);
  check(
    "Disconnect (G4) with a failed post → 200 and its approval is cancelled (instagram_disconnected) + notification",
    g4Post.post?.state === "publish_failed" && off.status === 200 && g4After?.state === "approval_invalidated" && g4After.invalidatedReason === "instagram_disconnected" && (await notes(e, "approval_invalidated", g4Id)) === 1,
    `${g4Post.post?.state} ${off.status} ${g4After?.state}`,
  );

  // ---------- code review MUST 1: an unconfirmed attempt blocks every new approval ----------
  // (A) as user D, (B) as user A: both are connected and stay under 10 publish requests an hour (a
  // sixth test account would hit the sign-up limit for this computer).
  const fake = () => db.collection<{ _id: string; kind: string }>("e2eFakeInstagram");
  const igUserOf = async (t: Tester): Promise<string> => (await db.collection("instagramConnections").findOne({ ownerId: t.id }))!.igUserId;
  // The stand-in's "outage" for one account (apps/web/lib/instagram/fake-instagram.ts fakeOutageId).
  const outageOn = async (t: Tester) => fake().updateOne({ _id: `outage:${await igUserOf(t)}` }, { $set: { kind: "counter" } }, { upsert: true });
  const outageOff = async (t: Tester) => fake().deleteOne({ _id: `outage:${await igUserOf(t)}` });
  let f = d;
  const pl = await seedReadyProject(f.id, "How lightning works / F30 e2e");
  const fIgUser = await igUserOf(f);
  /** Waits until the job has sent media_publish and is reconciling, then ends it "unconfirmed" (as the stuck-job rule would). */
  async function endUnconfirmed(postId: string): Promise<PostDocument | null> {
    for (let i = 0; i < 120; i++) {
      const post = await postDoc(postId);
      if (post?.state === "outcome_unknown" && post.publishAttemptedAt) {
        const job = await jobDoc(post.jobId!);
        await endPublishJob(db, { jobId: post.jobId!, attempt: job!.attempt as number, failure: "unconfirmed", stage: "reconcile" });
        return postDoc(postId);
      }
      if (post && post.state !== "publishing") return post;
      await sleep(250);
    }
    return postDoc(postId);
  }
  const projectRes = async (t: Tester, projectId: string) => (await send(t.cookie, "GET", `/api/v1/projects/${projectId}`)).json;

  // (A) It went live, but Instagram's answer was lost and couldn't be read back.
  await outageOn(f);
  const liveCaption = "How lightning works [e2e:lost] #Lightning";
  const unA = await h2(f, pl.projectId, await bodyFor(f, pl, liveCaption));
  const unAId: string = unA.json.post?.id ?? "";
  for (let i = 0; i < 120 && (await postDoc(unAId))?.state !== "outcome_unknown"; i++) await sleep(250);
  const switchWhile = await connectAs(f, pl.projectId, `other${tag}`);
  check("while a post is in flight, connecting ANOTHER Instagram account (G3) is refused (INSTAGRAM_BUSY), the old one stays", switchWhile.includes("instagram_error=INSTAGRAM_BUSY") && (await db.collection("instagramConnections").findOne({ ownerId: f.id }))?.igUserId === fIgUser, switchWhile);
  const ended = await endUnconfirmed(unAId);
  check(
    "lost answer + Instagram unreadable → publish_failed 'couldn't confirm' with the publish flag kept; the reel IS live (1)",
    unA.status === 202 && ended?.state === "publish_failed" && ended.publishAttemptedAt !== null && ended.lastError?.message === PUBLISH_FAILURES.unconfirmed.message && (await liveReels(liveCaption)) === 1,
    `${unA.status} ${ended?.state} ${ended?.lastError?.code}`,
  );
  const editedA = await h7(f, pl.projectId, "How lightning works ⚡ #Lightning");
  const afterEdit = await postDoc(unAId);
  const d3A = await send(f.cookie, "POST", `/api/v1/projects/${pl.projectId}/narration-edits`, {
    basePlanVersionId: pl.planVersionId.toHexString(),
    sceneId: "scene-hook",
    blocks: [{ narrationId: "line-hook-question", text: "Where does lightning come from, and why does it flash?" }],
    expectedStateVersion: (await projectDoc(pl.projectId))!.stateVersion,
  });
  check(
    "a caption edit cancels the approval (approval_invalidated) and a narration edit is saved; the publish flag stays",
    editedA.status === 200 && afterEdit?.state === "approval_invalidated" && afterEdit.publishAttemptedAt !== null && d3A.status === 201,
    `${editedA.status} ${afterEdit?.state} ${d3A.status}`,
  );
  const blockedA = await h2(f, pl.projectId, { ...(await bodyFor(f, pl, "How lightning works ⚡ #Lightning")) });
  const resA = await projectRes(f, pl.projectId);
  check(
    "a NEW approval (H2) is refused: 409 'Tap Check again first' (retry_instead); no new post; allowedActions offers retry_post, not publish",
    blockedA.status === 409 &&
      blockedA.json.error?.details?.reason === "retry_instead" &&
      blockedA.json.error.message === POST_MESSAGES.RETRY_INSTEAD &&
      (await postsOf(pl.projectId)).length === 1 &&
      resA.allowedActions?.includes("retry_post") &&
      !resA.allowedActions?.includes("publish"),
    `${blockedA.status} ${blockedA.json.error?.details?.reason} ${JSON.stringify(resA.allowedActions)}`,
  );
  const checkPage = await get(f.cookie, `/projects/${pl.projectId}/publish`);
  check("the publish page shows Check again (no publish form)", checkPage.text.includes('data-testid="publish-check"') && checkPage.text.includes("Check again") && !checkPage.text.includes('data-testid="publish-now"'), String(checkPage.status));
  await outageOff(f);
  const checkedA = await h6(f, unAId);
  const afterA = await postDoc(unAId);
  check(
    "Check again (H6) finds the live reel → 200 published: media id + link saved, project published, notification; STILL ONE reel, no new container",
    checkedA.status === 200 &&
      checkedA.json.outcome === "published" &&
      afterA?.state === "published" &&
      afterA.igMediaId !== null &&
      (await projectDoc(pl.projectId))?.state === "published" &&
      (await notes(f, "post_published", unAId)) === 1 &&
      (await liveReels(liveCaption)) === 1 &&
      (await containersFor(liveCaption)).length === 1 &&
      (await containersFor(liveCaption))[0]!.publishCalls === 1,
    `${checkedA.status} ${checkedA.json.outcome} ${afterA?.state}`,
  );

  // (B) Instagram's answer was lost and NOTHING was posted.
  f = a;
  const pn = await seedReadyProject(f.id, "Why thunder rumbles / F30 e2e");
  await outageOn(f);
  const droppedCaption = "Why thunder rumbles [e2e:dropped] #Thunder";
  const unB = await h2(f, pn.projectId, await bodyFor(f, pn, droppedCaption));
  const unBId: string = unB.json.post?.id ?? "";
  const endedB = await endUnconfirmed(unBId);
  const editedB = await h7(f, pn.projectId, "Why thunder rumbles 🌩️ #Thunder");
  const blockedB = await h2(f, pn.projectId, await bodyFor(f, pn, "Why thunder rumbles 🌩️ #Thunder"));
  check(
    "dropped answer → unconfirmed; caption edit cancels the approval; a new approval is refused (retry_instead); nothing posted",
    endedB?.state === "publish_failed" && endedB.publishAttemptedAt !== null && editedB.status === 200 && blockedB.status === 409 && blockedB.json.error?.details?.reason === "retry_instead" && (await liveReels(droppedCaption)) === 0,
    `${endedB?.state} ${editedB.status} ${blockedB.status}`,
  );
  await outageOff(f);
  const checkedB = await h6(f, unBId);
  const afterB = await postDoc(unBId);
  const formPage = await get(f.cookie, `/projects/${pn.projectId}/publish`);
  check(
    "Check again proves it wasn't posted → 200 not_posted, the flag cleared (state kept); the page asks to approve again; nothing posted, no media_publish sent again",
    checkedB.status === 200 &&
      checkedB.json.outcome === "not_posted" &&
      afterB?.publishAttemptedAt === null &&
      afterB.state === "approval_invalidated" &&
      formPage.text.includes("Needs your approval") &&
      formPage.text.includes('data-testid="publish-now"') &&
      (await liveReels(droppedCaption)) === 0 &&
      (await containersFor(droppedCaption))[0]?.publishCalls === 1,
    `${checkedB.status} ${checkedB.json.outcome} ${afterB?.state}`,
  );
  const again2 = await publish(f, pn, "Why thunder rumbles 🌩️ #Thunder");
  check(
    "approving again now works and posts EXACTLY once (the dropped caption never went live)",
    again2.status === 202 && again2.post?.state === "published" && (await liveReels("Why thunder rumbles 🌩️ #Thunder")) === 1 && (await liveReels(droppedCaption)) === 0,
    `${again2.status} ${again2.post?.state}`,
  );

  // ---------- overall: never twice ----------
  const dupes = await db
    .collection("e2eFakeInstagram")
    .aggregate([{ $match: { kind: "media" } }, { $group: { _id: "$caption", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
    .toArray();
  check("across the whole run: no caption went live twice", dupes.length === 0, JSON.stringify(dupes));

  console.log(`\n${passes} passed, ${failures} failed`);
}

try {
  await main();
} finally {
  await closeMongoClient();
}
if (failures > 0) process.exitCode = 1;
