import { randomBytes } from "node:crypto";
import { addInvite, closeMongoClient, getDb, readDbConfig } from "@bytereel/db";
import { type Document, ObjectId } from "mongodb";

/**
 * F08 end-to-end check over real HTTP, against a running `next start` server.
 * SAFETY: works only on the separate test database `bytereel_test` (never the real `bytereel`).
 *
 *   1. npm run db -- indexes --feature F07 --feature F08 --apply   (with MONGODB_DB=bytereel_test)
 *   2. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3231 npx next start -p 3231
 *   3. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3231 npx tsx tools/e2e/f08-signup.ts
 *   4. drop the bytereel_test database afterwards
 *
 * Uses only @example.com emails and random throw-away passwords. Prints no secrets.
 */

const TEST_DB = "bytereel_test";
// The root .env (never overrides MONGODB_DB=bytereel_test given on the command line).
process.loadEnvFile(".env");
const base = process.env.E2E_BASE_URL ?? "";
if (!/^http:\/\/localhost:323\d$/.test(base)) throw new Error("Set E2E_BASE_URL to http://localhost:3230–3239 (never port 3000).");
const settings = readDbConfig(process.env);
if (!settings.ok) throw new Error(settings.problems.join(" "));
if (settings.config.dbName !== TEST_DB) throw new Error(`Refusing to run: MONGODB_DB must be ${TEST_DB}.`);
const db = getDb(settings.config);

const tag = randomBytes(4).toString("hex");
const invited = `f08-e2e-${tag}@example.com`;
const stranger = `f08-stranger-${tag}@example.com`;
const password = `E2e-${randomBytes(9).toString("base64url")}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base, ...headers },
    body: JSON.stringify(body),
  });
}
const signUp = (body: unknown, headers: Record<string, string> = {}) => post("/api/auth/sign-up/email", body, headers);
const codeOf = async (r: Response) => ((await r.json().catch(() => ({}))) as { code?: string }).code;
const clearRateLimits = () => db.collection("rateLimits").deleteMany({});
const countUsers = (email: string) => db.collection("user").countDocuments({ email });

/** Field name → type, without values (for the Q17 check). */
function shape(doc: Document | null): Record<string, string> {
  if (!doc) return {};
  return Object.fromEntries(
    Object.entries(doc).map(([k, v]) => [k, v === null ? "null" : v instanceof ObjectId ? "ObjectId" : v instanceof Date ? "Date" : Array.isArray(v) ? "array" : typeof v]),
  );
}

async function main(): Promise<void> {
  await addInvite(db, invited, { note: "F08 e2e test (bytereel_test)" });
  await clearRateLimits();

  // Lockdown: other Better Auth endpoints answer 404.
  for (const [method, path] of [
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/delete-user"],
    ["GET", "/api/auth/list-sessions"],
    ["POST", "/api/auth/request-password-reset"],
    ["GET", "/api/auth/ok"],
    ["GET", "/api/auth/callback/google"],
  ] as const) {
    const r = method === "GET" ? await fetch(`${base}${path}`) : await post(path, {});
    check(`${method} ${path} is blocked`, r.status === 404, `status ${r.status}`);
  }

  // Origin check.
  let r = await signUp({ name: "E2E", email: invited, password }, { origin: "https://evil.example" });
  check("wrong Origin refused (403 FORBIDDEN_ORIGIN)", r.status === 403 && (await codeOf(r)) === "FORBIDDEN_ORIGIN", `status ${r.status}`);
  r = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "E2E", email: invited, password }) });
  check("missing Origin refused (403)", r.status === 403, `status ${r.status}`);

  // Server-owned fields can't be sent.
  r = await signUp({ name: "E2E", email: invited, password, role: "admin" });
  check('body with role:"admin" refused (400)', r.status === 400 && (await codeOf(r)) === "INVALID_INPUT", `status ${r.status}`);
  r = await signUp({ name: "E2E", email: invited, password, status: "active" });
  check("body with status refused (400)", r.status === 400, `status ${r.status}`);
  check("no user created by the refused requests", (await countUsers(invited)) === 0);

  // Not invited.
  r = await signUp({ name: "Stranger", email: stranger, password });
  check("not-invited email refused (403 NOT_ALLOWLISTED)", r.status === 403 && (await codeOf(r)) === "NOT_ALLOWLISTED", `status ${r.status}`);
  check("no user for the not-invited email", (await countUsers(stranger)) === 0);

  // Invited: signs up (email typed with capitals).
  await clearRateLimits();
  r = await signUp({ name: "  E2E Tester  ", email: invited.toUpperCase(), password });
  const body = (await r.json().catch(() => ({}))) as { token?: string; user?: Record<string, unknown> };
  check("invited email signs up (200)", r.status === 200, `status ${r.status}`);
  const setCookie = r.headers.get("set-cookie") ?? "";
  check(
    "session cookie: HttpOnly, SameSite=Lax, Path=/, 30 days",
    /better-auth\.session_token=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie) && /Path=\//.test(setCookie) && /Max-Age=2592000/.test(setCookie),
  );
  check("answer has role creator, status active, no login-protection fields", body.user?.role === "creator" && body.user?.status === "active" && !("failedLoginCount" in (body.user ?? {})));
  const cookie = setCookie.split(";")[0] ?? "";

  const user = await db.collection("user").findOne({ email: invited });
  check("user saved with the lowercased email and trimmed name", !!user && user.name === "E2E Tester");
  check("user is creator + active with server defaults", user?.role === "creator" && user?.status === "active" && user?.timezone === "Asia/Kolkata" && user?.failedLoginCount === 0);
  const account = await db.collection("account").findOne({ userId: user?._id });
  check("account (credential) saved, found by userId as ObjectId", account?.providerId === "credential");
  check("password stored as a hash, not plain text", typeof account?.password === "string" && account.password !== password && !account.password.includes(password));
  const session = await db.collection("session").findOne({ userId: user?._id });
  check("session saved, found by userId as ObjectId", !!session);
  const days = session ? (session.expiresAt.getTime() - Date.now()) / 86_400_000 : 0;
  check("session expires in ~30 days", days > 29.9 && days <= 30.01, `${days.toFixed(2)} days`);
  const invite = await db.collection("allowlist").findOne({ email: invited });
  check("allowlist.signedUpUserId = the new user's _id (ObjectId)", invite?.signedUpUserId instanceof ObjectId && invite.signedUpUserId.equals(user?._id));

  // Session works.
  r = await fetch(`${base}/api/auth/get-session`, { headers: { cookie } });
  const s = (await r.json().catch(() => null)) as { user?: { name?: string } } | null;
  check("get-session with the cookie returns the user", r.status === 200 && s?.user?.name === "E2E Tester");
  r = await fetch(`${base}/api/auth/get-session`);
  check("get-session without a cookie returns null", r.status === 200 && (await r.text()) === "null");
  r = await fetch(`${base}/dashboard`, { headers: { cookie }, redirect: "manual" });
  check("dashboard shows 'Signed in as <name>'", r.status === 200 && /Signed in as/.test(await r.text()));
  r = await fetch(`${base}/dashboard`, { redirect: "manual" });
  check("dashboard without a session redirects to /login (F09)", r.status >= 300 && r.status < 400 && (r.headers.get("location") ?? "").includes("/login"), `status ${r.status}`);

  // Same email twice.
  r = await signUp({ name: "Again", email: invited, password });
  const dup = (await r.json().catch(() => ({}))) as { code?: string; message?: string };
  check("same email twice: 422 USER_ALREADY_EXISTS", r.status === 422 && dup.code === "USER_ALREADY_EXISTS", `${r.status} ${dup.message ?? ""}`);
  check("still exactly one user for that email", (await countUsers(invited)) === 1);

  // Rate limit: 5 per 15 min per IP.
  await clearRateLimits();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await signUp({ name: "Stranger", email: stranger, password })).status);
  check("sign-up limit: first 5 pass, 6th is 429", statuses.slice(0, 5).every((x) => x === 403) && statuses[5] === 429, statuses.join(","));
  r = await signUp({ name: "Stranger", email: stranger, password });
  check("429 carries Retry-After", r.status === 429 && Number(r.headers.get("retry-after")) > 0, `Retry-After ${r.headers.get("retry-after")}`);
  r = await signUp({ name: "Stranger", email: stranger, password }, { "x-forwarded-for": "198.51.100.7" });
  check("a made-up X-Forwarded-For does not get around the limit", r.status === 429, `status ${r.status}`);
  const counters = await db.collection("rateLimits").find({}).toArray();
  check("rate-limit counter holds only a hash (no raw IP)", counters.length > 0 && counters.every((c) => /^signup-ip:sha256:[0-9a-f]{64}:\d{4}-/.test(String(c._id)) && c.expiresAt instanceof Date), counters.map((c) => String(c._id).slice(0, 24)).join(" "));

  // Pages.
  r = await fetch(`${base}/signup`);
  const html = await r.text();
  check("/signup page renders the form", r.status === 200 && html.includes("Create your account") && html.includes("Confirm password"));
  r = await fetch(`${base}/access-pending`);
  check("/access-pending placeholder renders", r.status === 200);

  // Q17: the real shapes, ids and indexes (values not printed).
  console.log("\nQ17 — field types of the real documents:");
  console.log("  user:   ", JSON.stringify(shape(user)));
  console.log("  session:", JSON.stringify(shape(session)));
  console.log("  account:", JSON.stringify(shape(account)));
  console.log(`  account.accountId equals user._id as text: ${account?.accountId === user?._id.toHexString()}`);
  console.log("\nIndexes in", TEST_DB);
  for (const name of ["user", "session", "account", "verification", "allowlist", "rateLimits"]) {
    const list = await db.collection(name).indexes().catch(() => []);
    console.log(`  ${name}: ${list.map((i) => `${i.name} ${JSON.stringify(i.key)}${i.unique ? " unique" : ""}${i.expireAfterSeconds !== undefined ? ` ttl=${i.expireAfterSeconds}` : ""}`).join(" | ")}`);
  }

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
