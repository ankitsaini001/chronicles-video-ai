import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { addInvite, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, newPlanJob, readDbConfig, usagePeriods } from "@bytereel/db";
import { ObjectId } from "mongodb";

/**
 * F15 end-to-end check over real HTTP: a running `next start` server whose Gemini is the local
 * stand-in (E2E_FAKE_GEMINI=1, apps/web/lib/brainstorm/fake-gemini.ts: NO real AI call) and a
 * private Inngest Dev Server on port 8299 (never the default 8288).
 * Checks C2 (202 + queued job) → plan-video (Inngest) → plan version 1, the repair, PLAN_INVALID,
 * PROVIDER_BUSY, PROVIDER_REJECTED, C4 edit idea, E2 retry (an attempt that asks Gemini counts 1 of 20, 429 at the limit, not
 * counted toward 5/day), C6/E1 polling, owner-only 404s, the stuck-job rule (dead job → failed,
 * lost event → sent again), the providerUsage log, the indexes and the project page.
 * SAFETY: works only on the separate test database `bytereel_test`, port 3230–3239.
 *
 *   1. in apps/web:  npx next build
 *   2. npx --yes inngest-cli@1.49.0 dev --no-discovery -u http://localhost:3236/api/inngest --port 8299 \
 *        --connect-gateway-port 8298 --connect-gateway-grpc-port 50062 --connect-executor-grpc-port 50063
 *   3. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3236 E2E_FAKE_GEMINI=1 \
 *        INNGEST_DEV=http://localhost:8299 npx next start -p 3236
 *   4. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3236 E2E_FAKE_GEMINI=1 npx tsx tools/e2e/f15-storyboard.ts
 *   5. drop the bytereel_test database afterwards
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has E2E_FAKE_GEMINI=1, MONGODB_DB=bytereel_test and INNGEST_DEV on port 8299.
 * Uses only @example.com emails and random throw-away passwords. Prints no secrets.
 */

const TEST_DB = "bytereel_test";
process.loadEnvFile(".env");
const base = process.env.E2E_BASE_URL ?? "";
if (!/^http:\/\/localhost:323\d$/.test(base)) throw new Error("Set E2E_BASE_URL to http://localhost:3230–3239 (never port 3000).");
if (process.env.E2E_FAKE_GEMINI !== "1") throw new Error("Run with E2E_FAKE_GEMINI=1, and start the server with it too: this check must never call the real Gemini.");
const settings = readDbConfig(process.env);
if (!settings.ok) throw new Error(settings.problems.join(" "));
if (settings.config.dbName !== TEST_DB) throw new Error(`Refusing to run: MONGODB_DB must be ${TEST_DB}.`);
const db = getDb(settings.config);

function serverSettings(port: string): { fake: boolean; testDb: boolean; inngest: boolean } {
  const listing = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
  const pid = /pid=(\d+)/.exec(listing)?.[1];
  if (!pid) throw new Error(`No server process found on port ${port} (start it first, see the header).`);
  const env = new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  return { fake: env.get("E2E_FAKE_GEMINI") === "1", testDb: env.get("MONGODB_DB") === TEST_DB, inngest: env.get("INNGEST_DEV") === "http://localhost:8299" };
}
const server = serverSettings(new URL(base).port);
if (!server.fake || !server.testDb || !server.inngest) {
  throw new Error("Stopping before any request: the server must run with E2E_FAKE_GEMINI=1, MONGODB_DB=bytereel_test and INNGEST_DEV=http://localhost:8299.");
}

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
const createProject = (cookie: string, text: string, k = key()) => send(cookie, "POST", "/api/v1/projects", { inputType: text.length > 300 ? "notes" : "topic", text, language: "en", voiceGender: "female" }, { "idempotency-key": k });
const status = (cookie: string, projectId: string) => send(cookie, "GET", `/api/v1/projects/${projectId}/status`);
const retry = (cookie: string, jobId: string, k = key()) => send(cookie, "POST", `/api/v1/jobs/${jobId}/retry`, {}, { "idempotency-key": k });
const editIdea = (cookie: string, projectId: string, body: unknown) => send(cookie, "PATCH", `/api/v1/projects/${projectId}`, body);
const usageRows = (jobId: string) => db.collection("providerUsage").find({ jobId: new ObjectId(jobId) }).sort({ at: 1, _id: 1 }).toArray();
const projectsToday = async (ownerId: ObjectId) => (await db.collection("usageCounters").findOne({ ownerId, kind: "projects", period: usagePeriods("Asia/Kolkata").day }))?.count ?? 0;

/** Poll C6 every 500 ms until the project leaves `planning` (or the time is up). */
async function waitDone(cookie: string, projectId: string, timeoutMs = 60_000): Promise<{ status: Json; messages: string[] }> {
  const messages: string[] = [];
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await status(cookie, projectId);
    const message = r.json.activeJob?.progress?.message;
    if (message && messages.at(-1) !== message) messages.push(message);
    if (r.json.state !== "planning" || Date.now() > end) return { status: r.json, messages };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function signUp(label: string): Promise<{ cookie: string; id: ObjectId }> {
  const email = `f15-e2e-${label}-${tag}@example.com`;
  await addInvite(db, email, { note: "F15 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `F15 Tester ${label}`, email, password: `E2e-${randomBytes(9).toString("base64url")}` }),
  });
  check(`test account ${label} created through sign-up`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId };
}

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F14", "F15"]));
  const jobIndexes = (await db.collection("jobs").indexes()).map((i) => i.name);
  const versionIndexes = (await db.collection("planVersions").indexes()).map((i) => i.name);
  check(
    "F15 indexes created on the test database (jobs ×3, planVersions ×2)",
    ["idempotencyKey_unique", "projectId_createdAt", "state_updatedAt"].every((n) => jobIndexes.includes(n)) && ["projectId_versionNumber_unique", "ownerId_projectId"].every((n) => versionIndexes.includes(n)),
  );
  await db.collection("rateLimits").deleteMany({});

  const a = await signUp("a");
  const b = await signUp("b");

  // --- 1. Happy path: C2 → queued job → plan-video → plan version 1.
  let r = await createProject(a.cookie, "Why do we see lightning before we hear thunder?");
  const project = r.json.project ?? {};
  const job = r.json.job ?? {};
  check("C2 → 202 with project and job", r.status === 202 && typeof project.id === "string" && typeof job.id === "string", `status ${r.status}`);
  check("C2: project `planning`, activeJobType plan, activeJobId = job, stateVersion 1", project.state === "planning" && project.activeJobType === "plan" && project.activeJobId === job.id && project.stateVersion === 1 && project.activeJob === null);
  check("C2: job `plan` queued, attempt 1, stages plan+validate pending, pollAfterMs 2000", job.type === "plan" && job.state === "queued" && job.attempt === 1 && job.stages?.map((s: Json) => `${s.name}:${s.status}`).join() === "plan:pending,validate:pending" && job.pollAfterMs === 2000);
  const jobDoc = await db.collection("jobs").findOne({ _id: new ObjectId(job.id as string) });
  check("job key is plan:{projectId}:{inputHash}", typeof jobDoc?.idempotencyKey === "string" && new RegExp(`^plan:${project.id}:[0-9a-f]{64}$`).test(jobDoc.idempotencyKey));
  const projectDoc = await db.collection("projects").findOne({ _id: new ObjectId(project.id as string) });
  check("project saved with planRequestCount 0 (counted only when the job asks Gemini)", projectDoc?.planRequestCount === 0);

  const replay = await createProject(a.cookie, "Why do we see lightning before we hear thunder?", "fixed-key-" + tag);
  const replay2 = await createProject(a.cookie, "Why do we see lightning before we hear thunder?", "fixed-key-" + tag);
  check("same Idempotency-Key twice → same project, replayed, one job", replay2.headers.get("idempotent-replayed") === "true" && replay2.json.project?.id === replay.json.project?.id && (await db.collection("jobs").countDocuments({ projectId: new ObjectId(replay.json.project.id as string) })) === 1);

  let done = await waitDone(a.cookie, project.id);
  check("plan-video ran: project `storyboard_ready`, polling stops (pollAfterMs null)", done.status.state === "storyboard_ready" && done.status.pollAfterMs === null && done.status.activeJob === null, `${done.status.state}; progress seen: ${done.messages.join(" | ")}`);
  const version = await db.collection("planVersions").findOne({ projectId: new ObjectId(project.id as string) });
  check("plan version 1 saved: ai_plan, valid, hash, stats, plannerUsage", version?.versionNumber === 1 && version.source === "ai_plan" && version.validation?.valid === true && /^sha256:[0-9a-f]{64}$/.test(version.planHash) && version.stats?.sceneCount >= 3 && version.plannerUsage?.attempts === 1);
  check("the plan carries code-owned ids (owner, project, version = the document id)", version?.plan?.ownerId === a.id.toHexString() && version?.plan?.projectId === project.id && version?.plan?.versionId === version?._id.toHexString() && version?.plan?.voicePreset === "indian-english-female");
  check("after the job asked Gemini once: planRequestCount 1", (await db.collection("projects").findOne({ _id: new ObjectId(project.id as string) }))?.planRequestCount === 1);
  check("C6: currentPlanVersionId points to it; title is the plan's topic", done.status.currentPlanVersionId === version?._id.toHexString() && (await db.collection("projects").findOne({ _id: new ObjectId(project.id as string) }))?.title === version?.plan?.topic);
  r = await send(a.cookie, "GET", `/api/v1/jobs/${job.id}`);
  check("E1: job succeeded, stages succeeded, result.planVersionId, pollAfterMs null", r.status === 200 && r.json.state === "succeeded" && r.json.stages.every((s: Json) => s.status === "succeeded") && r.json.result?.planVersionId === version?._id.toHexString() && r.json.pollAfterMs === null);
  let rows = await usageRows(job.id);
  check("providerUsage: one Gemini 'plan' row, final ok, with project and job, no idea text", rows.length === 1 && rows[0]!.provider === "gemini" && rows[0]!.operation === "plan" && rows[0]!.status === "final" && rows[0]!.outcome === "ok" && String(rows[0]!.projectId) === project.id && !JSON.stringify(rows[0]).includes("lightning"));
  const html = (await (await fetch(`${base}/projects/${project.id}/storyboard`, { headers: { cookie: a.cookie } })).text()).replace(/<!-- -->/g, "");
  check("storyboard page shows the saved storyboard (scene cards with narration; F16)", html.includes("Scene 01") && html.includes(String(version?.plan?.scenes?.[0]?.narration?.[0]?.text ?? "").slice(0, 30).replace(/'/g, "&#x27;")));

  // --- 2. Owner only.
  for (const [label, res] of [
    ["C6", await status(b.cookie, project.id)],
    ["E1", await send(b.cookie, "GET", `/api/v1/jobs/${job.id}`)],
    ["E2", await retry(b.cookie, job.id)],
    ["C4", await editIdea(b.cookie, project.id, { text: "Something else", expectedStateVersion: 2 })],
  ] as const) check(`another user: ${label} → 404 NOT_FOUND`, res.status === 404 && res.json.error?.code === "NOT_FOUND", `status ${res.status}`);
  check("another user: project page → 404", (await fetch(`${base}/projects/${project.id}`, { headers: { cookie: b.cookie } })).status === 404);
  check("malformed ids → 404", (await status(a.cookie, "nope")).status === 404 && (await send(a.cookie, "GET", "/api/v1/jobs/123")).status === 404);
  check("signed out: C6 → 401", (await status("", project.id)).status === 401);

  // --- 3. Rules on a finished project.
  r = await retry(a.cookie, job.id);
  check("E2 on a succeeded job → 409 INVALID_STATE", r.status === 409 && r.json.error?.code === "INVALID_STATE");
  r = await send(a.cookie, "POST", `/api/v1/jobs/${job.id}/retry`, {});
  check("E2 without Idempotency-Key → 400", r.status === 400);
  r = await editIdea(a.cookie, project.id, { text: "A new idea", expectedStateVersion: done.status.stateVersion });
  check("C4 edit idea on storyboard_ready → 409 INVALID_STATE", r.status === 409 && r.json.error?.code === "INVALID_STATE");

  // --- 4. Repair: invalid first answer, valid after the one repair.
  r = await createProject(a.cookie, "e2e repair: how rainbows form");
  done = await waitDone(a.cookie, r.json.project.id);
  rows = await usageRows(r.json.job.id);
  check("repair: invalid answer → one repair → storyboard_ready", done.status.state === "storyboard_ready", done.status.state);
  check("repair: two Gemini rows (invalid_output, then ok)", rows.map((x) => x.outcome).join() === "invalid_output,ok");

  // --- 5. Still invalid after the repair → PLAN_INVALID; then Edit idea + Try again.
  const before = await projectsToday(a.id);
  r = await createProject(a.cookie, "e2e invalid: photosynthesis");
  const invalidProject = r.json.project.id as string;
  const invalidJob = r.json.job.id as string;
  done = await waitDone(a.cookie, invalidProject);
  check("invalid twice → plan_failed, lastError PLAN_INVALID with the plain message", done.status.state === "plan_failed" && done.status.lastError?.code === "PLAN_INVALID" && done.status.lastError?.message === "Couldn't build a good storyboard, try rephrasing.");
  check("plan_failed: allowedActions edit_idea + retry_job, polling stops", done.status.allowedActions?.join() === "edit_idea,retry_job" && done.status.pollAfterMs === null);
  r = await send(a.cookie, "GET", `/api/v1/jobs/${invalidJob}`);
  check("E1: failed, error PLAN_INVALID retryable, validate stage failed", r.json.state === "failed" && r.json.error?.code === "PLAN_INVALID" && r.json.error?.retryable === true && r.json.stages?.[1]?.status === "failed");
  check("invalid: two Gemini rows, both invalid_output", (await usageRows(invalidJob)).map((x) => x.outcome).join() === "invalid_output,invalid_output");
  const failedPage = (await (await fetch(`${base}/projects/${invalidProject}`, { headers: { cookie: a.cookie } })).text()).replace(/<!-- -->/g, "");
  check("page after failure: message, Try again and Edit idea", failedPage.includes("Couldn&#x27;t build a good storyboard, try rephrasing.") && failedPage.includes("Try again") && failedPage.includes("Edit idea"));

  r = await editIdea(a.cookie, invalidProject, { text: "Why is the sky blue?", expectedStateVersion: done.status.stateVersion - 1 });
  check("C4 with an old stateVersion → 409 STALE_VERSION with currentStateVersion", r.status === 409 && r.json.error?.code === "STALE_VERSION" && r.json.error?.details?.currentStateVersion === done.status.stateVersion);
  r = await editIdea(a.cookie, invalidProject, { text: "ab", expectedStateVersion: done.status.stateVersion });
  check("C4 with a too-short idea → 400 INVALID_INPUT on text", r.status === 400 && r.json.error?.details?.issues?.[0]?.path === "text");
  r = await editIdea(a.cookie, invalidProject, { expectedStateVersion: done.status.stateVersion });
  check("C4 without text → 400 INVALID_INPUT", r.status === 400);
  r = await editIdea(a.cookie, invalidProject, { text: "  Why is the sky blue?  ", expectedStateVersion: done.status.stateVersion });
  check("C4 edit idea → 200: new text and title, still plan_failed, stateVersion +1, retry_job allowed", r.status === 200 && r.json.input?.text === "Why is the sky blue?" && r.json.title === "Why is the sky blue?" && r.json.state === "plan_failed" && r.json.stateVersion === done.status.stateVersion + 1 && r.json.allowedActions?.includes("retry_job"));
  const retryKey = key();
  r = await retry(a.cookie, invalidJob, retryKey);
  check("E2 after the edit → 202: same job, attempt 2, queued", r.status === 202 && r.json.id === invalidJob && r.json.attempt === 2 && r.json.state === "queued" && r.json.error === null);
  const again = await retry(a.cookie, invalidJob, retryKey);
  check("E2 repeated with the same key → replayed, no second retry", again.headers.get("idempotent-replayed") === "true" && again.json.attempt === 2);
  const retriedJob = await db.collection("jobs").findOne({ _id: new ObjectId(invalidJob) });
  check("E2: job key updated to the edited idea's hash; retry event id {jobId}:retry:2", retriedJob?.idempotencyKey !== jobDoc?.idempotencyKey && retriedJob?.event?.id === `${invalidJob}:retry:2`);
  done = await waitDone(a.cookie, invalidProject);
  check("after Edit idea + Try again → storyboard_ready", done.status.state === "storyboard_ready", done.status.state);
  const counted = await db.collection("projects").findOne({ _id: new ObjectId(invalidProject) });
  check("Try again counted 1 toward the project's 20 (planRequestCount 2)", counted?.planRequestCount === 2);
  check("Edit idea + Try again did not use a daily project", (await projectsToday(a.id)) === before + 1);

  // --- 6. Busy: Gemini stays busy → PROVIDER_BUSY after the retries; Try again works (counts 1).
  r = await createProject(a.cookie, "e2e busy: how vaccines work");
  const busyProject = r.json.project.id as string;
  const busyJob = r.json.job.id as string;
  done = await waitDone(a.cookie, busyProject, 90_000);
  check("busy → plan_failed PROVIDER_BUSY with 'Your idea is saved' message", done.status.state === "plan_failed" && done.status.lastError?.code === "PROVIDER_BUSY" && /Your idea is saved/.test(done.status.lastError?.message ?? ""), `${done.status.state} ${done.status.lastError?.code}`);
  rows = await usageRows(busyJob);
  check("busy: exactly 3 Gemini requests (first + 2 retries), each logged as failed/busy", rows.length === 3 && rows.every((x) => x.status === "failed" && x.outcome === "busy"), `${rows.length} rows`);
  check("busy: progress said it was trying again", done.messages.some((m) => /trying again/.test(m)), done.messages.join(" | "));
  r = await retry(a.cookie, busyJob);
  check("busy: Try again without editing → 202", r.status === 202 && r.json.attempt === 2);
  done = await waitDone(a.cookie, busyProject, 90_000);
  check("busy again → plan_failed; planRequestCount 2", done.status.state === "plan_failed" && (await db.collection("projects").findOne({ _id: new ObjectId(busyProject) }))?.planRequestCount === 2);

  // --- 7. Per-project limit: at 20 the Try again is refused, nothing changes.
  await db.collection("projects").updateOne({ _id: new ObjectId(busyProject) }, { $set: { planRequestCount: 20 } });
  const capped = await status(a.cookie, busyProject);
  check("at 20 requests: retry_job no longer offered", capped.json.allowedActions?.join() === "edit_idea");
  r = await retry(a.cookie, busyJob);
  check("at 20 requests: E2 → 429 QUOTA_EXCEEDED plan_requests_per_project, resetsAt null", r.status === 429 && r.json.error?.details?.quota === "plan_requests_per_project" && r.json.error?.details?.limit === 20 && r.json.error?.details?.resetsAt === null);
  const after = await db.collection("projects").findOne({ _id: new ObjectId(busyProject) });
  check("at 20 requests: project unchanged (plan_failed, count 20)", after?.state === "plan_failed" && after?.planRequestCount === 20 && after?.activeJobId === null);
  await db.collection("projects").updateOne({ _id: new ObjectId(busyProject) }, { $set: { planRequestCount: 2 } });

  // --- 8. Two Try again clicks at the same moment (different keys): only one starts a run.
  const both = await Promise.all([retry(a.cookie, busyJob), retry(a.cookie, busyJob)]);
  check("two simultaneous Try again clicks → one 202, one 409", both.map((x) => x.status).sort().join() === "202,409", both.map((x) => `${x.status} ${x.json.error?.code ?? ""}`).join(", "));
  r = await editIdea(a.cookie, busyProject, { text: "Why is the sky blue?", expectedStateVersion: (await status(a.cookie, busyProject)).json.stateVersion });
  check("C4 while the storyboard is being written → 409 JOB_ALREADY_RUNNING", r.status === 409 && r.json.error?.code === "JOB_ALREADY_RUNNING");
  await waitDone(a.cookie, busyProject, 90_000);
  check("…and only one counted (planRequestCount 3)", (await db.collection("projects").findOne({ _id: new ObjectId(busyProject) }))?.planRequestCount === 3);

  // --- 9. Safety block → PROVIDER_REJECTED: no Try again until the idea is edited (user b: a used its 5 projects today).
  r = await createProject(b.cookie, "e2e unsafe: something not allowed");
  const unsafeProject = r.json.project.id as string;
  const unsafeJob = r.json.job.id as string;
  done = await waitDone(b.cookie, unsafeProject);
  check("safety → plan_failed PROVIDER_REJECTED, only edit_idea allowed", done.status.lastError?.code === "PROVIDER_REJECTED" && done.status.allowedActions?.join() === "edit_idea");
  check("safety: one Gemini row, rejected, no retries", (await usageRows(unsafeJob)).map((x) => x.outcome).join() === "rejected");
  r = await retry(b.cookie, unsafeJob);
  check("safety: E2 without editing → 409 INVALID_STATE", r.status === 409 && r.json.error?.code === "INVALID_STATE");
  r = await editIdea(b.cookie, unsafeProject, { text: "How do volcanoes erupt?", expectedStateVersion: done.status.stateVersion });
  check("safety: after Edit idea, retry_job is offered", r.status === 200 && r.json.allowedActions?.join() === "edit_idea,retry_job");
  r = await retry(b.cookie, unsafeJob);
  done = await waitDone(b.cookie, unsafeProject);
  check("safety: Edit idea + Try again → storyboard_ready", r.status === 202 && done.status.state === "storyboard_ready");

  // --- 10. Stuck-job rule.
  const stuckId = new ObjectId();
  const now = new Date();
  const input = { type: "topic", text: "A job that died", brainstormChoice: null };
  const stuckJob = newPlanJob({ ownerId: a.id, projectId: stuckId, project: { input, language: "en", voiceGender: "female" }, now });
  const old = new Date(Date.now() - 11 * 60_000);
  await db.collection("jobs").insertOne({ ...stuckJob, state: "running", attempt: 1, updatedAt: old, startedAt: old, event: { ...stuckJob.event, sentAt: old, lastTriedAt: old } });
  await db.collection("projects").insertOne({
    _id: stuckId, ownerId: a.id, schemaVersion: 1, title: "A job that died", language: "en", voiceGender: "female", input, state: "planning",
    currentPlanVersionId: null, approvedPlanVersionId: null, currentRenderId: null, activeJobId: stuckJob._id, stateVersion: 1, planRequestCount: 0,
    lastError: null, createdAt: old, updatedAt: old, archivedAt: null,
  });
  const stuck = await status(a.cookie, stuckId.toHexString());
  check("running job with no update for 10+ min → failed INTERNAL, retryable, project plan_failed", stuck.json.state === "plan_failed" && stuck.json.lastError?.code === "INTERNAL" && stuck.json.allowedActions?.includes("retry_job") && stuck.json.pollAfterMs === null);
  check("a job that never asked Gemini cost nothing toward the 20 (planRequestCount still 0)", (await db.collection("projects").findOne({ _id: stuckId }))?.planRequestCount === 0);

  const lostId = new ObjectId();
  const lostInput = { type: "topic", text: "A job whose event was lost", brainstormChoice: null };
  const lostJob = newPlanJob({ ownerId: a.id, projectId: lostId, project: { input: lostInput, language: "en", voiceGender: "female" }, now });
  await db.collection("jobs").insertOne(lostJob);
  await db.collection("projects").insertOne({
    _id: lostId, ownerId: a.id, schemaVersion: 1, title: "A job whose event was lost", language: "en", voiceGender: "female", input: lostInput, state: "planning",
    currentPlanVersionId: null, approvedPlanVersionId: null, currentRenderId: null, activeJobId: lostJob._id, stateVersion: 1, planRequestCount: 1,
    lastError: null, createdAt: now, updatedAt: now, archivedAt: null,
  });
  done = await waitDone(a.cookie, lostId.toHexString());
  check("queued job whose event never reached Inngest → sent again on the next poll → storyboard_ready", done.status.state === "storyboard_ready", done.status.state);

  // --- 11. No secrets or provider details in page scripts.
  const scripts = [...failedPage.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
  let leaks = 0;
  for (const src of scripts) {
    const code = await (await fetch(new URL(src, base))).text();
    if (/generativelanguage|GEMINI_API_KEY|INNGEST_SIGNING_KEY|INNGEST_EVENT_KEY|E2E_FAKE_GEMINI|fake-gemini-e2e|@google\/genai/i.test(code)) leaks++;
  }
  check("no page script mentions Gemini, Inngest keys or the test switch", scripts.length > 0 && leaks === 0, `${scripts.length} scripts`);
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error("E2E crashed:", error instanceof Error ? error.message : error);
  })
  .finally(async () => {
    await closeMongoClient();
    console.log(failures === 0 ? "\nAll F15 checks passed." : `\n${failures} check(s) failed.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
