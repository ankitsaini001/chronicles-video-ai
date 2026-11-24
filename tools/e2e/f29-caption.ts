import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { addInvite, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, readDbConfig, type ProjectDocument, type RenderDocument } from "@bytereel/db";
import { ObjectId } from "mongodb";

/**
 * F29 end-to-end check over real HTTP ("AI caption + hashtags") with the Gemini STAND-IN
 * (E2E_FAKE_GEMINI=1) and the Instagram STAND-IN (E2E_FAKE_INSTAGRAM=1): ZERO calls to Google or Meta.
 * No video is made: like F28's check it seeds ready projects (project, render and storyboard version)
 * in the TEST database. The project's title picks the stand-in's caption answer ("e2e busy", "e2e
 * unsafe", "e2e repair", anything else = a good caption). It proves: signed out → 401 (H1, H7); no
 * caption box and 409 INSTAGRAM_NOT_CONNECTED before connecting; after connecting the CAPTION box with
 * the counter and Suggest; H1 suggests, saves `captionDraft` (source ai, caption + blank line +
 * hashtags), counts 1 of the 20 AI requests and logs one providerUsage row; `onlyIfEmpty` with a saved
 * caption → 409 draft_exists (no AI, nothing counted); the page shows the saved caption; H7 saves edits
 * (source edited; stateVersion and updatedAt unchanged), refuses 2,201 characters, a foreign Origin and
 * another user's project; Suggest again replaces it; busy (3 logged requests with errorCode, counted
 * once, draft kept), refused, repaired; the 20-request limit; a video that isn't ready, a changed
 * storyboard and another video id → 409; another user's project → 404; 10 an hour; Disconnect hides the
 * box and H1 refuses again. F29 review: two automatic suggestions at the same moment count and call
 * Gemini ONCE (the 60 s lease), the lease is cleared afterwards, and an older H7 save (clientSeq) that
 * arrives late is skipped.
 *
 * TEMP FILES: never in /tmp. In every terminal used below, first run from the repo root:
 *   mkdir -p runs/.tmp && export TMPDIR="$PWD/runs/.tmp"
 * SAFETY: only the separate test database `bytereel_test`, ports 3230–3239 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3236 E2E_FAKE_INSTAGRAM=1 E2E_FAKE_GEMINI=1 \
 *        E2E_FAKE_ELEVENLABS=1 INNGEST_DEV=http://localhost:8299 TOKEN_ENCRYPTION_KEYS='{"1":"<openssl rand -base64 32>"}' \
 *        TOKEN_ENCRYPTION_ACTIVE_VERSION=1 npx next start -p 3236
 *   3. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3236 npx tsx tools/e2e/f29-caption.ts
 *   4. stop the server (by its pid) and drop the bytereel_test database afterwards.
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has E2E_FAKE_GEMINI=1, E2E_FAKE_INSTAGRAM=1 and MONGODB_DB=bytereel_test.
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
if (env.get("E2E_FAKE_GEMINI") !== "1" || env.get("E2E_FAKE_INSTAGRAM") !== "1" || env.get("MONGODB_DB") !== TEST_DB) {
  throw new Error("Stopping before any request: the server must run with E2E_FAKE_GEMINI=1, E2E_FAKE_INSTAGRAM=1 and MONGODB_DB=bytereel_test.");
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

async function get(cookie: string, path: string): Promise<{ status: number; location: string; text: string }> {
  const r = await fetch(path.startsWith("http") ? path : `${base}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location") ?? "", text: unescapeHtml(await r.text()) };
}
async function send(cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = { origin: base }): Promise<{ status: number; json: Json }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
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
  const email = `f29-e2e-${label}-${tag}@example.com`;
  const password = `E2e-${randomBytes(9).toString("base64url")}`;
  await addInvite(db, email, { note: "F29 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ name: `F29 Tester ${label}`, email, password }) });
  check(`test account ${label} created`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId, label };
}

type Seeded = { projectId: string; renderId: string; planVersionId: ObjectId };

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
    mp4Sha256: `sha256:${"d".repeat(64)}`,
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
  const start = await get(t.cookie, `/api/v1/instagram/connect?returnTo=${encodeURIComponent(`publish:${projectId}`)}`);
  const state = start.location ? (new URL(start.location, base).searchParams.get("state") ?? "") : "";
  const done = await get(t.cookie, `/api/v1/instagram/callback?${new URLSearchParams({ code: `e2e.creator.${t.label}${tag}`, state }).toString()}`);
  return done.location.includes("instagram=connected");
}

const projects = () => db.collection<ProjectDocument>("projects");
const projectDoc = (id: string) => projects().findOne({ _id: new ObjectId(id) });
const usageRows = (id: string) => db.collection("providerUsage").find({ projectId: new ObjectId(id), operation: "caption" }).sort({ at: 1 }).toArray();
const h1 = (t: Tester, projectId: string, body: unknown = { renderId: "current" }) => send(t.cookie, "POST", `/api/v1/projects/${projectId}/caption-suggestions`, body);
const h7 = (t: Tester, projectId: string, text: unknown, headers?: Record<string, string>, clientSeq?: number) =>
  send(t.cookie, "PUT", `/api/v1/projects/${projectId}/caption-draft`, clientSeq === undefined ? { text } : { text, clientSeq }, headers);
/** The caption box's text on the server-rendered page (the <textarea> content). */
const textareaOf = (html: string) => /<textarea[^>]*data-testid="caption-text"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? null;

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F23", "F28"]));
  const a = await signUp("a");
  const b = await signUp("b");
  const c = await signUp("c");
  const pa = await seedReadyProject(a.id, "How rainbows form / F29 e2e");
  const pb = await seedReadyProject(b.id, "Photosynthesis / F29 e2e");

  // ---------- signed out ----------
  const outH1 = await send("", "POST", `/api/v1/projects/${pa.projectId}/caption-suggestions`, { renderId: "current" });
  const outH7 = await send("", "PUT", `/api/v1/projects/${pa.projectId}/caption-draft`, { text: "x" });
  check("signed out: H1 and H7 → 401", outH1.status === 401 && outH7.status === 401, `${outH1.status} ${outH7.status}`);

  // ---------- before connecting Instagram ----------
  const before = await get(a.cookie, `/projects/${pa.projectId}/publish`);
  check("Step 4 before connecting: Connect your Instagram, no caption box", before.status === 200 && before.text.includes("Connect your Instagram") && !before.text.includes('data-testid="caption-box"'), String(before.status));
  const notConnected = await h1(a, pa.projectId);
  check("H1 without Instagram → 409 INSTAGRAM_NOT_CONNECTED, nothing counted", notConnected.status === 409 && notConnected.json.error?.code === "INSTAGRAM_NOT_CONNECTED" && (await projectDoc(pa.projectId))?.planRequestCount === 1, `${notConnected.status} ${notConnected.json.error?.code}`);

  check("A connects Instagram (stand-in)", await connect(a, pa.projectId));
  const empty = await get(a.cookie, `/projects/${pa.projectId}/publish`);
  check(
    "Step 4 connected, no caption yet: the CAPTION box (empty), 'Suggest a caption', '0 / 2,200', and 'Publishing comes next' below",
    empty.text.includes('data-testid="caption-box"') && textareaOf(empty.text) === "" && empty.text.includes("Suggest a caption") && empty.text.includes("0 / 2,200") && empty.text.includes("Publishing comes next"),
  );

  // ---------- the first suggestion (what the page sends automatically) ----------
  const updatedBefore = (await projectDoc(pa.projectId))!.updatedAt;
  const first = await h1(a, pa.projectId, { renderId: pa.renderId, onlyIfEmpty: true });
  const afterFirst = await projectDoc(pa.projectId);
  const rows1 = await usageRows(pa.projectId);
  check(
    "H1 → 200: a hook-first caption about the video, 3–5 hashtags, language en, the saved draft (source ai)",
    first.status === 200 &&
      /rainbows form/.test(first.json.caption ?? "") &&
      Array.isArray(first.json.hashtags) &&
      first.json.hashtags.length >= 3 &&
      first.json.hashtags.length <= 5 &&
      first.json.language === "en" &&
      first.json.draft?.source === "ai" &&
      first.json.applied === true &&
      first.json.draft.text === `${first.json.caption}\n\n${first.json.hashtags.join(" ")}`,
    `${first.status} ${JSON.stringify(first.json).slice(0, 160)}`,
  );
  check(
    "database: captionDraft saved; 1 of the 20 AI requests counted; the suggestion lease cleared; stateVersion and updatedAt unchanged",
    afterFirst?.captionDraft?.text === first.json.draft?.text &&
      afterFirst?.captionDraft?.source === "ai" &&
      afterFirst.planRequestCount === 2 &&
      afterFirst.captionSuggestingUntil === undefined &&
      afterFirst.captionSuggestingId === undefined &&
      afterFirst.stateVersion === 5 &&
      afterFirst.updatedAt.getTime() === updatedBefore.getTime(),
    `count ${afterFirst?.planRequestCount} v${afterFirst?.stateVersion}`,
  );
  check(
    "providerUsage: ONE gemini 'caption' row, final ok, with the project and no caption text",
    rows1.length === 1 && rows1[0]!.provider === "gemini" && rows1[0]!.status === "final" && rows1[0]!.outcome === "ok" && rows1[0]!.ownerId.equals(a.id) && !JSON.stringify(rows1[0]).includes("rainbows"),
    `${rows1.length} rows`,
  );
  const again = await h1(a, pa.projectId, { renderId: "current", onlyIfEmpty: true });
  check(
    "onlyIfEmpty with a saved caption → 409 draft_exists with that caption; no AI, nothing counted",
    again.status === 409 && again.json.error?.details?.reason === "draft_exists" && again.json.error.details.draft?.text === first.json.draft?.text && (await projectDoc(pa.projectId))?.planRequestCount === 2 && (await usageRows(pa.projectId)).length === 1,
    `${again.status}`,
  );
  const reopened = await get(a.cookie, `/projects/${pa.projectId}/publish`);
  const shown = textareaOf(reopened.text) ?? "";
  check(
    "reopening Step 4 shows the saved caption (no new AI request) with its counter and 'Suggest again'",
    shown.includes(first.json.hashtags[0]) && shown.includes("rainbows form") && reopened.text.includes("Suggest again") && /\d+ \/ 2,200/.test(reopened.text),
    shown.slice(0, 80),
  );

  // ---------- H7: the creator's edits ----------
  const mine = "My own words about rainbows 🌈\r\n\n#Rainbows #Physics";
  const saved = await h7(a, pa.projectId, mine);
  const afterEdit = await projectDoc(pa.projectId);
  check(
    "H7 → 200: saved as typed (line ends cleaned), source edited; stateVersion and updatedAt unchanged",
    saved.status === 200 && saved.json.draft?.text === "My own words about rainbows 🌈\n\n#Rainbows #Physics" && saved.json.draft.source === "edited" && afterEdit?.captionDraft?.source === "edited" && afterEdit.stateVersion === 5 && afterEdit.updatedAt.getTime() === updatedBefore.getTime(),
    `${saved.status} ${JSON.stringify(saved.json).slice(0, 120)}`,
  );
  const pageEdited = await get(a.cookie, `/projects/${pa.projectId}/publish`);
  check("the page shows the edited caption after a reload", (textareaOf(pageEdited.text) ?? "").includes("My own words about rainbows"));
  const tooLong = await h7(a, pa.projectId, "a".repeat(2201));
  const exactly = await h7(a, pa.projectId, "🌈".repeat(2200));
  check("H7: 2,201 characters → 400 at text; 2,200 emoji (counted as 2,200) → 200", tooLong.status === 400 && tooLong.json.error?.details?.issues?.[0]?.path === "text" && exactly.status === 200, `${tooLong.status} ${exactly.status}`);
  const noOrigin = await h7(a, pa.projectId, "x", {});
  const foreign7 = await h7(a, pb.projectId, "hijack");
  check("H7 without the app's Origin → 403; on another user's project → 404 (nothing saved there)", noOrigin.status === 403 && foreign7.status === 404 && !(await projectDoc(pb.projectId))?.captionDraft, `${noOrigin.status} ${foreign7.status}`);
  const seqNew = await h7(a, pa.projectId, "Newer text", undefined, 2_000_000_000_002);
  const seqLate = await h7(a, pa.projectId, "Older text arriving late", undefined, 2_000_000_000_001);
  check(
    "H7 clientSeq: an older save arriving late is skipped (applied false, the newer caption returned and kept)",
    seqNew.json.applied === true && seqLate.status === 200 && seqLate.json.applied === false && seqLate.json.draft?.text === "Newer text" && (await projectDoc(pa.projectId))?.captionDraft?.text === "Newer text",
    `${seqLate.status} ${JSON.stringify(seqLate.json).slice(0, 100)}`,
  );
  const emptied = await h7(a, pa.projectId, "");
  check("H7: an empty box is saved too (the creator can start from nothing)", emptied.status === 200 && (await projectDoc(pa.projectId))?.captionDraft?.text === "", String(emptied.status));

  // ---------- Suggest again ----------
  await h7(a, pa.projectId, "Mine again");
  const replaced = await h1(a, pa.projectId, { renderId: pa.renderId });
  const afterReplace = await projectDoc(pa.projectId);
  check("Suggest again → 200 replaces the edited caption (source ai), counts 1 more", replaced.status === 200 && afterReplace?.captionDraft?.source === "ai" && afterReplace.captionDraft.text !== "Mine again" && afterReplace.planRequestCount === 3, `${replaced.status} count ${afterReplace?.planRequestCount}`);

  // ---------- refusals before any AI ----------
  const otherVideo = await h1(a, pa.projectId, { renderId: new ObjectId().toHexString() });
  check("another video id → 409 render_not_current", otherVideo.status === 409 && otherVideo.json.error?.details?.reason === "render_not_current", String(otherVideo.status));
  const foreign1 = await h1(a, pb.projectId);
  check("H1 on another user's project → 404, nothing counted there", foreign1.status === 404 && (await projectDoc(pb.projectId))?.planRequestCount === 1, String(foreign1.status));
  await projects().updateOne({ _id: new ObjectId(pa.projectId) }, { $set: { state: "generating" } });
  const notReady = await h1(a, pa.projectId);
  const pageNotReady = await get(a.cookie, `/projects/${pa.projectId}/publish`);
  const h7NotReady = await h7(a, pa.projectId, "while generating");
  check("a video being remade → H1 and H7 409 INVALID_STATE; the page goes back to the project", notReady.status === 409 && notReady.json.error?.code === "INVALID_STATE" && h7NotReady.status === 409 && [302, 303, 307].includes(pageNotReady.status), `${notReady.status} ${h7NotReady.status} ${pageNotReady.status}`);
  await projects().updateOne({ _id: new ObjectId(pa.projectId) }, { $set: { state: "video_ready", currentPlanVersionId: new ObjectId() } });
  const changed = await h1(a, pa.projectId);
  check("a storyboard changed since the video → 409 (the publish page's own rule)", changed.status === 409 && changed.json.error?.details?.reason === "video_not_ready", String(changed.status));
  await projects().updateOne({ _id: new ObjectId(pa.projectId) }, { $set: { currentPlanVersionId: pa.planVersionId, planRequestCount: 20 } });
  const rowsBeforeQuota = (await usageRows(pa.projectId)).length;
  const quota = await h1(a, pa.projectId);
  check(
    "at the project's 20 AI requests → 429 QUOTA_EXCEEDED with the plain message; no AI request, count stays 20",
    quota.status === 429 && quota.json.error?.code === "QUOTA_EXCEEDED" && quota.json.error.message === "This project has used all 20 of its AI requests. You can still write your own caption." && (await projectDoc(pa.projectId))?.planRequestCount === 20 && (await usageRows(pa.projectId)).length === rowsBeforeQuota,
    `${quota.status}`,
  );
  const stillTyping = await h7(a, pa.projectId, "Typing my own caption always works");
  check("…and typing your own caption still saves", stillTyping.status === 200, String(stillTyping.status));

  // ---------- the stand-in's busy, refused and repaired answers (user B) ----------
  check("B connects Instagram (stand-in)", await connect(b, pb.projectId));
  const busy = await seedReadyProject(b.id, "e2e busy / F29");
  await h7(b, busy.projectId, "Kept while busy");
  const busyAnswer = await h1(b, busy.projectId);
  const busyRows = await usageRows(busy.projectId);
  const busyDoc = await projectDoc(busy.projectId);
  check(
    "busy → 503 PROVIDER_BUSY with the plain message; counted ONCE; 3 logged requests with errorCode; the caption kept",
    busyAnswer.status === 503 &&
      busyAnswer.json.error?.code === "PROVIDER_BUSY" &&
      busyAnswer.json.error.message.startsWith("Our AI is busy or taking too long") &&
      busyDoc?.planRequestCount === 2 &&
      busyRows.length === 3 &&
      busyRows.every((row) => row.status === "failed" && row.errorCode === "transient 503 UNAVAILABLE") &&
      busyDoc.captionDraft?.text === "Kept while busy",
    `${busyAnswer.status} count ${busyDoc?.planRequestCount} rows ${busyRows.length} ${busyRows[0]?.errorCode}`,
  );
  const unsafe = await seedReadyProject(b.id, "e2e unsafe / F29");
  const unsafeAnswer = await h1(b, unsafe.projectId);
  check("refused by the AI → 422 PROVIDER_REJECTED, nothing saved", unsafeAnswer.status === 422 && unsafeAnswer.json.error?.code === "PROVIDER_REJECTED" && !(await projectDoc(unsafe.projectId))?.captionDraft, String(unsafeAnswer.status));
  const repair = await seedReadyProject(b.id, "e2e repair / F29");
  const repairAnswer = await h1(b, repair.projectId);
  const repairRows = await usageRows(repair.projectId);
  check(
    "a broken first answer is repaired once → 200; 2 logged requests, counted once",
    repairAnswer.status === 200 && repairAnswer.json.hashtags?.length === 4 && repairRows.length === 2 && repairRows[0]!.outcome === "invalid_output" && (await projectDoc(repair.projectId))?.planRequestCount === 2,
    `${repairAnswer.status} rows ${repairRows.length}`,
  );

  // ---------- a reload during the first suggestion: two requests at the same moment (user B) ----------
  const race = await seedReadyProject(b.id, "Why leaves change colour / F29");
  const [r1, r2] = await Promise.all([h1(b, race.projectId, { renderId: "current", onlyIfEmpty: true }), h1(b, race.projectId, { renderId: "current", onlyIfEmpty: true })]);
  const raceDoc = await projectDoc(race.projectId);
  const raceRows = await usageRows(race.projectId);
  const loser = r1.status === 200 ? r2 : r1;
  check(
    "two automatic suggestions at once: ONE 200, the other 409 (in progress or caption exists); counted ONCE; ONE Gemini request; lease cleared",
    [r1.status, r2.status].filter((x) => x === 200).length === 1 &&
      loser.status === 409 &&
      ["suggestion_in_progress", "draft_exists"].includes(loser.json.error?.details?.reason) &&
      raceDoc?.planRequestCount === 2 &&
      raceRows.length === 1 &&
      raceDoc.captionSuggestingId === undefined,
    `${r1.status}/${r2.status} ${loser.json.error?.details?.reason} count ${raceDoc?.planRequestCount} rows ${raceRows.length}`,
  );

  // ---------- 10 an hour (user C: no Instagram, no project; the limit is counted first) ----------
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await h1(c, pa.projectId)).status);
  check("H1: 10 an hour, the 11th → 429 RATE_LIMITED", statuses.slice(0, 10).every((s) => s === 404) && statuses[10] === 429, statuses.join(","));

  // ---------- Disconnect ----------
  const off = await send(a.cookie, "DELETE", "/api/v1/instagram/connection");
  const pageOff = await get(a.cookie, `/projects/${pa.projectId}/publish`);
  const h1Off = await h1(a, pa.projectId);
  check(
    "after Disconnect: no caption box (Connect your Instagram), H1 → 409 INSTAGRAM_NOT_CONNECTED",
    off.status === 200 && pageOff.text.includes("Connect your Instagram") && !pageOff.text.includes('data-testid="caption-box"') && h1Off.json.error?.code === "INSTAGRAM_NOT_CONNECTED",
    `${off.status} ${h1Off.status}`,
  );

  console.log(`\n${passes} passed, ${failures} failed`);
}

try {
  await main();
} finally {
  await closeMongoClient();
}
if (failures > 0) process.exitCode = 1;
