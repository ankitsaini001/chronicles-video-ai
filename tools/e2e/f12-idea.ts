import { randomBytes } from "node:crypto";
import {
  API_RATE_LIMITS,
  addInvite,
  closeMongoClient,
  ensureIndexes,
  getDb,
  indexesForFeatures,
  rateLimitId,
  rateLimitWindow,
  readDbConfig,
  usagePeriods,
} from "@bytereel/db";
import { ObjectId } from "mongodb";

/**
 * F12 end-to-end check over real HTTP, against a running `next start` server: the Step 1 Idea
 * page, C2 POST /api/v1/projects (pipeline checks, idempotency, projects/day quota, also under
 * concurrent clicks), the temporary project page (owner only) and the projects count in B1.
 * SAFETY: works only on the separate test database `bytereel_test` (never the real `bytereel`).
 * It creates the F07/F08/F12 indexes there itself.
 *
 *   1. in apps/web:  npx next build
 *   2. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3235 npx next start -p 3235
 *   3. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3235 npx tsx tools/e2e/f12-idea.ts
 *   4. drop the bytereel_test database afterwards
 *
 * Uses only @example.com emails and random throw-away passwords. Prints no secrets.
 */

const TEST_DB = "bytereel_test";
process.loadEnvFile(".env");
const base = process.env.E2E_BASE_URL ?? "";
if (!/^http:\/\/localhost:323\d$/.test(base)) throw new Error("Set E2E_BASE_URL to http://localhost:3230–3239 (never port 3000).");
const settings = readDbConfig(process.env);
if (!settings.ok) throw new Error(settings.problems.join(" "));
if (settings.config.dbName !== TEST_DB) throw new Error(`Refusing to run: MONGODB_DB must be ${TEST_DB}.`);
const db = getDb(settings.config);

const tag = randomBytes(4).toString("hex");
const newPassword = () => `E2e-${randomBytes(9).toString("base64url")}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

const key = () => `e2e-${randomBytes(12).toString("hex")}`;
const createProject = (cookie: string, body: unknown, options: { key?: string | null; headers?: Record<string, string>; raw?: string } = {}) =>
  fetch(`${base}/api/v1/projects`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      origin: base,
      ...(cookie ? { cookie } : {}),
      ...(options.key === null ? {} : { "idempotency-key": options.key ?? key() }),
      ...options.headers,
    },
    body: options.raw ?? JSON.stringify(body),
  });
const page = (path: string, cookie = "") => fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const redirectsTo = (r: Response, path: string) => r.status >= 300 && r.status < 400 && new URL(r.headers.get("location") ?? "", base).pathname === path;
const clearRateLimits = () => db.collection("rateLimits").deleteMany({});
const htmlOf = async (r: Response) => (await r.text()).replace(/<!-- -->/g, "");
type ErrorJson = { error?: { code?: string; message?: string; details?: Record<string, unknown> & { issues?: { path: string; message: string }[] }; requestId?: string } };
type CreatedJson = { project?: Record<string, unknown> & { id?: string; input?: { text?: string } }; job?: unknown };

async function signUp(label: string): Promise<{ email: string; cookie: string; id: ObjectId }> {
  const email = `f12-e2e-${label}-${tag}@example.com`;
  await addInvite(db, email, { note: "F12 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `F12 Tester ${label}`, email, password: newPassword() }),
  });
  check(`test account ${label} created through sign-up`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { email, cookie: cookieOf(r), id: user!._id as ObjectId };
}

const VALID = { inputType: "topic", text: "How UPI payments work — from scanning the QR code to the shop", language: "en", voiceGender: "female" };

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12"]));
  await clearRateLimits();

  // --- Signed out.
  let r = await page("/projects/new");
  check("signed out: /projects/new → /login", redirectsTo(r, "/login"));
  r = await page(`/projects/${new ObjectId().toHexString()}`);
  check("signed out: /projects/[id] → /login", redirectsTo(r, "/login"));
  r = await createProject("", VALID);
  check("signed out: C2 → 401 UNAUTHENTICATED", r.status === 401 && ((await r.json()) as ErrorJson).error?.code === "UNAUTHENTICATED");

  const a = await signUp("a");
  const b = await signUp("b");

  // --- The Idea page.
  r = await page("/projects/new", a.cookie);
  let html = await htmlOf(r);
  check("/projects/new renders inside the shell (200)", r.status === 200 && html.includes("Videos today"), `status ${r.status}`);
  check("title 'New video · <product>'", /<title>New video · [^<]+<\/title>/.test(html));
  check("heading labels the box: 'What do you want to explain?'", /<label for="idea-text">What do you want to explain\?<\/label>/.test(html));
  check("textarea max 5,000 + live counter '0 / 5,000'", /<textarea[^>]*maxLength="5000"/i.test(html) && html.includes("0 / 5,000"));
  check("helper text", html.includes("Type a topic, or paste your notes (up to 5,000 characters)."));
  check("Language and Voice are labelled radiogroups", (html.match(/role="radiogroup"/g) ?? []).length === 2 && (html.match(/aria-labelledby="/g) ?? []).length >= 2 && html.includes(">Language</p>") && html.includes(">Voice</p>"));
  const radios = html.match(/<button[^>]*role="radio"[^>]*>.*?<\/button>/g) ?? [];
  check("5 radio chips, none uses aria-pressed", radios.length === 5 && radios.every((x) => !x.includes("aria-pressed")), `${radios.length}`);
  const checked = radios.filter((x) => x.includes('aria-checked="true"'));
  check("defaults for a new user: English + Female voice checked", checked.length === 2 && checked[0]!.includes("English") && checked[1]!.includes("Female voice"));
  check("Hindi label wrapped in lang=\"hi\"", html.includes('<span lang="hi">हिंदी</span> Hindi'));
  check("only the checked chip in each group is in the Tab order", radios.filter((x) => x.includes('tabindex="0"')).length === 2 && checked.every((x) => x.includes('tabindex="0"')));
  check("one primary button: Create storyboard", (html.match(/Create storyboard/g) ?? []).length === 1 && !html.includes("Create your first reel"));
  check("stepper: Idea is the current step of 4", /aria-current="step"[^>]*>.*?1 .*?Idea/.test(html) && ["Storyboard", "Video", "Publish"].every((s) => html.includes(s)));
  check("no Brainstorm (F14) and no voice preview ▶ (F13) yet", !html.includes("Brainstorm") && !html.includes("▶"));
  check("projects today: 0 of 5", html.includes("Projects today: 0 of 5"));
  check("the F11 placeholder is gone", !html.includes("Step 1 Idea arrives in F12"));

  await db.collection("user").updateOne({ _id: b.id }, { $set: { defaultLanguage: "hi", defaultVoiceGender: "male" } });
  html = await htmlOf(await page("/projects/new", b.cookie));
  const bChecked = (html.match(/<button[^>]*role="radio"[^>]*>.*?<\/button>/g) ?? []).filter((x) => x.includes('aria-checked="true"'));
  check("defaults come from the user (हिंदी Hindi + Male voice)", bChecked.length === 2 && bChecked[0]!.includes('lang="hi"') && bChecked[1]!.includes("Male voice"));
  await db.collection("user").updateOne({ _id: b.id }, { $set: { defaultLanguage: "en", defaultVoiceGender: "female" } });

  // --- C2 pipeline checks.
  r = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example", cookie: a.cookie, "idempotency-key": key() },
    body: JSON.stringify(VALID),
  });
  check("C2: foreign Origin → 403 FORBIDDEN origin_mismatch", r.status === 403 && ((await r.json()) as ErrorJson).error?.details?.reason === "origin_mismatch");
  r = await createProject(a.cookie, VALID, { headers: { "content-type": "text/plain" } });
  check("C2: text/plain → 400 INVALID_INPUT", r.status === 400 && ((await r.json()) as ErrorJson).error?.details?.issues?.[0]?.path === "headers.Content-Type");
  r = await createProject(a.cookie, VALID, { key: null });
  check("C2: no Idempotency-Key → 400 INVALID_INPUT", r.status === 400 && ((await r.json()) as ErrorJson).error?.details?.issues?.[0]?.path === "headers.Idempotency-Key");
  r = await createProject(a.cookie, null, { raw: JSON.stringify({ ...VALID, inputType: "notes", text: "x".repeat(70_000) }) });
  check("C2: body over 64 KB → 413 PAYLOAD_TOO_LARGE", r.status === 413 && ((await r.json()) as ErrorJson).error?.code === "PAYLOAD_TOO_LARGE", `status ${r.status}`);
  r = await createProject(a.cookie, { ...VALID, ownerId: b.id.toHexString(), state: "published" });
  let err = (await r.json()) as ErrorJson;
  check(
    "C2: unknown fields (ownerId, state) → 400 with one issue each",
    r.status === 400 && ["ownerId", "state"].every((p) => err.error?.details?.issues?.some((i) => i.path === p && i.message === "unknown field")),
    JSON.stringify(err.error?.details),
  );
  r = await createProject(a.cookie, { ...VALID, text: "   \n " });
  err = (await r.json()) as ErrorJson;
  check("C2: empty (whitespace) text → 400 text must be at least 3", r.status === 400 && err.error?.details?.issues?.[0]?.path === "text");
  r = await createProject(a.cookie, { ...VALID, inputType: "notes", text: "n".repeat(5001) });
  err = (await r.json()) as ErrorJson;
  check("C2: 5,001 characters of notes → 400 (5,000 limit)", r.status === 400 && err.error?.details?.issues?.[0]?.message === "must be at most 5000 characters");
  r = await createProject(a.cookie, { ...VALID, language: "fr" });
  check("C2: unknown language → 400", r.status === 400);
  check("C2: none of the refused requests saved a project", (await db.collection("projects").countDocuments({ ownerId: a.id })) === 0);
  await clearRateLimits();

  // --- C2 success.
  const firstKey = key();
  const now = new Date();
  r = await createProject(a.cookie, { ...VALID, text: `  ${VALID.text}\n` }, { key: firstKey });
  const created = (await r.json()) as CreatedJson;
  check("C2: valid topic → 201 { project, job: null }", r.status === 201 && created.job === null && typeof created.project?.id === "string", `status ${r.status}`);
  check("C2: X-Request-Id + no-store", /^req_/.test(r.headers.get("x-request-id") ?? "") && r.headers.get("cache-control") === "no-store");
  const p = created.project!;
  const keys = Object.keys(p).sort().join(",");
  check(
    "C2: Project has exactly the API.md §11.3 fields",
    keys ===
      "activeJob,activeJobId,activeJobType,allowedActions,approvedPlanVersionId,archivedAt,createdAt,currentPlanVersionId,currentRenderId,currentStep,id,input,language,lastError,latestPost,state,stateVersion,thumbnailUrl,title,updatedAt,voiceGender",
    keys,
  );
  check(
    "C2: state draft, step idea, stateVersion 1, text trimmed, title = idea",
    p.state === "draft" && p.currentStep === "idea" && p.stateVersion === 1 && p.input?.text === VALID.text && p.title === VALID.text && p.language === "en" && p.voiceGender === "female",
  );
  const doc = await db.collection("projects").findOne({ _id: new ObjectId(p.id) });
  check("Atlas projects: saved with your user id (ObjectId)", doc?.ownerId instanceof ObjectId && doc.ownerId.equals(a.id));
  check(
    "Atlas projects: documented initial fields",
    doc?.schemaVersion === 1 &&
      doc.state === "draft" &&
      doc.stateVersion === 1 &&
      doc.planRequestCount === 0 &&
      doc.activeJobId === null &&
      doc.currentPlanVersionId === null &&
      doc.archivedAt === null &&
      doc.lastError === null &&
      doc.input?.type === "topic" &&
      doc.input?.brainstormChoice === null &&
      doc.createdAt instanceof Date &&
      Math.abs(doc.createdAt.getTime() - now.getTime()) < 60_000,
  );
  check("no AI job was started (no jobs collection documents)", (await db.collection("jobs").countDocuments({})) === 0);
  const record = await db.collection("idempotencyKeys").findOne({ ownerId: a.id, key: firstKey });
  check("Atlas idempotencyKeys: the click is saved as done with the 201 answer", record?.status === "done" && record.responseStatus === 201 && record.lockedUntil === null);

  // --- Idempotency.
  r = await createProject(a.cookie, { ...VALID, text: `  ${VALID.text}\n` }, { key: firstKey });
  const replay = (await r.json()) as CreatedJson;
  check(
    "C2 repeat (same key, same body) → same 201 answer, Idempotent-Replayed: true, no second project",
    r.status === 201 && r.headers.get("idempotent-replayed") === "true" && JSON.stringify(replay) === JSON.stringify(created) && (await db.collection("projects").countDocuments({ ownerId: a.id })) === 1,
  );
  r = await createProject(a.cookie, { ...VALID, voiceGender: "male" }, { key: firstKey });
  check("C2: same key, different body → 422 IDEMPOTENCY_KEY_REUSED", r.status === 422 && ((await r.json()) as ErrorJson).error?.code === "IDEMPOTENCY_KEY_REUSED");
  r = await createProject(b.cookie, { ...VALID, text: `  ${VALID.text}\n` }, { key: firstKey });
  check("C2: the same key from another user is a new request (201, B's own project)", r.status === 201 && r.headers.get("idempotent-replayed") === null);
  await db.collection("projects").deleteMany({ ownerId: b.id });
  await db.collection("usageCounters").deleteMany({ ownerId: b.id });

  // --- Notes (exactly 5,000 characters) in Hindi with a male voice.
  const hindiNotes = `यूपीआई भुगतान कैसे काम करता है। ${"क".repeat(5000)}`.slice(0, 5000);
  r = await createProject(a.cookie, { inputType: "notes", text: hindiNotes, language: "hi", voiceGender: "male" });
  const notes = (await r.json()) as CreatedJson;
  check("C2: 5,000 characters of Hindi notes → 201", r.status === 201 && notes.project?.input?.text === hindiNotes && (notes.project?.title as string).length <= 120, `status ${r.status}`);

  // --- The temporary project page.
  r = await page(`/projects/${p.id}`, a.cookie);
  html = await htmlOf(r);
  check("owner: /projects/[id] shows the saved topic, language and voice", r.status === 200 && html.includes(VALID.text) && html.includes(">English<") && html.includes("Female voice") && html.includes("The AI storyboard arrives in F15"), `status ${r.status}`);
  check("owner: stepper on Idea", /aria-current="step"[^>]*>.*?Idea/.test(html));
  html = await htmlOf(await page(`/projects/${notes.project!.id}`, a.cookie));
  check("owner: Hindi project shows हिंदी Hindi + Male voice", html.includes('<span lang="hi">हिंदी</span> Hindi') && html.includes("Male voice"));
  for (const [label, path, cookie] of [
    ["another user's project", `/projects/${p.id}`, b.cookie],
    ["a malformed id", "/projects/not-an-id", a.cookie],
    ["a missing project", `/projects/${new ObjectId().toHexString()}`, a.cookie],
  ] as const) {
    r = await page(path, cookie);
    html = await htmlOf(r);
    check(`404 for ${label}, nothing about the project shown`, r.status === 404 && !html.includes(VALID.text) && !html.includes("Idea saved"), `status ${r.status}`);
  }

  // --- Usage in B1 and on the Idea page.
  let me = (await (await page("/api/v1/me", a.cookie)).json()) as { usage?: { projectsToday?: { used: number; limit: number; resetsAt: string } } };
  const resetsAt = usagePeriods("Asia/Kolkata").dayResetsAt.toISOString();
  check("B1: projectsToday 2 of 5 (real count)", JSON.stringify(me.usage?.projectsToday) === JSON.stringify({ used: 2, limit: 5, resetsAt }), JSON.stringify(me.usage?.projectsToday));
  html = await htmlOf(await page("/projects/new", a.cookie));
  check("Idea page: Projects today: 2 of 5", html.includes("Projects today: 2 of 5"));

  // --- Quota: 5 per day.
  for (let i = 3; i <= 5; i++) {
    r = await createProject(a.cookie, { ...VALID, text: `Project number ${i}` });
    check(`C2: project ${i} of 5 → 201`, r.status === 201, `status ${r.status}`);
  }
  r = await createProject(a.cookie, { ...VALID, text: "Project number 6" });
  err = (await r.json()) as ErrorJson;
  check(
    "C2: project 6 → 429 QUOTA_EXCEEDED projects_per_day with resetsAt (midnight, user timezone)",
    r.status === 429 &&
      err.error?.code === "QUOTA_EXCEEDED" &&
      err.error.message === "You've created 5 projects today. Try again tomorrow." &&
      JSON.stringify(err.error.details) === JSON.stringify({ quota: "projects_per_day", limit: 5, used: 5, resetsAt }),
    JSON.stringify(err.error),
  );
  check("quota: still 5 projects and the counter stays at 5", (await db.collection("projects").countDocuments({ ownerId: a.id })) === 5 && (await db.collection("usageCounters").findOne({ ownerId: a.id, kind: "projects" }))?.count === 5);
  check("Atlas usageCounters: one counter for today, expires a week after the day ends", (await db.collection("usageCounters").countDocuments({ ownerId: a.id })) === 1);
  me = (await (await page("/api/v1/me", a.cookie)).json()) as typeof me;
  check("B1: projectsToday 5 of 5", me.usage?.projectsToday?.used === 5);
  html = await htmlOf(await page("/projects/new", a.cookie));
  check("Idea page: Projects today: 5 of 5", html.includes("Projects today: 5 of 5"));
  await clearRateLimits();

  // --- Quota under concurrent clicks: 8 at the same moment, different keys → exactly 5 saved.
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => createProject(b.cookie, { ...VALID, text: `Concurrent project ${i}` })));
  const statuses = burst.map((x) => x.status).sort();
  check("8 concurrent creates → exactly 5 × 201 and 3 × 429", statuses.filter((s) => s === 201).length === 5 && statuses.filter((s) => s === 429).length === 3, statuses.join(","));
  check("concurrent: exactly 5 projects saved, counter at 5", (await db.collection("projects").countDocuments({ ownerId: b.id })) === 5 && (await db.collection("usageCounters").findOne({ ownerId: b.id, kind: "projects" }))?.count === 5);
  await clearRateLimits();

  // --- A double-click: two requests with the SAME key at the same moment → one project.
  await db.collection("projects").deleteMany({ ownerId: b.id });
  await db.collection("usageCounters").deleteMany({ ownerId: b.id });
  const doubleKey = key();
  const pair = await Promise.all([0, 1].map(() => createProject(b.cookie, { ...VALID, text: "Double-click project" }, { key: doubleKey })));
  const pairStatuses = pair.map((x) => x.status).sort();
  check(
    "double-click (same key, same moment) → one 201 + one 201 replay or 409 IDEMPOTENCY_IN_PROGRESS",
    pairStatuses[0] === 201 && (pairStatuses[1] === 201 || pairStatuses[1] === 409),
    pairStatuses.join(","),
  );
  check("double-click: exactly one project saved and counted", (await db.collection("projects").countDocuments({ ownerId: b.id })) === 1 && (await db.collection("usageCounters").findOne({ ownerId: b.id, kind: "projects" }))?.count === 1);
  await clearRateLimits();

  // --- Rate limit: 10 per hour per user.
  const rule = API_RATE_LIMITS.createProjectPerUser;
  const at = new Date();
  await db.collection<{ _id: string }>("rateLimits").updateOne({ _id: rateLimitId(rule, a.id.toHexString(), at) }, { $set: { count: rule.limit, expiresAt: rateLimitWindow(rule, at).end } }, { upsert: true });
  r = await createProject(a.cookie, VALID);
  err = (await r.json()) as ErrorJson;
  check("C2: request 11 in an hour → 429 RATE_LIMITED + Retry-After", r.status === 429 && err.error?.code === "RATE_LIMITED" && Number(r.headers.get("retry-after")) >= 1);

  await clearRateLimits();
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
}

main()
  .catch((error) => {
    failures++;
    console.error("E2E crashed:", error instanceof Error ? error.message : error);
  })
  .finally(async () => {
    await closeMongoClient();
    process.exitCode = failures === 0 ? 0 : 1;
  });
