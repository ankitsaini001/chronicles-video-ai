import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  addInvite,
  API_RATE_LIMITS,
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
 * F14 end-to-end check over real HTTP, against a running `next start` server whose Gemini is the
 * local stand-in (E2E_FAKE_GEMINI=1, apps/web/lib/brainstorm/fake-gemini.ts): NO real AI call.
 * Checks C7 POST /api/v1/brainstorm (pipeline checks, 5 ideas per language, repair, busy, safety,
 * the providerUsage log, 10/hour, 30/day also under concurrent clicks, nothing saved as a project),
 * the Idea page markup and C2 with a picked idea (`inputType: "brainstorm"`).
 * SAFETY: works only on the separate test database `bytereel_test`, port 3230–3239.
 *
 *   1. in apps/web:  npx next build
 *   2. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3236 E2E_FAKE_GEMINI=1 npx next start -p 3236
 *   3. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3236 E2E_FAKE_GEMINI=1 npx tsx tools/e2e/f14-brainstorm.ts
 *   4. drop the bytereel_test database afterwards
 *
 * Before ANY request it reads the environment of the server process listening on the port
 * (Linux /proc) and stops unless it has E2E_FAKE_GEMINI=1 and MONGODB_DB=bytereel_test, so a
 * misconfigured run can never reach the real Gemini (F14 review). No value from it is printed.
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

/** The environment of the process listening on the server's port (only the two names we check). */
function serverSettings(port: string): { fake: boolean; testDb: boolean } {
  const listing = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
  const pid = /pid=(\d+)/.exec(listing)?.[1];
  if (!pid) throw new Error(`No server process found on port ${port} (start it first, see the header).`);
  const env = new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  return { fake: env.get("E2E_FAKE_GEMINI") === "1", testDb: env.get("MONGODB_DB") === TEST_DB };
}
const server = serverSettings(new URL(base).port);
if (!server.fake || !server.testDb) throw new Error("Stopping before any request: the server must run with E2E_FAKE_GEMINI=1 and MONGODB_DB=bytereel_test.");

const tag = randomBytes(4).toString("hex");
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

type Idea = { id: string; title: string; hook: string; angle: string };
type Json = { subject?: string; language?: string; ideas?: Idea[]; error?: { code?: string; message?: string; details?: Record<string, unknown> & { issues?: { path: string; message: string }[] } } };

const brainstorm = (cookie: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/brainstorm`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, ...(cookie ? { cookie } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const clearRateLimits = () => db.collection("rateLimits").deleteMany({});
const usageRows = (ownerId: ObjectId) => db.collection("providerUsage").find({ ownerId }).sort({ at: 1, _id: 1 }).toArray();
const today = () => usagePeriods("Asia/Kolkata").day;
const dailyCount = async (ownerId: ObjectId) => (await db.collection("usageCounters").findOne({ ownerId, kind: "brainstorms", period: today() }))?.count ?? 0;

async function signUp(label: string): Promise<{ cookie: string; id: ObjectId }> {
  const email = `f14-e2e-${label}-${tag}@example.com`;
  await addInvite(db, email, { note: "F14 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `F14 Tester ${label}`, email, password: `E2e-${randomBytes(9).toString("base64url")}` }),
  });
  check(`test account ${label} created through sign-up`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId };
}

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F14"]));
  const indexNames = (await db.collection("providerUsage").indexes()).map((i) => i.name);
  check("F14 providerUsage indexes created on the test database", ["at", "ownerId_at", "provider_at"].every((n) => indexNames.includes(n)), indexNames.join(", "));
  await clearRateLimits();

  let r = await brainstorm("", { subject: "Indian monsoon", language: "en" });
  check("signed out: C7 → 401 UNAUTHENTICATED", r.status === 401 && ((await r.json()) as Json).error?.code === "UNAUTHENTICATED");

  const a = await signUp("a");
  const b = await signUp("b");

  // --- The Idea page.
  const html = (await (await fetch(`${base}/projects/new`, { headers: { cookie: a.cookie } })).text()).replace(/<!-- -->/g, "");
  check("Idea page: '✨ Brainstorm with AI' button, collapsed, controls a hidden panel", /<button[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"[^>]*>(?:(?!<\/button>).)*Brainstorm with AI<\/span><\/button>/s.test(html) && /<div[^>]*id="[^"]*-panel"[^>]*hidden=""/.test(html));
  check("Idea page: 'Ideas from AI' panel with a labelled subject box and a live status line", html.includes("Ideas from AI") && html.includes(">Broad subject</label>") && html.includes('aria-live="polite"'));
  check("Idea page: still one primary button (Create storyboard)", (html.match(/shadow-glow/g) ?? []).length === 1 && html.includes("Create storyboard"));
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
  let leaks = 0;
  let callsC7 = false;
  for (const src of scripts) {
    const code = await (await fetch(new URL(src, base))).text();
    if (/generativelanguage|GEMINI_API_KEY|E2E_FAKE_GEMINI|fake-gemini-e2e|@google\/genai/i.test(code)) leaks++;
    if (code.includes("/api/v1/brainstorm")) callsC7 = true;
  }
  check("no page script mentions Gemini, its key or the test switch (the browser only calls C7)", scripts.length > 0 && leaks === 0 && callsC7, `${scripts.length} scripts`);

  // --- Pipeline checks (no Gemini call for any of these).
  r = await brainstorm(a.cookie, { subject: "Indian monsoon", language: "en" }, { origin: "https://evil.example" });
  check("other Origin → 403 FORBIDDEN", r.status === 403);
  r = await brainstorm(a.cookie, { subject: "x", language: "fr", extra: 1 });
  let json = (await r.json()) as Json;
  check("bad body → 400 INVALID_INPUT naming subject, language and the unknown field", r.status === 400 && json.error?.code === "INVALID_INPUT" && ["subject", "language", "extra"].every((p) => json.error?.details?.issues?.some((i) => i.path === p)), JSON.stringify(json.error?.details?.issues));
  r = await fetch(`${base}/api/v1/brainstorm`, { method: "POST", headers: { "content-type": "text/plain", origin: base, cookie: a.cookie }, body: "Indian monsoon" });
  check("not JSON → 400 INVALID_INPUT", r.status === 400);
  check("refused requests: no AI call logged, nothing counted for the day", (await usageRows(a.id)).length === 0 && (await dailyCount(a.id)) === 0);

  // --- Success in each language.
  r = await brainstorm(a.cookie, { subject: "  Indian monsoon \u0007", language: "en" });
  json = (await r.json()) as Json;
  const fake = json.ideas?.[0]?.title === "Idea 1 about Indian monsoon";
  check("the server uses the local Gemini stand-in (no real AI call)", fake, json.ideas?.[0]?.title ?? JSON.stringify(json));
  if (!fake) throw new Error("Stopping: the server is not using the Gemini stand-in. Start it with E2E_FAKE_GEMINI=1.");
  check("English: 200, exactly 5 ideas idea-1…idea-5, cleaned subject echoed", r.status === 200 && json.subject === "Indian monsoon" && json.language === "en" && json.ideas?.map((i) => i.id).join() === "idea-1,idea-2,idea-3,idea-4,idea-5");
  check("each idea has title, hook and angle only", json.ideas!.every((i) => Object.keys(i).sort().join() === "angle,hook,id,title" && i.title && i.hook && i.angle));
  check("no Idempotency-Key needed; answer not cached (no-store)", r.headers.get("cache-control") === "no-store");
  let rows = await usageRows(a.id);
  const row = rows[0] as Record<string, unknown> | undefined;
  check(
    "providerUsage: one row, gemini / brainstorm / final / ok, tokens (output = answer + thinking), cost 0, latency",
    rows.length === 1 &&
      row?.provider === "gemini" &&
      row?.operation === "brainstorm" &&
      row?.status === "final" &&
      row?.outcome === "ok" &&
      row?.model === "fake-gemini-e2e" &&
      JSON.stringify(row?.units) === JSON.stringify({ promptTokens: 900, outputTokens: 500, characters: 0, renderSeconds: 0 }) &&
      row?.estCostInr === 0 &&
      typeof row?.latencyMs === "number" &&
      row?.schemaVersion === 1,
    JSON.stringify(row),
  );
  check("providerUsage: no project or job, and never the subject text", !("projectId" in (row ?? {})) && !("jobId" in (row ?? {})) && !JSON.stringify(row).includes("monsoon"));
  check("brainstorms today: 1 (usageCounters, user timezone)", (await dailyCount(a.id)) === 1);

  r = await brainstorm(a.cookie, { subject: "मानसून", language: "hi" });
  json = (await r.json()) as Json;
  check("Hindi: 5 ideas in Devanagari", r.status === 200 && json.ideas?.length === 5 && json.ideas.every((i) => /\p{Script=Devanagari}/u.test(i.title)), json.ideas?.[0]?.title);
  r = await brainstorm(a.cookie, { subject: "Monsoon kaise aata hai", language: "hinglish" });
  json = (await r.json()) as Json;
  check("Hinglish: 5 ideas in Roman script", r.status === 200 && json.ideas?.length === 5 && json.ideas.every((i) => !/\p{Script=Devanagari}/u.test(i.title)));

  // --- Repair, invalid twice, busy, safety.
  let before = (await usageRows(a.id)).length;
  r = await brainstorm(a.cookie, { subject: "e2e repair", language: "en" });
  rows = (await usageRows(a.id)).slice(before);
  check("4 ideas, then repaired → 200 with 5; 2 calls logged (invalid_output, ok)", r.status === 200 && ((await r.json()) as Json).ideas?.length === 5 && rows.map((x) => x.outcome).join() === "invalid_output,ok");

  before = (await usageRows(a.id)).length;
  r = await brainstorm(a.cookie, { subject: "e2e invalid", language: "en" });
  json = (await r.json()) as Json;
  rows = (await usageRows(a.id)).slice(before);
  check(
    "invalid twice → 503 PROVIDER_BUSY (brainstorm wording) after ONE repair",
    r.status === 503 && json.error?.code === "PROVIDER_BUSY" && json.error.message === "Our AI is very busy right now. Please try again in a few minutes." && rows.length === 2,
    `${r.status} ${rows.length}`,
  );

  await clearRateLimits();
  before = (await usageRows(a.id)).length;
  r = await brainstorm(a.cookie, { subject: "e2e busy", language: "en" });
  json = (await r.json()) as Json;
  rows = (await usageRows(a.id)).slice(before);
  check("Gemini 503 every time → 503 PROVIDER_BUSY + Retry-After after 3 tries", r.status === 503 && json.error?.code === "PROVIDER_BUSY" && r.headers.get("retry-after") === "60" && rows.length === 3);
  check("each busy try logged as failed / busy", rows.every((x) => x.status === "failed" && x.outcome === "busy"));

  before = (await usageRows(a.id)).length;
  r = await brainstorm(a.cookie, { subject: "e2e unsafe", language: "en" });
  json = (await r.json()) as Json;
  rows = (await usageRows(a.id)).slice(before);
  check("safety block → 422 PROVIDER_REJECTED, no retry", r.status === 422 && json.error?.code === "PROVIDER_REJECTED" && json.error.message === "We can't suggest ideas for this subject. Please try a different one." && rows.length === 1 && rows[0]!.outcome === "rejected");
  r = await brainstorm(a.cookie, { subject: "e2e unsuitable", language: "en" });
  check("model says not suitable → 422 PROVIDER_REJECTED", r.status === 422 && ((await r.json()) as Json).error?.code === "PROVIDER_REJECTED");

  check("brainstorm saves no project", (await db.collection("projects").countDocuments({ ownerId: a.id })) === 0);

  // --- 10 per hour.
  await clearRateLimits();
  const rule = API_RATE_LIMITS.brainstormPerUser;
  const now = new Date();
  await db.collection<{ _id: string }>("rateLimits").updateOne({ _id: rateLimitId(rule, a.id.toHexString(), now) }, { $set: { count: rule.limit, expiresAt: rateLimitWindow(rule, now).end } }, { upsert: true });
  before = (await usageRows(a.id)).length;
  let daily = await dailyCount(a.id);
  r = await brainstorm(a.cookie, { subject: "Indian monsoon", language: "en" });
  json = (await r.json()) as Json;
  check("11th in an hour → 429 RATE_LIMITED + Retry-After", r.status === 429 && json.error?.code === "RATE_LIMITED" && Number(r.headers.get("retry-after")) >= 1);
  check("…and no AI call, not counted for the day", (await usageRows(a.id)).length === before && (await dailyCount(a.id)) === daily);

  // --- 30 per day.
  await clearRateLimits();
  await db.collection("usageCounters").updateOne({ ownerId: a.id, kind: "brainstorms", period: today() }, { $set: { count: 29 } });
  r = await brainstorm(a.cookie, { subject: "Indian monsoon", language: "en" });
  check("30th today → 200", r.status === 200 && (await dailyCount(a.id)) === 30);
  before = (await usageRows(a.id)).length;
  r = await brainstorm(a.cookie, { subject: "Indian monsoon", language: "en" });
  json = (await r.json()) as Json;
  check(
    "31st today → 429 QUOTA_EXCEEDED brainstorms_per_day with resetsAt",
    r.status === 429 && json.error?.code === "QUOTA_EXCEEDED" && json.error.details?.quota === "brainstorms_per_day" && json.error.details?.limit === 30 && typeof json.error.details?.resetsAt === "string",
    JSON.stringify(json.error),
  );
  check("…and no AI call, the count stays 30", (await usageRows(a.id)).length === before && (await dailyCount(a.id)) === 30);

  // --- Concurrent clicks: b has 28 today; 5 at once → exactly 2 pass.
  await clearRateLimits();
  await db.collection("usageCounters").insertOne({ ownerId: b.id, kind: "brainstorms", period: today(), count: 28, expiresAt: new Date(Date.now() + 8 * 86_400_000) });
  const results = await Promise.all(Array.from({ length: 5 }, () => brainstorm(b.cookie, { subject: "Indian monsoon", language: "en" })));
  const statuses = results.map((x) => x.status).sort();
  check("5 concurrent at 28/30 → exactly 2 × 200, 3 × 429; count 30; 2 AI calls", statuses.join() === "200,200,429,429,429" && (await dailyCount(b.id)) === 30 && (await usageRows(b.id)).length === 2, statuses.join());

  // --- First brainstorms of the day at the same moment (no counter yet).
  const c = await signUp("c");
  const first = await Promise.all(Array.from({ length: 3 }, () => brainstorm(c.cookie, { subject: "Indian monsoon", language: "en" })));
  check("3 concurrent first brainstorms of the day → all 200, count 3", first.every((x) => x.status === 200) && (await dailyCount(c.id)) === 3, first.map((x) => x.status).join());

  // --- C2 with a picked idea.
  await clearRateLimits();
  r = await brainstorm(c.cookie, { subject: "Indian monsoon", language: "en" });
  const picked = ((await r.json()) as Json).ideas![1]!;
  const text = `${picked.title}. ${picked.hook}`;
  r = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie: c.cookie, "idempotency-key": `e2e-${randomBytes(12).toString("hex")}` },
    body: JSON.stringify({ inputType: "brainstorm", text, language: "en", voiceGender: "female", brainstormChoice: { subject: "Indian monsoon", title: picked.title, hook: picked.hook } }),
  });
  const created = (await r.json()) as { project?: { input?: { type?: string; text?: string; brainstormChoice?: unknown } } };
  check(
    "C2 with the picked idea → 201, input.type brainstorm + brainstormChoice saved",
    r.status === 201 && created.project?.input?.type === "brainstorm" && created.project.input.text === text && JSON.stringify(created.project.input.brainstormChoice) === JSON.stringify({ subject: "Indian monsoon", title: picked.title, hook: picked.hook }),
    `${r.status}`,
  );

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
