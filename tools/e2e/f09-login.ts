import { randomBytes } from "node:crypto";
import { addInvite, AUTH_RATE_LIMITS, closeMongoClient, getDb, hitRateLimit, readDbConfig, recordFailedLogin } from "@bytereel/db";

/**
 * F09 end-to-end check over real HTTP, against a running `next start` server.
 * SAFETY: works only on the separate test database `bytereel_test` (never the real `bytereel`).
 *
 *   1. MONGODB_DB=bytereel_test npm run db -- indexes --feature F07 --feature F08 --apply
 *   2. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3232 npx next start -p 3232
 *   3. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3232 npx tsx tools/e2e/f09-login.ts
 *   4. drop the bytereel_test database afterwards
 *
 * Uses only @example.com emails and random throw-away passwords. Prints no secrets.
 * The local server isn't on Vercel, so every request shares ONE IP counter (by design); the script
 * clears the rateLimits collection between parts.
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
const email = `f09-e2e-${tag}@example.com`;
const unknown = `f09-nobody-${tag}@example.com`;
const password = `E2e-${randomBytes(9).toString("base64url")}`;
// HTML in the name (must be shown as text) and a long name (must be shortened in the header).
const name = "<b>Bold</b> E2E Tester with a really quite long name for the header";

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
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const signIn = (body: unknown, headers: Record<string, string> = {}) => post("/api/auth/sign-in/email", body, headers);
const page = (path: string, cookie = "") => fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
const json = async (r: Response) => (await r.json().catch(() => ({}))) as { code?: string; message?: string; token?: string; user?: Record<string, unknown> };
const clearRateLimits = () => db.collection("rateLimits").deleteMany({});
const user = () => db.collection("user").findOne({ email });
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const redirectsTo = (r: Response, path: string) => r.status >= 300 && r.status < 400 && new URL(r.headers.get("location") ?? "", base).pathname === path;

async function main(): Promise<void> {
  await clearRateLimits();
  await addInvite(db, email, { note: "F09 e2e test (bytereel_test)" });
  let r = await post("/api/auth/sign-up/email", { name, email, password });
  check("test account created through sign-up", r.status === 200, `status ${r.status}`);
  const u0 = await user();
  check("new account starts with failedLoginCount 0, lastLoginAt null", u0?.failedLoginCount === 0 && u0?.lastLoginAt === null);

  // --- Pages while signed out.
  r = await page("/login");
  let html = await r.text();
  check("/login renders the Stitch screen", r.status === 200 && html.includes("Welcome back") && html.includes("Log in to keep creating."));
  check("/login: 'Forgot your password? Contact the … team.' links to /contact", /Forgot your password\?/.test(html) && /href="\/contact"/.test(html));
  check("/login: 'New here? Create an account' links to /signup", html.includes("Create an account") && /href="\/signup"/.test(html));
  r = await page("/dashboard");
  check("/dashboard signed out → /login", redirectsTo(r, "/login"), `${r.status} ${r.headers.get("location")}`);
  r = await page("/");
  html = await r.text();
  check("home header signed out shows 'Log in', no name", r.status === 200 && /href="\/login"/.test(html) && !html.includes("E2E Tester"));

  // --- Wrong email / wrong password: identical answers.
  await clearRateLimits();
  const wrongPw = await signIn({ email, password: `${password}x` });
  const wrongPwBody = await json(wrongPw);
  const noUser = await signIn({ email: unknown, password });
  const noUserBody = await json(noUser);
  check("wrong password → 401 'Email or password is incorrect'", wrongPw.status === 401 && wrongPwBody.code === "INVALID_EMAIL_OR_PASSWORD" && wrongPwBody.message === "Email or password is incorrect");
  check("unknown email → exactly the same 401 body", noUser.status === 401 && JSON.stringify(noUserBody) === JSON.stringify(wrongPwBody));
  check("wrong password counted on the account (failedLoginCount 1)", (await user())?.failedLoginCount === 1);
  check("unknown email stores nothing", (await db.collection("user").countDocuments({ email: unknown })) === 0);

  // --- Strict body and Origin.
  r = await signIn({ email, password, role: "admin" });
  check("extra field → 400 INVALID_INPUT", r.status === 400 && (await json(r)).code === "INVALID_INPUT", `status ${r.status}`);
  r = await signIn({ email, password, callbackURL: "https://evil.example" });
  check("callbackURL refused (400)", r.status === 400, `status ${r.status}`);
  r = await signIn({ email, password }, { origin: "https://evil.example" });
  check("wrong Origin → 403 FORBIDDEN_ORIGIN", r.status === 403 && (await json(r)).code === "FORBIDDEN_ORIGIN");

  // --- Correct password (email typed in capitals, rememberMe:false is ignored).
  await clearRateLimits();
  r = await signIn({ email: email.toUpperCase(), password, rememberMe: false });
  const ok = await json(r);
  const setCookie = r.headers.get("set-cookie") ?? "";
  check("correct password → 200 with the user", r.status === 200 && ok.user?.email === email, `status ${r.status}`);
  check("session cookie: HttpOnly, SameSite=Lax, 30 days (rememberMe ignored)", /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie) && /Max-Age=2592000/.test(setCookie));
  check("answer leaks no login-protection fields", !("failedLoginCount" in (ok.user ?? {})) && !("lockedUntil" in (ok.user ?? {})));
  const u1 = await user();
  check("success: failedLoginCount 0, lockedUntil null, lastLoginAt set", u1?.failedLoginCount === 0 && u1?.lockedUntil === null && u1?.lastLoginAt instanceof Date && Date.now() - u1.lastLoginAt.getTime() < 60_000);
  const cookie = cookieOf(r);

  // --- Pages while signed in.
  r = await page("/dashboard", cookie);
  html = await r.text();
  check("/dashboard shows the name and a Log out button", r.status === 200 && html.includes("&lt;b&gt;Bold&lt;/b&gt; E2E Tester") && html.includes("Log out"));
  r = await page("/login", cookie);
  check("/login signed in → /dashboard", redirectsTo(r, "/dashboard"), `${r.status} ${r.headers.get("location")}`);
  r = await page("/signup", cookie);
  check("/signup signed in → /dashboard", redirectsTo(r, "/dashboard"), `${r.status} ${r.headers.get("location")}`);
  r = await page("/", cookie);
  html = await r.text();
  check("home header signed in shows the name, not 'Log in'", html.includes("E2E Tester") && !/href="\/login"/.test(html));
  check("name shown as text: HTML escaped, never raw", html.includes("&lt;b&gt;Bold&lt;/b&gt;") && !html.includes("<b>Bold</b>"));
  check("long name is shortened in the header (truncate)", /class="[^"]*truncate[^"]*"[^>]*>&lt;b&gt;Bold/.test(html));

  // --- Log out.
  const token = decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";
  check("session row exists before logging out", (await db.collection("session").countDocuments({ token })) === 1);
  r = await post("/api/auth/sign-out", {}, { cookie });
  check("sign-out → 200 and the cookie is cleared", r.status === 200 && /Max-Age=0/.test(r.headers.get("set-cookie") ?? ""), `status ${r.status}`);
  check("session row deleted", (await db.collection("session").countDocuments({ token })) === 0);
  r = await page("/", cookie);
  html = await r.text();
  check("old cookie after logout: home shows 'Log in', the name is gone", /href="\/login"/.test(html) && !html.includes("E2E Tester"));
  r = await page("/dashboard", cookie);
  check("old cookie after logout: /dashboard → /login", redirectsTo(r, "/login"));
  r = await fetch(`${base}/api/auth/get-session`, { headers: { cookie } });
  check("old cookie after logout: get-session is null", (await r.text()) === "null");
  r = await post("/api/auth/sign-out", {}, { cookie });
  // Better Auth 1.7.14 answers 200 here too (it just clears the cookie); the button goes home either way.
  check("sign-out again without a session → 200, cookie cleared", r.status === 200 && /Max-Age=0/.test(r.headers.get("set-cookie") ?? ""), `status ${r.status}`);

  // --- Rate limit per IP: 5 per 15 minutes.
  await clearRateLimits();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await signIn({ email: `f09-ip-${i}-${tag}@example.com`, password })).status);
  check("per IP: 5 attempts pass, the 6th is 429", statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 429, statuses.join(","));
  r = await signIn({ email, password }, { "x-forwarded-for": "198.51.100.7" });
  const limited = await json(r);
  check("429 TOO_MANY_ATTEMPTS + Retry-After; a made-up X-Forwarded-For doesn't help", r.status === 429 && limited.code === "TOO_MANY_ATTEMPTS" && Number(r.headers.get("retry-after")) > 0);

  // --- Rate limit per email (IP counter fresh, email counter already at 5).
  await clearRateLimits();
  for (let i = 0; i < 5; i++) await hitRateLimit(db, AUTH_RATE_LIMITS.signInPerEmail, email);
  r = await signIn({ email, password });
  check("per email: 6th attempt for the same email → 429 even with the right password", r.status === 429 && JSON.stringify(await json(r)) === JSON.stringify(limited));
  r = await signIn({ email: unknown, password });
  check("…while another email from the same IP still gets through", r.status === 401, `status ${r.status}`);
  const counters = await db.collection("rateLimits").find({}).toArray();
  check("counters hold only hashes (no raw IP or email)", counters.every((c) => /^(signin-ip|signin-email):sha256:[0-9a-f]{64}:/.test(String(c._id))) && !JSON.stringify(counters).includes(email));

  // --- Lockout: 10 wrong passwords in a row → locked 15 minutes.
  for (let i = 0; i < 10; i++) {
    if (i % 4 === 0) await clearRateLimits();
    await signIn({ email, password: `wrong-${i}` });
  }
  const u2 = await user();
  const sessionsBefore = await db.collection("session").countDocuments({ userId: u2?._id });
  const lockMinutes = u2?.lockedUntil instanceof Date ? (u2.lockedUntil.getTime() - Date.now()) / 60_000 : 0;
  check("10 wrong passwords → failedLoginCount 10, lockedUntil ≈ now + 15 min", u2?.failedLoginCount === 10 && lockMinutes > 14.5 && lockMinutes <= 15.01, `count ${u2?.failedLoginCount}, ${lockMinutes.toFixed(2)} min`);
  await clearRateLimits();
  r = await signIn({ email, password });
  check("locked: right password → the same 429 body as the rate limit", r.status === 429 && JSON.stringify(await json(r)) === JSON.stringify(limited));
  check("locked: Retry-After is the time left on the lock", Math.abs(Number(r.headers.get("retry-after")) - lockMinutes * 60) < 10, `Retry-After ${r.headers.get("retry-after")}`);
  check("locked: no session created", (await db.collection("session").countDocuments({ userId: u2?._id })) === sessionsBefore);
  // The lock runs out (moved into the past instead of waiting 15 minutes).
  await db.collection("user").updateOne({ email }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
  r = await signIn({ email, password });
  const u3 = await user();
  check("after the lock: right password logs in and resets the counters", r.status === 200 && u3?.failedLoginCount === 0 && u3?.lockedUntil === null, `status ${r.status}`);

  // --- The counter is safe when many wrong passwords arrive at the same moment (real MongoDB).
  await Promise.all(Array.from({ length: 12 }, () => recordFailedLogin(db, email)));
  const u4 = await user();
  check("12 failures at the same moment: count 12, locked once at the 10th", u4?.failedLoginCount === 12 && u4?.lockedUntil instanceof Date && u4.lockedUntil.getTime() > Date.now());
  await db.collection("user").updateOne({ email }, { $set: { failedLoginCount: 0, lockedUntil: null } });

  // --- A session that already exists stops counting once the account isn't active (F09 review).
  await clearRateLimits();
  r = await signIn({ email, password });
  const liveCookie = cookieOf(r);
  await db.collection("user").updateOne({ email }, { $set: { status: "suspended" } });
  r = await page("/dashboard", liveCookie);
  check("existing session of a suspended user: /dashboard → /login", redirectsTo(r, "/login"), `${r.status} ${r.headers.get("location")}`);
  html = await (await page("/", liveCookie)).text();
  check("existing session of a suspended user: header shows 'Log in', no name", /href="\/login"/.test(html) && !html.includes("E2E Tester"));
  await db.collection("user").updateOne({ email }, { $set: { status: "active" } });
  await db.collection("session").deleteMany({ userId: u4?._id });

  // --- Paused / deleting accounts.
  for (const status of ["suspended", "deleting"]) {
    await clearRateLimits();
    await db.collection("user").updateOne({ email }, { $set: { status } });
    const before = await db.collection("session").countDocuments({ userId: u4?._id });
    r = await signIn({ email, password });
    const b = await json(r);
    check(`${status}: right password → 403 ACCOUNT_SUSPENDED, no session`, r.status === 403 && b.code === "ACCOUNT_SUSPENDED" && (await db.collection("session").countDocuments({ userId: u4?._id })) === before, `status ${r.status}`);
    r = await signIn({ email, password: "wrong-password" });
    check(`${status}: wrong password → the generic 401`, r.status === 401);
  }
  await db.collection("user").updateOne({ email }, { $set: { status: "active", failedLoginCount: 0, lockedUntil: null } });

  // --- get-session: 120 per minute per IP.
  await clearRateLimits();
  const sessionStatuses = await Promise.all(Array.from({ length: 121 }, () => fetch(`${base}/api/auth/get-session`).then((x) => x.status)));
  const tooMany = sessionStatuses.filter((s) => s === 429).length;
  check("get-session: 120 pass, the 121st is 429", tooMany === 1 && sessionStatuses.filter((s) => s === 200).length === 120, `429s: ${tooMany}`);

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
