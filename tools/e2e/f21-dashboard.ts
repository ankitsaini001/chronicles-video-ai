import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { addInvite, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, newPlanJob, readDbConfig } from "@bytereel/db";
import { ObjectId } from "mongodb";

/**
 * F21 end-to-end check over real HTTP ("My videos": C1 list + tabs + pages, C4 rename, C5 archive,
 * the cards and the first-visit page). NO AI call: the projects are written straight into the test
 * database, nothing starts a job.
 * SAFETY: works only on the separate test database `bytereel_test`, port 3230–3239 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3231 E2E_FAKE_GEMINI=1 \
 *        INNGEST_DEV=http://localhost:8299 npx next start -p 3231
 *      (nothing listens on 8299: if anything tried to start a job, it would go nowhere)
 *   3. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3231 npx tsx tools/e2e/f21-dashboard.ts
 *   4. drop the bytereel_test database afterwards
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has MONGODB_DB=bytereel_test, E2E_FAKE_GEMINI=1 and INNGEST_DEV on port 8299.
 */

const TEST_DB = "bytereel_test";
process.loadEnvFile(".env");
const base = process.env.E2E_BASE_URL ?? "";
if (!/^http:\/\/localhost:323\d$/.test(base)) throw new Error("Set E2E_BASE_URL to http://localhost:3230–3239 (never port 3000).");
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
if (!serverSettings(new URL(base).port)) throw new Error("Stopping before any request: the server must run with MONGODB_DB=bytereel_test, E2E_FAKE_GEMINI=1 and INNGEST_DEV=http://localhost:8299.");

const tag = randomBytes(4).toString("hex");
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

type Json = Record<string, any>;
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const send = async (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { origin: base, cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, headers: r.headers, json: (await r.json().catch(() => ({}))) as Json };
};
const html = async (cookie: string, path: string) => {
  const r = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location") ?? "", text: (await r.text()).replace(/<!-- -->/g, "") };
};
const oid = (id: string) => new ObjectId(id);
const projects = () => db.collection("projects");

async function signUp(label: string): Promise<{ cookie: string; id: ObjectId }> {
  const email = `f21-e2e-${label}-${tag}@example.com`;
  await addInvite(db, email, { note: "F21 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `F21 Tester ${label}`, email, password: `E2e-${randomBytes(9).toString("base64url")}` }),
  });
  check(`test account ${label} created`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId };
}

const T0 = Date.parse("2026-11-14T08:00:00.000Z");

/** A project written straight into the test database (no job, no AI). */
async function seed(ownerId: ObjectId, title: string, state: string, minutesAgo: number, extra: Json = {}): Promise<string> {
  const _id = new ObjectId();
  const at = new Date(T0 - minutesAgo * 60_000);
  await projects().insertOne({
    _id,
    ownerId,
    schemaVersion: 1,
    title,
    language: "en",
    voiceGender: "female",
    input: { type: "topic", text: title, brainstormChoice: null },
    state,
    currentPlanVersionId: null,
    approvedPlanVersionId: null,
    currentRenderId: null,
    activeJobId: null,
    stateVersion: 3,
    planRequestCount: 1,
    lastError: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    ...extra,
  });
  return _id.toHexString();
}

/** A storyboard version from the water-cycle fixture, so the storyboard page can open (no AI). */
async function seedStoryboard(ownerId: ObjectId, projectId: string): Promise<ObjectId> {
  const plan = JSON.parse(readFileSync("fixtures/water-cycle.plan.json", "utf8"));
  const versionId = new ObjectId();
  Object.assign(plan, { projectId, ownerId: ownerId.toHexString(), versionId: versionId.toHexString(), parentVersionId: null });
  await db.collection("planVersions").insertOne({
    _id: versionId,
    ownerId,
    projectId: oid(projectId),
    schemaVersion: 1,
    versionNumber: 1,
    parentVersionId: null,
    source: "ai_plan",
    plan,
    planHash: `sha256:${"0".repeat(64)}`,
    validation: { valid: true, issues: [], warnings: [] },
    stats: { sceneCount: plan.scenes.length, wordCount: 150, estimatedSeconds: 70 },
    plannerUsage: null,
    createdAt: new Date(T0),
  });
  await projects().updateOne({ _id: oid(projectId) }, { $set: { currentPlanVersionId: versionId } });
  return versionId;
}

const ids = (r: { json: Json }) => (r.json.items ?? []).map((i: Json) => i.id as string);

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F15", "F21"]));
  check("F21 index created on the test database", (await db.collection("projects").indexes()).some((i) => i.name === "ownerId_updatedAt_id"));
  await db.collection("rateLimits").deleteMany({});
  const a = await signUp("a");
  const b = await signUp("b");
  const c = await signUp("c");

  // ---------- the first-visit page (no projects at all) ----------
  let page = await html(c.cookie, "/dashboard");
  check("no projects → first-visit page: How it works, the four steps, Create your first video", page.status === 200 && ["How it works", "Idea", "Storyboard", "Video", "Post", "Create your first video"].every((t) => page.text.includes(t)));
  check("first-visit cards from B1: today 0 of 3 videos / 0 of 5 projects, 0 of 3,000 voice characters, Instagram not connected", ["Today", "0 of 3<", "0 of 5<", "This month", "0 of 3,000", "Instagram", "Not connected"].every((t) => page.text.includes(t)));
  check("first-visit page: no tabs, no + New video, no cards", !page.text.includes('aria-label="Filter videos"') && !page.text.includes("+ New video") && !page.text.includes('aria-label="Your videos"'));
  let r = await send(c.cookie, "GET", "/api/v1/projects");
  check("C1 with no projects → 200 { items: [], nextCursor: null }", r.status === 200 && r.json.items?.length === 0 && r.json.nextCursor === null);

  // ---------- seed: A has projects in every tab, B has one ----------
  const draft = await seed(a.id, "A draft idea", "draft", 5);
  const planJobId = new ObjectId();
  const planning = await seed(a.id, "Writing this one", "planning", 1, { activeJobId: planJobId });
  // Just enough of a running plan job for the card to know a job runs (this page never runs it).
  await db.collection("jobs").insertOne({ _id: planJobId, ownerId: a.id, projectId: oid(planning), schemaVersion: 1, type: "plan", state: "running", idempotencyKey: `e2e:${planJobId.toHexString()}`, createdAt: new Date(T0), updatedAt: new Date() });
  const failed = await seed(a.id, "Failed storyboard", "plan_failed", 30, { lastError: { code: "PROVIDER_BUSY", message: "Busy", at: new Date(T0) } });
  const ready = await seed(a.id, "Storyboard to review", "storyboard_ready", 10);
  await seedStoryboard(a.id, ready);
  const approved = await seed(a.id, "Approved storyboard", "storyboard_ready", 20);
  const approvedVersion = await seedStoryboard(a.id, approved);
  await projects().updateOne({ _id: oid(approved) }, { $set: { approvedPlanVersionId: approvedVersion } });
  const videoReady = await seed(a.id, "A finished video", "video_ready", 40);
  const postFailed = await seed(a.id, "Post that failed", "publish_failed", 45);
  const scheduled = await seed(a.id, "Scheduled post", "scheduled", 50);
  const published = await seed(a.id, "Already published", "published", 60);
  const alreadyArchived = await seed(a.id, "Old archived one", "archived", 2, { stateBeforeArchive: "draft", archivedAt: new Date(T0) });
  const hindi = await seed(a.id, "बचत खाता बनाम FD", "draft", 70, { language: "hi" });
  const bOnly = await seed(b.id, "B's private project", "draft", 3);

  // ---------- C1: own projects only, newest first, tabs ----------
  r = await send(a.cookie, "GET", "/api/v1/projects");
  const expectedAll = [planning, draft, ready, approved, failed, videoReady, postFailed, scheduled, published, hindi];
  check("C1 (no tab) → A's non-archived projects, newest-updated first", r.status === 200 && ids(r).join() === expectedAll.join(), ids(r).join());
  check("C1 never lists the archived project or B's project", !ids(r).includes(alreadyArchived) && !ids(r).includes(bOnly));
  check("C1 headers: no-store and a request id", r.headers.get("cache-control") === "no-store" && /^req_/.test(r.headers.get("x-request-id") ?? ""));
  const first = r.json.items[0];
  check(
    "ProjectSummary shape: documented fields + stateVersion + storyboardApproved, no ownerId / idea text",
    Object.keys(first).sort().join() === "activeJobType,createdAt,currentStep,id,language,latestPost,state,stateVersion,storyboardApproved,thumbnailUrl,title,updatedAt,voiceGender" && !JSON.stringify(r.json).includes(a.id.toHexString()),
    Object.keys(first).sort().join(),
  );
  const byId = new Map<string, Json>(r.json.items.map((i: Json) => [i.id, i]));
  check("approved storyboard → storyboardApproved true; the other false", byId.get(approved)?.storyboardApproved === true && byId.get(ready)?.storyboardApproved === false);
  const tab = async (name: string) => ids(await send(a.cookie, "GET", `/api/v1/projects?tab=${name}`));
  check("tab=drafts → draft, planning, plan_failed, storyboard_ready", (await tab("drafts")).join() === [planning, draft, ready, approved, failed, hindi].join());
  check("tab=ready → video_ready and publish_failed", (await tab("ready")).join() === [videoReady, postFailed].join());
  check("tab=scheduled → scheduled", (await tab("scheduled")).join() === scheduled);
  check("tab=published → published", (await tab("published")).join() === published);
  r = await send(b.cookie, "GET", "/api/v1/projects");
  check("B sees only B's project", ids(r).join() === bOnly);
  r = await send(a.cookie, "GET", "/api/v1/projects?tab=archived");
  check("tab=archived (no such tab) → 400 INVALID_INPUT on tab", r.status === 400 && r.json.error?.details?.issues?.[0]?.path === "tab");
  check("limit 0 / 51 / repeated tab → 400", (await send(a.cookie, "GET", "/api/v1/projects?limit=0")).status === 400 && (await send(a.cookie, "GET", "/api/v1/projects?limit=51")).status === 400 && (await send(a.cookie, "GET", "/api/v1/projects?tab=ready&tab=drafts")).status === 400);
  check("C1 signed out → 401", (await send("", "GET", "/api/v1/projects")).status === 401);

  // ---------- pagination (cursor; equal updatedAt broken by _id) ----------
  const bulk: string[] = [];
  for (let i = 0; i < 23; i++) bulk.push(await seed(a.id, `Bulk draft ${String(i).padStart(2, "0")}`, "draft", i < 6 ? 100 : 100 + i)); // six share one updatedAt
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const p: { status: number; json: Json } = await send(a.cookie, "GET", `/api/v1/projects?tab=drafts&limit=7${cursor ? `&cursor=${cursor}` : ""}`);
    if (p.status !== 200) break;
    seen.push(...ids(p));
    cursor = p.json.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  const allDrafts = await projects().find({ ownerId: a.id, state: { $in: ["draft", "planning", "plan_failed", "storyboard_ready", "generating", "generate_failed"] } }).sort({ updatedAt: -1, _id: -1 }).toArray();
  check("pages of 7 cover every draft once, in order (no skip, no repeat), then nextCursor null", seen.length === 29 && new Set(seen).size === 29 && seen.join() === allDrafts.map((d) => d._id.toHexString()).join() && pages === 5, `${seen.length} in ${pages} pages`);
  r = await send(a.cookie, "GET", "/api/v1/projects?tab=drafts");
  check("default limit 20 with a nextCursor", r.json.items?.length === 20 && typeof r.json.nextCursor === "string");
  const draftsCursor = r.json.nextCursor as string;
  check("a drafts cursor used with another tab → 400 (invalid cursor)", (await send(a.cookie, "GET", `/api/v1/projects?tab=ready&cursor=${draftsCursor}`)).json.error?.details?.issues?.[0]?.path === "cursor");
  check("a tampered cursor → 400", (await send(a.cookie, "GET", `/api/v1/projects?tab=drafts&cursor=${draftsCursor.slice(0, -3)}abc`)).status === 400);
  check("A's cursor used by B → only B's projects (owner from the session)", ids(await send(b.cookie, "GET", `/api/v1/projects?tab=drafts&cursor=${draftsCursor}`)).every((id: string) => id === bOnly));

  // ---------- the My videos page ----------
  page = await html(a.cookie, "/dashboard");
  check("My videos page: + New video, tabs, cards, Load more (more than 20 drafts)", page.status === 200 && ["+ New video", 'aria-label="Filter videos"', 'aria-label="Your videos"', "Load more"].every((t) => page.text.includes(t)) && !page.text.includes("How it works"));
  check("cards show status labels and the updated time", ["Writing storyboard…", "Storyboard ready", "Approved", "Storyboard failed", "Idea saved", "Updated "].every((t) => page.text.includes(t)));
  check("a storyboard card links to /storyboard; others to the project page", page.text.includes(`href="/projects/${ready}/storyboard"`) && page.text.includes(`href="/projects/${failed}"`));
  check("a running job: no ⋯ menu on that card; others have one", !page.text.includes("More actions for &quot;Writing this one&quot;") && page.text.includes("More actions for &quot;Storyboard to review&quot;"));
  check("the page never shows B's or the archived project", !page.text.includes("B&#x27;s private project") && !page.text.includes("B's private project") && !page.text.includes("Old archived one"));
  page = await html(a.cookie, "/dashboard?tab=ready");
  check("Ready tab shows its cards", page.text.includes("A finished video") && page.text.includes("Video ready") && page.text.includes("Post failed") && !page.text.includes("A draft idea"));
  await projects().deleteOne({ _id: oid(published) });
  page = await html(a.cookie, "/dashboard?tab=published");
  check("an empty tab while other tabs have projects → a short friendly line (not the first-visit page)", page.text.includes("Nothing published yet.") && page.text.includes('aria-label="Filter videos"') && !page.text.includes("How it works"));

  // ---------- C4 rename ----------
  const before = await send(a.cookie, "GET", `/api/v1/projects/${ready}`);
  check("C3 lists rename first and archive last", before.json.allowedActions?.[0] === "rename" && before.json.allowedActions?.at(-1) === "archive", before.json.allowedActions?.join());
  const counters = await db.collection("usageCounters").find({ ownerId: a.id }).toArray();
  r = await send(a.cookie, "PATCH", `/api/v1/projects/${ready}`, { title: "  Rain,\n explained  ", expectedStateVersion: before.json.stateVersion });
  check("C4 rename → 200, title trimmed to one line, stateVersion +1, state unchanged", r.status === 200 && r.json.title === "Rain, explained" && r.json.stateVersion === before.json.stateVersion + 1 && r.json.state === "storyboard_ready" && r.json.currentPlanVersionId === before.json.currentPlanVersionId);
  check("rename counts toward no limit (usage counters unchanged)", JSON.stringify(await db.collection("usageCounters").find({ ownerId: a.id }).toArray()) === JSON.stringify(counters));
  check("renamed project moves to the top of the list", ids(await send(a.cookie, "GET", "/api/v1/projects?limit=1")).join() === ready);
  r = await send(a.cookie, "PATCH", `/api/v1/projects/${ready}`, { title: "Again", expectedStateVersion: before.json.stateVersion });
  check("C4 with the old stateVersion (another tab) → 409 STALE_VERSION, nothing changed", r.status === 409 && r.json.error?.code === "STALE_VERSION" && (await projects().findOne({ _id: oid(ready) }))?.title === "Rain, explained");
  const sv = (await projects().findOne({ _id: oid(ready) }))!.stateVersion as number;
  check("C4 empty title → 400", (await send(a.cookie, "PATCH", `/api/v1/projects/${ready}`, { title: "   ", expectedStateVersion: sv })).status === 400);
  check("C4 title of 121 characters → 400", (await send(a.cookie, "PATCH", `/api/v1/projects/${ready}`, { title: "x".repeat(121), expectedStateVersion: sv })).status === 400);
  check("C4 title of 120 characters → 200", (await send(a.cookie, "PATCH", `/api/v1/projects/${ready}`, { title: "y".repeat(120), expectedStateVersion: sv })).status === 200);
  check("C4 unknown field → 400", (await send(a.cookie, "PATCH", `/api/v1/projects/${ready}`, { title: "x", language: "hi", expectedStateVersion: sv + 1 })).status === 400);
  check("C4 text on a storyboard project → 409 INVALID_STATE (edit idea is only after a failure)", (await send(a.cookie, "PATCH", `/api/v1/projects/${ready}`, { text: "A new idea here", expectedStateVersion: sv + 1 })).json.error?.code === "INVALID_STATE");
  r = await send(b.cookie, "PATCH", `/api/v1/projects/${ready}`, { title: "Hijack", expectedStateVersion: sv + 1 });
  check("B renaming A's project → 404 NOT_FOUND", r.status === 404 && r.json.error?.code === "NOT_FOUND");
  check("rename while a job runs → 409 JOB_ALREADY_RUNNING", (await send(a.cookie, "PATCH", `/api/v1/projects/${planning}`, { title: "New name", expectedStateVersion: 3 })).json.error?.code === "JOB_ALREADY_RUNNING");
  check("rename without Origin → 403", (await fetch(`${base}/api/v1/projects/${draft}`, { method: "PATCH", headers: { cookie: a.cookie, "content-type": "application/json" }, body: JSON.stringify({ title: "x", expectedStateVersion: 3 }) })).status === 403);
  r = await send(a.cookie, "PATCH", `/api/v1/projects/${failed}`, { title: "Renamed failure", expectedStateVersion: 3 });
  check("rename a failed storyboard → 200, still plan_failed with its error", r.status === 200 && r.json.state === "plan_failed" && r.json.lastError?.code === "PROVIDER_BUSY");

  // ---------- C5 archive ----------
  check("C5 without If-Match → 400", (await send(a.cookie, "DELETE", `/api/v1/projects/${draft}`)).json.error?.details?.issues?.[0]?.path === "headers.If-Match");
  check("C5 with a stale If-Match → 409 STALE_VERSION", (await send(a.cookie, "DELETE", `/api/v1/projects/${draft}`, undefined, { "if-match": '"2"' })).json.error?.code === "STALE_VERSION");
  check("C5 on another user's project → 404", (await send(b.cookie, "DELETE", `/api/v1/projects/${draft}`, undefined, { "if-match": '"3"' })).status === 404);
  check("C5 while a job runs → 409 JOB_ALREADY_RUNNING", (await send(a.cookie, "DELETE", `/api/v1/projects/${planning}`, undefined, { "if-match": '"3"' })).json.error?.code === "JOB_ALREADY_RUNNING");
  check("C5 without Origin → 403", (await fetch(`${base}/api/v1/projects/${draft}`, { method: "DELETE", headers: { cookie: a.cookie, "if-match": '"3"' } })).status === 403);
  const approvedSv = (await projects().findOne({ _id: oid(approved) }))!.stateVersion as number;
  r = await send(a.cookie, "DELETE", `/api/v1/projects/${approved}`, undefined, { "if-match": `"${approvedSv}"` });
  check("C5 → 200 Project: state archived, archivedAt set, read-only, currentStep kept", r.status === 200 && r.json.state === "archived" && typeof r.json.archivedAt === "string" && r.json.allowedActions?.length === 0 && r.json.currentStep === "storyboard" && r.json.stateVersion === approvedSv + 1);
  const archivedDoc = await projects().findOne({ _id: oid(approved) });
  check("database: stateBeforeArchive kept, storyboard and approval kept (nothing deleted)", archivedDoc?.stateBeforeArchive === "storyboard_ready" && archivedDoc?.approvedPlanVersionId?.equals(approvedVersion) === true && (await db.collection("planVersions").countDocuments({ projectId: oid(approved) })) === 1);
  check("archived project is gone from C1 (all and drafts)", !ids(await send(a.cookie, "GET", "/api/v1/projects?limit=50")).includes(approved) && !ids(await send(a.cookie, "GET", "/api/v1/projects?tab=drafts&limit=50")).includes(approved));
  check("archive again → 409 INVALID_STATE", (await send(a.cookie, "DELETE", `/api/v1/projects/${approved}`, undefined, { "if-match": `"${approvedSv + 1}"` })).json.error?.code === "INVALID_STATE");
  check("rename an archived project → 409 INVALID_STATE", (await send(a.cookie, "PATCH", `/api/v1/projects/${approved}`, { title: "x", expectedStateVersion: approvedSv + 1 })).json.error?.code === "INVALID_STATE");
  r = await send(a.cookie, "GET", `/api/v1/projects/${approved}`);
  check("C3 of the archived project still answers for its owner (state archived, no actions)", r.status === 200 && r.json.state === "archived" && r.json.allowedActions?.length === 0);
  check("…and is still 404 for another user", (await send(b.cookie, "GET", `/api/v1/projects/${approved}`)).status === 404);
  check("a storyboard change on an archived project → 409", (await send(a.cookie, "POST", `/api/v1/projects/${approved}/voice`, { basePlanVersionId: approvedVersion.toHexString(), voiceGender: "male", expectedStateVersion: approvedSv + 1 })).status === 409);
  page = await html(a.cookie, `/projects/${approved}`);
  check("/projects/[id] of an archived storyboard project → its storyboard page", page.status >= 300 && page.status < 400 ? page.location.endsWith(`/projects/${approved}/storyboard`) : page.text.includes(`/projects/${approved}/storyboard`), `status ${page.status}`);
  page = await html(a.cookie, `/projects/${approved}/storyboard`);
  check("archived storyboard page opens read-only", page.status === 200 && page.text.includes("Archived. This storyboard is read-only.") && !page.text.includes("Approve storyboard<"));
  check("…and another user still gets 404", (await html(b.cookie, `/projects/${approved}/storyboard`)).status === 404);
  const failedSv = (await projects().findOne({ _id: oid(failed) }))!.stateVersion as number;
  check("archive a failed storyboard → 200", (await send(a.cookie, "DELETE", `/api/v1/projects/${failed}`, undefined, { "if-match": `"${failedSv}"` })).status === 200);
  // F21 review: Try again (E2) is refused on an archived project, for a failed storyboard and a failed change.
  const failedPlanJob = new ObjectId();
  const failedReviseJob = new ObjectId();
  await db.collection("jobs").insertMany([
    { _id: failedPlanJob, ownerId: a.id, projectId: oid(failed), schemaVersion: 1, type: "plan", state: "failed", idempotencyKey: `e2e:${failedPlanJob.toHexString()}`, attempt: 1, error: { code: "PROVIDER_BUSY", message: "Busy", retryable: true }, createdAt: new Date(T0), updatedAt: new Date(T0) },
    { _id: failedReviseJob, ownerId: a.id, projectId: oid(approved), schemaVersion: 1, type: "revise", state: "failed", idempotencyKey: `e2e:${failedReviseJob.toHexString()}`, attempt: 1, inputRef: { planVersionId: approvedVersion }, error: { code: "PROVIDER_BUSY", message: "Busy", retryable: true }, createdAt: new Date(T0), updatedAt: new Date(T0) },
  ]);
  for (const [label, jobId] of [["storyboard", failedPlanJob], ["change", failedReviseJob]] as const) {
    r = await send(a.cookie, "POST", `/api/v1/jobs/${jobId.toHexString()}/retry`, {}, { "idempotency-key": randomBytes(16).toString("hex") });
    check(`E2 Try again on an archived project's failed ${label} → 409 INVALID_STATE "archived"`, r.status === 409 && r.json.error?.code === "INVALID_STATE" && r.json.error?.message === "This project is archived.", `${r.status} ${r.json.error?.message ?? ""}`);
  }
  check("…and nothing changed (still archived, no job running)", (await projects().countDocuments({ _id: { $in: [oid(failed), oid(approved)] }, state: "archived", activeJobId: null })) === 2);
  page = await html(a.cookie, `/projects/${failed}`);
  check("archived failed project page: Archived note, no Try again / Edit idea", page.status === 200 && page.text.includes("This video is archived.") && !page.text.includes("Try again") && !page.text.includes("Edit idea"));
  page = await html(a.cookie, "/dashboard");
  check("My videos no longer shows the archived cards", !page.text.includes("Approved storyboard") && !page.text.includes("Renamed failure"));

  // ---------- archiving the last project → the first-visit page again ----------
  r = await send(b.cookie, "DELETE", `/api/v1/projects/${bOnly}`, undefined, { "if-match": '"3"' });
  page = await html(b.cookie, "/dashboard");
  check("B archives its only project → first-visit page", r.status === 200 && page.text.includes("How it works") && page.text.includes("Create your first video"));
  check("C1 for B → empty", (await send(b.cookie, "GET", "/api/v1/projects")).json.items?.length === 0);

  // ---------- F21 review: a stuck job on the list gets the same stuck-job rule as C3 ----------
  const stuckProject = await seed(c.id, "Stuck storyboard", "planning", 30);
  const stuckJob = newPlanJob({ ownerId: c.id, projectId: oid(stuckProject), project: { input: { type: "topic", text: "Stuck storyboard", brainstormChoice: null }, language: "en", voiceGender: "female" }, now: new Date(Date.now() - 30 * 60_000) });
  await db.collection("jobs").insertOne({ ...stuckJob, state: "running", updatedAt: new Date(Date.now() - 11 * 60_000) });
  await projects().updateOne({ _id: oid(stuckProject) }, { $set: { activeJobId: stuckJob._id } });
  r = await send(c.cookie, "GET", "/api/v1/projects");
  check("C1: a job with no progress for 10+ min → the card shows plan_failed (not Writing… forever)", r.json.items?.[0]?.id === stuckProject && r.json.items?.[0]?.state === "plan_failed" && r.json.items?.[0]?.activeJobType === null, JSON.stringify(r.json.items?.[0]?.state));
  check("…and the job is failed INTERNAL (retryable)", (await db.collection("jobs").findOne({ _id: stuckJob._id }))?.error?.code === "INTERNAL");
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error(error);
  })
  .finally(async () => {
    await closeMongoClient();
    console.log(failures === 0 ? "\nAll F21 checks passed." : `\n${failures} check(s) failed.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
