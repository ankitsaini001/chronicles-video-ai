import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { addInvite, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, readDbConfig } from "@bytereel/db";
import { ObjectId } from "mongodb";

/**
 * F16–F20 end-to-end check over real HTTP (storyboard screen, narration edit + versions + undo,
 * revision chat, voice switch, approval #1): a running `next start` server whose Gemini is the local
 * stand-in (E2E_FAKE_GEMINI=1: NO real AI call) and a private Inngest Dev Server on port 8299.
 * SAFETY: works only on the separate test database `bytereel_test`, port 3230–3239 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. npx --yes inngest-cli@1.49.0 dev --no-discovery -u http://localhost:3237/api/inngest --port 8299 \
 *        --connect-gateway-port 8298 --connect-gateway-grpc-port 50062 --connect-executor-grpc-port 50063
 *   3. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3237 E2E_FAKE_GEMINI=1 \
 *        INNGEST_DEV=http://localhost:8299 npx next start -p 3237
 *   4. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3237 E2E_FAKE_GEMINI=1 npx tsx tools/e2e/f16-f20-storyboard.ts
 *   5. drop the bytereel_test database afterwards
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has E2E_FAKE_GEMINI=1, MONGODB_DB=bytereel_test and INNGEST_DEV on port 8299.
 */

const TEST_DB = "bytereel_test";
process.loadEnvFile(".env");
const base = process.env.E2E_BASE_URL ?? "";
if (!/^http:\/\/localhost:323\d$/.test(base)) throw new Error("Set E2E_BASE_URL to http://localhost:3230–3239 (never port 3000).");
if (process.env.E2E_FAKE_GEMINI !== "1") throw new Error("Run with E2E_FAKE_GEMINI=1: this check must never call the real Gemini.");
const settings = readDbConfig(process.env);
if (!settings.ok) throw new Error(settings.problems.join(" "));
if (settings.config.dbName !== TEST_DB) throw new Error(`Refusing to run: MONGODB_DB must be ${TEST_DB}.`);
const db = getDb(settings.config);

function serverSettings(port: string) {
  const listing = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
  const pid = /pid=(\d+)/.exec(listing)?.[1];
  if (!pid) throw new Error(`No server process found on port ${port}.`);
  const env = new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  return env.get("E2E_FAKE_GEMINI") === "1" && env.get("MONGODB_DB") === TEST_DB && env.get("INNGEST_DEV") === "http://localhost:8299";
}
if (!serverSettings(new URL(base).port)) throw new Error("Stopping before any request: the server must run with E2E_FAKE_GEMINI=1, MONGODB_DB=bytereel_test and INNGEST_DEV=http://localhost:8299.");

const tag = randomBytes(4).toString("hex");
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

type Json = Record<string, any>;
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const key = () => randomBytes(16).toString("hex");
const send = async (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { origin: base, cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, headers: r.headers, json: (await r.json().catch(() => ({}))) as Json };
};
const oid = (id: string) => new ObjectId(id);
const projectOf = (id: string) => db.collection("projects").findOne({ _id: oid(id) });

async function waitIdle(cookie: string, projectId: string, timeoutMs = 90_000): Promise<Json> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await send(cookie, "GET", `/api/v1/projects/${projectId}/status`);
    if ((r.json.pollAfterMs === null && r.json.state !== "planning") || Date.now() > end) return r.json;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function signUp(label: string): Promise<{ cookie: string; id: ObjectId }> {
  const email = `f16-e2e-${label}-${tag}@example.com`;
  await addInvite(db, email, { note: "F16-F20 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `F16 Tester ${label}`, email, password: `E2e-${randomBytes(9).toString("base64url")}` }),
  });
  check(`test account ${label} created`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId };
}

async function newStoryboard(cookie: string, text: string): Promise<string> {
  const r = await send(cookie, "POST", "/api/v1/projects", { inputType: "topic", text, language: "en", voiceGender: "female" }, { "idempotency-key": key() });
  const id = r.json.project?.id as string;
  const done = await waitIdle(cookie, id);
  check(`storyboard made for "${text}"`, done.state === "storyboard_ready", done.state);
  return id;
}

async function current(cookie: string, projectId: string) {
  const [p, v] = await Promise.all([send(cookie, "GET", `/api/v1/projects/${projectId}`), send(cookie, "GET", `/api/v1/projects/${projectId}/plan-versions/current`)]);
  return { project: p.json, version: v.json };
}

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F14", "F15", "F18", "F20"]));
  const names = async (c: string) => (await db.collection(c).indexes()).map((i) => i.name);
  check("F18/F20 indexes created on the test database", (await names("revisions")).includes("projectId_createdAt") && (await names("storyboardApprovals")).includes("planVersionId_unique"));
  await db.collection("rateLimits").deleteMany({});
  const a = await signUp("a");
  const b = await signUp("b");

  // ---------- F16: view ----------
  const pid = await newStoryboard(a.cookie, "How does the water cycle work?");
  const redirect = await fetch(`${base}/projects/${pid}`, { headers: { cookie: a.cookie }, redirect: "manual" });
  const redirectHtml = redirect.status === 200 ? await redirect.text() : "";
  check("/projects/[id] sends a storyboard project to /storyboard", (redirect.status >= 300 && redirect.status < 400 && (redirect.headers.get("location") ?? "").endsWith(`/projects/${pid}/storyboard`)) || redirectHtml.includes(`/projects/${pid}/storyboard`), `status ${redirect.status}`);
  let page = (await (await fetch(`${base}/projects/${pid}/storyboard`, { headers: { cookie: a.cookie } })).text()).replace(/<!-- -->/g, "");
  check("storyboard page: scene cards, pattern badge, Visual line, change box, approve button", ["Scene 01", "Hook", "Visual:", "Ask for changes", "Approve storyboard", "Version 1", "Undo"].every((t) => page.includes(t)));
  check("storyboard page: stepper links to /storyboard", page.includes(`href="/projects/${pid}/storyboard"`));
  let r = await send(a.cookie, "GET", `/api/v1/projects/${pid}`);
  check("C3 → 200 Project with ETag and storyboard actions", r.status === 200 && r.headers.get("etag") === `"${r.json.stateVersion}"` && r.json.allowedActions?.join() === "edit_storyboard,request_revision,approve_storyboard" && r.json.currentStep === "storyboard");
  let { project, version } = await current(a.cookie, pid);
  check("D2 current → full plan, validation, stats, changedSceneIds [], approval null", version.versionNumber === 1 && version.isCurrent && version.plan?.scenes?.length >= 3 && version.validation?.valid === true && version.changedSceneIds?.length === 0 && version.approval === null && /^sha256:/.test(version.planHash));
  check("D2 by id → same version; bad id → 404", (await send(a.cookie, "GET", `/api/v1/projects/${pid}/plan-versions/${version.id}`)).json.id === version.id && (await send(a.cookie, "GET", `/api/v1/projects/${pid}/plan-versions/${new ObjectId().toHexString()}`)).status === 404);
  const emptyId = new ObjectId();
  await db.collection("projects").insertOne({ _id: emptyId, ownerId: a.id, schemaVersion: 1, title: "x", language: "en", voiceGender: "female", input: { type: "topic", text: "x y z", brainstormChoice: null }, state: "plan_failed", currentPlanVersionId: null, approvedPlanVersionId: null, currentRenderId: null, activeJobId: null, stateVersion: 1, planRequestCount: 0, lastError: null, createdAt: new Date(), updatedAt: new Date(), archivedAt: null });
  r = await send(a.cookie, "GET", `/api/v1/projects/${emptyId.toHexString()}/plan-versions/current`);
  check("D2 current without a storyboard → 404 no_plan_yet", r.status === 404 && r.json.error?.details?.reason === "no_plan_yet");
  const noStoryboard = await fetch(`${base}/projects/${emptyId.toHexString()}/storyboard`, { headers: { cookie: a.cookie }, redirect: "manual" });
  check("storyboard page without a storyboard goes back to the project page", noStoryboard.status >= 300 && noStoryboard.status < 400 || (await noStoryboard.text()).includes(`/projects/${emptyId.toHexString()}`));

  // ---------- F17: edit → new version → undo ----------
  const scene = version.plan.scenes[0];
  const block = scene.narration[0];
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: version.id, sceneId: scene.id, blocks: [{ narrationId: block.id, text: `${block.text}  Really.` }], expectedStateVersion: project.stateVersion });
  check("D3 → 201 new user_edit version 2 (Location), valid, Changed scene", r.status === 201 && r.json.versionNumber === 2 && r.json.source === "user_edit" && r.json.valid === true && r.json.changedSceneIds?.join() === scene.id && r.headers.get("location")?.endsWith(r.json.id) === true, `status ${r.status}`);
  const v2 = r.json;
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: version.id, sceneId: scene.id, blocks: [{ narrationId: block.id, text: "Another tab" }], expectedStateVersion: project.stateVersion });
  check("D3 with the old stateVersion (another tab) → 409 STALE_VERSION, nothing saved", r.status === 409 && r.json.error?.code === "STALE_VERSION" && (await db.collection("planVersions").countDocuments({ projectId: oid(pid) })) === 2);
  ({ project, version } = await current(a.cookie, pid));
  const twoParts = version.plan.scenes.find((s: Json) => s.narration.length >= 2);
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: version.id, sceneId: twoParts.id, blocks: [{ narrationId: twoParts.narration[0].id, text: "x" }, { narrationId: "no-such-block", text: "y" }], expectedStateVersion: project.stateVersion });
  check("D3 with one unknown block → 400, nothing saved (all or nothing)", r.status === 400 && (await db.collection("planVersions").countDocuments({ projectId: oid(pid) })) === 2);
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: v2.parentVersionId, sceneId: scene.id, blocks: [{ narrationId: block.id, text: "Old base" }], expectedStateVersion: project.stateVersion });
  check("D3 on an old base version → 409 STALE_VERSION", r.status === 409 && r.json.error?.code === "STALE_VERSION");
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: version.id, sceneId: "no-such-scene", blocks: [{ narrationId: block.id, text: "x" }], expectedStateVersion: project.stateVersion });
  check("D3 unknown scene → 400 INVALID_INPUT", r.status === 400 && r.json.error?.details?.issues?.[0]?.path === "sceneId");
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: version.id, sceneId: scene.id, blocks: [{ narrationId: block.id, text: "x".repeat(301) }], expectedStateVersion: project.stateVersion });
  check("D3 text over 300 → 400", r.status === 400);
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: version.id, sceneId: scene.id, blocks: [{ narrationId: block.id, text: "Completely different words." }], expectedStateVersion: project.stateVersion });
  check("D3 that removes a cue → 201 saved as invalid (version 3) with issues", r.status === 201 && r.json.versionNumber === 3 && r.json.valid === false && r.json.validation?.issues?.length > 0);
  const v3 = r.json;
  page = (await (await fetch(`${base}/projects/${pid}/storyboard`, { headers: { cookie: a.cookie } })).text()).replace(/<!-- -->/g, "");
  check("page shows the problem on the scene and blocks approval", page.includes("Needs fixing") && page.includes("Fix the scenes marked in red first."));
  ({ project, version } = await current(a.cookie, pid));
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/storyboard-approval`, { planVersionId: version.id, planHash: version.planHash, expectedStateVersion: project.stateVersion }, { "idempotency-key": key() });
  check("D8 on an invalid version → 422 PLAN_INVALID with issues", r.status === 422 && r.json.error?.code === "PLAN_INVALID" && r.json.error?.details?.issues?.length > 0);
  r = await send(a.cookie, "GET", `/api/v1/projects/${pid}/plan-versions?limit=2`);
  const page2 = await send(a.cookie, "GET", `/api/v1/projects/${pid}/plan-versions?limit=2&cursor=${r.json.nextCursor}`);
  check("D1 → newest first, 2 per page with a cursor, then the last one", r.json.items?.map((i: Json) => i.versionNumber).join() === "3,2" && r.json.items[0].isCurrent && page2.json.items?.map((i: Json) => i.versionNumber).join() === "1" && page2.json.nextCursor === null);
  check("D1 bad cursor / limit → 400", (await send(a.cookie, "GET", `/api/v1/projects/${pid}/plan-versions?cursor=abc`)).status === 400 && (await send(a.cookie, "GET", `/api/v1/projects/${pid}/plan-versions?limit=99`)).status === 400);
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/plan-versions/${v3.parentVersionId}/restore`, { expectedStateVersion: project.stateVersion });
  check("D7 Undo → 200, version 2 current again (no new version)", r.status === 200 && r.json.currentPlanVersionId === v2.id && (await db.collection("planVersions").countDocuments({ projectId: oid(pid) })) === 3);
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/plan-versions/${v2.id}/restore`, { expectedStateVersion: r.json.stateVersion });
  check("D7 on the current version → 409 INVALID_STATE already_current", r.status === 409 && r.json.error?.details?.reason === "already_current");
  ({ project, version } = await current(a.cookie, pid));
  check("after undo the edited text is back", version.plan.scenes[0].narration[0].text === `${block.text} Really.`);

  // ---------- F19: voice ----------
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/voice`, { basePlanVersionId: version.id, voiceGender: "male", expectedStateVersion: project.stateVersion });
  check("D4 → 201 new version with the male voice preset only", r.status === 201 && r.json.plan?.voicePreset === "indian-english-male" && r.json.source === "user_edit" && r.json.changedSceneIds?.length === 0);
  check("D4: project voice is male", (await projectOf(pid))?.voiceGender === "male");
  ({ project, version } = await current(a.cookie, pid));
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/voice`, { basePlanVersionId: version.id, voiceGender: "male", expectedStateVersion: project.stateVersion });
  check("D4 same voice → 400 INVALID_INPUT", r.status === 400 && r.json.error?.details?.issues?.[0]?.message === "unchanged");
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/plan-versions/${version.parentVersionId}/restore`, { expectedStateVersion: project.stateVersion });
  check("undo of the voice switch → project voice female again", r.status === 200 && r.json.voiceGender === "female");

  // ---------- F20: approve → later edit clears it ----------
  ({ project, version } = await current(a.cookie, pid));
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/storyboard-approval`, { planVersionId: version.id, planHash: `sha256:${"0".repeat(64)}`, expectedStateVersion: project.stateVersion }, { "idempotency-key": key() });
  check("D8 with a different hash → 409 APPROVAL_STALE plan_hash_mismatch", r.status === 409 && r.json.error?.details?.reason === "plan_hash_mismatch");
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/storyboard-approval`, { planVersionId: v3.id, planHash: v3.planHash, expectedStateVersion: project.stateVersion }, { "idempotency-key": key() });
  check("D8 on a version that isn't current → 409 APPROVAL_STALE not_current", r.status === 409 && r.json.error?.details?.reason === "not_current");
  check("D8 without Idempotency-Key → 400", (await send(a.cookie, "POST", `/api/v1/projects/${pid}/storyboard-approval`, { planVersionId: version.id, planHash: version.planHash, expectedStateVersion: project.stateVersion })).status === 400);
  const approveKey = key();
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/storyboard-approval`, { planVersionId: version.id, planHash: version.planHash, expectedStateVersion: project.stateVersion }, { "idempotency-key": approveKey });
  check("D8 → 200 approval of the exact version + hash, job null (video job comes in F23), still storyboard_ready", r.status === 200 && r.json.approval?.planVersionId === version.id && r.json.approval?.planHash === version.planHash && r.json.job === null && r.json.project?.state === "storyboard_ready" && r.json.project?.approvedPlanVersionId === version.id);
  const again = await send(a.cookie, "POST", `/api/v1/projects/${pid}/storyboard-approval`, { planVersionId: version.id, planHash: version.planHash, expectedStateVersion: project.stateVersion }, { "idempotency-key": approveKey });
  check("D8 repeated with the same key → replayed", again.headers.get("idempotent-replayed") === "true" && again.json.approval?.id === r.json.approval?.id);
  const approvedId = version.id;
  check("storyboardApprovals row + audit entry saved; no generate job, no videos counted", (await db.collection("storyboardApprovals").countDocuments({ planVersionId: oid(approvedId) })) === 1 && (await db.collection("auditLogs").countDocuments({ action: "storyboard.approved", "subject.id": oid(approvedId) })) === 1 && (await db.collection("jobs").countDocuments({ projectId: oid(pid), type: "generate" })) === 0 && (await db.collection("usageCounters").countDocuments({ ownerId: a.id, kind: "videos" })) === 0);
  ({ project, version } = await current(a.cookie, pid));
  check("approved: D2 approval set, allowedActions without approve_storyboard", version.approval?.id === r.json.approval?.id && version.isApproved && !project.allowedActions.includes("approve_storyboard"));
  page = (await (await fetch(`${base}/projects/${pid}/storyboard`, { headers: { cookie: a.cookie } })).text()).replace(/<!-- -->/g, "");
  check("page shows the plain approved state (no coming-soon note)", page.includes("Approved · Version") && !page.includes("later update"));
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: version.id, sceneId: scene.id, blocks: [{ narrationId: block.id, text: `${block.text} Really. Truly.` }], expectedStateVersion: project.stateVersion });
  check("an edit after approval → new version with no approval; project approval cleared", r.status === 201 && r.json.isApproved === false && (await projectOf(pid))?.approvedPlanVersionId === null);
  ({ project, version } = await current(a.cookie, pid));
  check("…and approve_storyboard is offered again", project.allowedActions.includes("approve_storyboard"));
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/plan-versions/${approvedId}/restore`, { expectedStateVersion: project.stateVersion });
  check("undo back to the approved version → its approval counts again (same row)", r.status === 200 && r.json.approvedPlanVersionId === approvedId && (await db.collection("storyboardApprovals").countDocuments({ planVersionId: oid(approvedId) })) === 1);

  // ---------- F18: revision job → Changed tags ----------
  ({ project, version } = await current(a.cookie, pid));
  const countBefore = (await projectOf(pid))!.planRequestCount as number;
  const target = version.plan.scenes[2];
  const revKey = key();
  const revBody = { stage: "storyboard", scope: "scene", sceneId: target.id, message: "make this scene simpler", basePlanVersionId: version.id, expectedStateVersion: project.stateVersion };
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/revisions`, revBody, { "idempotency-key": revKey });
  check("D5 → 202 revision pending + revise job queued (Updating scene 3…)", r.status === 202 && r.json.revision?.status === "pending" && r.json.job?.type === "revise" && r.json.job?.state === "queued" && r.json.job?.result?.revisionId === r.json.revision?.id && r.json.job?.progress?.message === "Updating scene 3…", `status ${r.status}`);
  const revisionId = r.json.revision?.id;
  const reviseJobId = r.json.job?.id;
  const replay = await send(a.cookie, "POST", `/api/v1/projects/${pid}/revisions`, revBody, { "idempotency-key": revKey });
  check("D5 repeated with the same key → replayed, one revision", replay.headers.get("idempotent-replayed") === "true" && (await db.collection("revisions").countDocuments({ projectId: oid(pid) })) === 1);
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: version.id, sceneId: scene.id, blocks: [{ narrationId: block.id, text: "During the job" }], expectedStateVersion: project.stateVersion + 1 });
  check("D3 while the change runs → 409 JOB_ALREADY_RUNNING", r.status === 409 && r.json.error?.code === "JOB_ALREADY_RUNNING");
  const done = await waitIdle(a.cookie, pid);
  ({ project, version } = await current(a.cookie, pid));
  check("revise job done: new ai_revision version, Changed = the scene, approval cleared", done.state === "storyboard_ready" && version.source === "ai_revision" && version.changedSceneIds?.join() === target.id && project.approvedPlanVersionId === null);
  const rev = await db.collection("revisions").findOne({ _id: oid(revisionId) });
  check("revision succeeded with diff and reply", rev?.status === "succeeded" && rev.resultPlanVersionId?.toHexString() === version.id && rev.diff?.changedSceneIds?.join() === target.id && /^Done\. I changed scene 3\./.test(rev.assistantReply ?? ""));
  check("counted 1 of the 20 when it asked Gemini; providerUsage 'revise' row", (await projectOf(pid))!.planRequestCount === countBefore + 1 && (await db.collection("providerUsage").countDocuments({ jobId: oid(reviseJobId), operation: "revise", outcome: "ok" })) === 1);
  r = await send(a.cookie, "GET", `/api/v1/projects/${pid}/revisions`);
  check("D6 lists the change with its reply", r.status === 200 && r.json.items?.[0]?.id === revisionId && r.json.items[0].status === "succeeded");
  page = (await (await fetch(`${base}/projects/${pid}/storyboard`, { headers: { cookie: a.cookie } })).text()).replace(/<!-- -->/g, "");
  check("page shows the Changed tag and the chat bubbles", page.includes("Changed") && page.includes("make this scene simpler") && page.includes("Done. I changed scene 3."));

  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/revisions`, { ...revBody, scope: "project", sceneId: undefined, message: "e2e nochange please", basePlanVersionId: version.id, expectedStateVersion: project.stateVersion }, { "idempotency-key": key() });
  await waitIdle(a.cookie, pid);
  const noChange = await db.collection("revisions").findOne({ _id: oid(r.json.revision?.id) });
  const noChangeJob = await db.collection("jobs").findOne({ _id: oid(r.json.job?.id) });
  check("a change that changes nothing → revision rejected with a reply, job needs_input, no new version", noChange?.status === "rejected" && /couldn't find anything to change/.test(noChange.assistantReply ?? "") && noChangeJob?.state === "needs_input" && (await current(a.cookie, pid)).version.id === version.id);

  ({ project, version } = await current(a.cookie, pid));
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/revisions`, { stage: "storyboard", scope: "project", message: "e2e busy: shorter", basePlanVersionId: version.id, expectedStateVersion: project.stateVersion }, { "idempotency-key": key() });
  const busyJob = r.json.job?.id as string;
  let st = await waitIdle(a.cookie, pid);
  r = await send(a.cookie, "GET", `/api/v1/jobs/${busyJob}`);
  check("busy → job failed PROVIDER_BUSY (retryable); storyboard unchanged; retry_job offered", r.json.state === "failed" && r.json.error?.code === "PROVIDER_BUSY" && r.json.error?.retryable === true && st.currentPlanVersionId === version.id && st.allowedActions?.includes("retry_job"));
  check("busy: revision failed", (await db.collection("revisions").findOne({ jobId: oid(busyJob) }))?.status === "failed");
  r = await send(a.cookie, "POST", `/api/v1/jobs/${busyJob}/retry`, {}, { "idempotency-key": key() });
  check("E2 Try again on the failed change → 202 attempt 2, revision pending", r.status === 202 && r.json.attempt === 2 && r.json.type === "revise" && (await db.collection("revisions").findOne({ jobId: oid(busyJob) }))?.status === "pending");
  st = await waitIdle(a.cookie, pid);
  check("…fails again (still busy); planRequestCount counted per attempt", st.state === "storyboard_ready" && (await projectOf(pid))!.planRequestCount === countBefore + 4);

  // ---------- the 20 cap ----------
  await db.collection("projects").updateOne({ _id: oid(pid) }, { $set: { planRequestCount: 20 } });
  ({ project, version } = await current(a.cookie, pid));
  check("at 20: request_revision and retry_job no longer offered", !project.allowedActions.includes("request_revision") && !project.allowedActions.includes("retry_job"));
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/revisions`, { stage: "storyboard", scope: "project", message: "make it shorter", basePlanVersionId: version.id, expectedStateVersion: project.stateVersion }, { "idempotency-key": key() });
  check("at 20: D5 → 429 QUOTA_EXCEEDED plan_requests_per_project, resetsAt null; nothing saved", r.status === 429 && r.json.error?.details?.quota === "plan_requests_per_project" && r.json.error?.details?.resetsAt === null && (await projectOf(pid))?.activeJobId === null);
  r = await send(a.cookie, "POST", `/api/v1/jobs/${busyJob}/retry`, {}, { "idempotency-key": key() });
  check("at 20: E2 on the failed change → 429", r.status === 429);
  const before20 = await db.collection("planVersions").countDocuments({ projectId: oid(pid) });
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: version.id, sceneId: twoParts.id, blocks: twoParts.narration.slice(0, 2).map((n: Json) => ({ narrationId: n.id, text: `${n.text} Still editable.` })), expectedStateVersion: project.stateVersion });
  check("at 20: narration edits still work (no AI); two parts of a scene → ONE new version", r.status === 201 && (await db.collection("planVersions").countDocuments({ projectId: oid(pid) })) === before20 + 1);
  r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/revisions`, { stage: "storyboard", scope: "project", message: "x".repeat(501), basePlanVersionId: version.id, expectedStateVersion: project.stateVersion }, { "idempotency-key": key() });
  check("D5 message over 500 → 400", r.status === 400);

  // ---------- owner only ----------
  ({ project, version } = await current(a.cookie, pid));
  const sv = project.stateVersion;
  for (const [label, res] of [
    ["C3", await send(b.cookie, "GET", `/api/v1/projects/${pid}`)],
    ["D1", await send(b.cookie, "GET", `/api/v1/projects/${pid}/plan-versions`)],
    ["D2", await send(b.cookie, "GET", `/api/v1/projects/${pid}/plan-versions/current`)],
    ["D3", await send(b.cookie, "POST", `/api/v1/projects/${pid}/narration-edits`, { basePlanVersionId: version.id, sceneId: scene.id, blocks: [{ narrationId: block.id, text: "hi" }], expectedStateVersion: sv })],
    ["D4", await send(b.cookie, "POST", `/api/v1/projects/${pid}/voice`, { basePlanVersionId: version.id, voiceGender: "male", expectedStateVersion: sv })],
    ["D5", await send(b.cookie, "POST", `/api/v1/projects/${pid}/revisions`, { stage: "storyboard", scope: "project", message: "hello", basePlanVersionId: version.id, expectedStateVersion: sv }, { "idempotency-key": key() })],
    ["D6", await send(b.cookie, "GET", `/api/v1/projects/${pid}/revisions`)],
    ["D7", await send(b.cookie, "POST", `/api/v1/projects/${pid}/plan-versions/${approvedId}/restore`, { expectedStateVersion: sv })],
    ["D8", await send(b.cookie, "POST", `/api/v1/projects/${pid}/storyboard-approval`, { planVersionId: version.id, planHash: version.planHash, expectedStateVersion: sv }, { "idempotency-key": key() })],
    ["E2", await send(b.cookie, "POST", `/api/v1/jobs/${busyJob}/retry`, {}, { "idempotency-key": key() })],
  ] as const) check(`another user: ${label} → 404 NOT_FOUND`, res.status === 404 && res.json.error?.code === "NOT_FOUND", `status ${res.status}`);
  check("another user: storyboard page → 404", (await fetch(`${base}/projects/${pid}/storyboard`, { headers: { cookie: b.cookie } })).status === 404);
  check("project unchanged by the other user", (await projectOf(pid))?.stateVersion === sv);
  check("signed out: D2 → 401", (await send("", "GET", `/api/v1/projects/${pid}/plan-versions/current`)).status === 401);
  check("no Origin: D3 → 403", (await fetch(`${base}/api/v1/projects/${pid}/narration-edits`, { method: "POST", headers: { cookie: a.cookie, "content-type": "application/json", origin: "https://evil.example" }, body: "{}" })).status === 403);
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error("E2E crashed:", error instanceof Error ? error.stack : error);
  })
  .finally(async () => {
    await closeMongoClient();
    console.log(failures === 0 ? "\nAll F16-F20 checks passed." : `\n${failures} check(s) failed.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
