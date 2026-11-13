import { randomBytes } from "node:crypto";
import { addInvite, API_RATE_LIMITS, closeMongoClient, getDb, rateLimitId, rateLimitWindow, readDbConfig, usagePeriods } from "@bytereel/db";

/**
 * F11 end-to-end check over real HTTP, against a running `next start` server: the app shell,
 * the empty My videos page, the temporary /projects/new page and B1 GET /api/v1/me.
 * SAFETY: works only on the separate test database `bytereel_test` (never the real `bytereel`).
 *
 *   1. MONGODB_DB=bytereel_test npm run db -- indexes --feature F07 --feature F08 --apply
 *   2. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3234 npx next start -p 3234
 *   3. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3234 npx tsx tools/e2e/f11-shell.ts
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
const email = `f11-e2e-${tag}@example.com`;
const password = `E2e-${randomBytes(9).toString("base64url")}`;
const name = "<i>Tara</i> Shell Tester";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

const post = (path: string, body: unknown, cookie = "") =>
  fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const page = (path: string, cookie = "") => fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
const me = (cookie = "", headers: Record<string, string> = {}) => fetch(`${base}/api/v1/me`, { headers: { ...(cookie ? { cookie } : {}), ...headers } });
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const redirectsTo = (r: Response, path: string) => r.status >= 300 && r.status < 400 && new URL(r.headers.get("location") ?? "", base).pathname === path;
const clearRateLimits = () => db.collection("rateLimits").deleteMany({});
const REQ_ID = /^req_[0-9A-HJKMNP-TV-Z]{16}$/;

/** The page HTML without React's text separators ("0<!-- --> of <!-- -->3" → "0 of 3"). */
const htmlOf = async (r: Response) => (await r.text()).replace(/<!-- -->/g, "");

async function main(): Promise<void> {
  await clearRateLimits();

  // --- Signed out.
  let r = await page("/dashboard");
  check("signed out: /dashboard → /login", redirectsTo(r, "/login"), `${r.status} ${r.headers.get("location")}`);
  r = await page("/projects/new");
  check("signed out: /projects/new → /login", redirectsTo(r, "/login"), `${r.status} ${r.headers.get("location")}`);
  r = await me();
  let body = (await r.json()) as { error?: { code?: string; message?: string; requestId?: string } };
  check(
    "signed out: GET /api/v1/me → 401 UNAUTHENTICATED envelope",
    r.status === 401 && body.error?.code === "UNAUTHENTICATED" && body.error.message === "Please log in again.",
    `status ${r.status}`,
  );
  check("401: requestId in the body equals X-Request-Id, format req_…", body.error?.requestId === r.headers.get("x-request-id") && REQ_ID.test(body.error?.requestId ?? ""));
  check("401: Cache-Control no-store", r.headers.get("cache-control") === "no-store");

  // --- Sign up → land on My videos.
  await addInvite(db, email, { note: "F11 e2e test (bytereel_test)" });
  r = await post("/api/auth/sign-up/email", { name, email, password });
  check("test account created through sign-up", r.status === 200, `status ${r.status}`);
  let cookie = cookieOf(r);
  r = await page("/login", cookie);
  check("signed in: /login → /dashboard (where log in lands)", redirectsTo(r, "/dashboard"), `${r.status} ${r.headers.get("location")}`);

  // --- The shell and the empty My videos page.
  r = await page("/dashboard", cookie);
  let html = await htmlOf(r);
  check("/dashboard renders (200)", r.status === 200, `status ${r.status}`);
  check("title is 'My videos · <product>'", /<title>My videos · [^<]+<\/title>/.test(html));
  check("top bar: logo links to /dashboard", (html.match(/<a [^>]*>/g) ?? []).some((a) => a.includes('href="/dashboard"') && /aria-label="[^"]+: My videos"/.test(a)));
  check("top bar: 'My videos' is the current page", /aria-current="page"[^>]*>My videos<\/a>/.test(html));
  check("top bar: Settings shown as 'Soon', no link to /settings", html.includes("Settings") && html.includes("Soon") && !html.includes('href="/settings"'));
  check("top bar: 'Videos today: 0 of 3' pill", html.includes("Videos today: 0 of 3"));
  check("top bar: bell with no unread badge", html.includes('aria-label="Notifications"') && !html.includes("unread\"") && !html.includes("shadow-[0_0_8px_#f5a524]"));
  check("bell panel says 'No notifications yet'", html.includes("No notifications yet"));
  check("avatar menu: name shown as text (escaped), email, My videos, Log out", html.includes("&lt;i&gt;Tara&lt;/i&gt; Shell Tester") && !html.includes("<i>Tara</i>") && html.includes(email) && html.includes("Log out"));
  check("tabs Drafts / Ready / Scheduled / Published", ["Drafts", "Ready", "Scheduled", "Published"].every((t) => html.includes(`>${t}</a>`)));
  check("Drafts is the current tab by default", /aria-current="page"[^>]*>Drafts<\/a>/.test(html) || /<a[^>]*href="\/dashboard"[^>]*aria-current="page"[^>]*>Drafts/.test(html));
  check("empty state: 'No videos yet' + text", html.includes("No videos yet") && html.includes("Turn any topic into a ready-to-post Reel in a few minutes."));
  check("one primary button: 'Create your first reel' → /projects/new", html.includes("Create your first reel") && /href="\/projects\/new"/.test(html) && !html.includes("New video</"));
  check("the temporary F08/F09 page is gone", !html.includes("You&#x27;re in") && !html.includes("My videos comes in F11"));
  check("no login-protection fields in the page", !/failedLoginCount|lockedUntil|lastLoginAt/.test(html));

  for (const [tab, title] of [["ready", "Nothing ready yet"], ["scheduled", "Nothing scheduled"], ["published", "Nothing published yet"]] as const) {
    html = await htmlOf(await page(`/dashboard?tab=${tab}`, cookie));
    const label = tab[0]!.toUpperCase() + tab.slice(1);
    check(`?tab=${tab}: '${title}' and ${label} is current`, html.includes(title) && new RegExp(`aria-current="page"[^>]*>${label}</a>`).test(html) && html.includes("Create your first reel"));
  }
  html = await htmlOf(await page("/dashboard?tab=bogus", cookie));
  check("unknown ?tab= shows Drafts", html.includes("No videos yet") && /aria-current="page"[^>]*>Drafts<\/a>/.test(html));

  r = await page("/projects/new", cookie);
  html = await htmlOf(r);
  check("/projects/new: temporary page inside the shell, no 404", r.status === 200 && html.includes("Step 1 Idea arrives in F12") && html.includes("Videos today") && html.includes("Back to My videos"));

  // --- B1 GET /api/v1/me.
  const now = new Date();
  r = await me(cookie);
  const meBody = (await r.json()) as Record<string, unknown> & { usage?: Record<string, { used: number; limit: number; resetsAt: string | null }> };
  check("B1: 200", r.status === 200, `status ${r.status}`);
  check("B1: Cache-Control no-store, X-Request-Id req_…", r.headers.get("cache-control") === "no-store" && REQ_ID.test(r.headers.get("x-request-id") ?? ""));
  const keys = Object.keys(meBody).sort().join(",");
  check(
    "B1: exactly the documented fields",
    keys === "createdAt,defaultLanguage,defaultVoiceGender,email,id,instagram,maintenance,name,role,timezone,unreadNotifications,usage",
    keys,
  );
  const u = await db.collection("user").findOne({ email });
  check("B1: profile matches the account", meBody.id === u?._id.toHexString() && meBody.name === name && meBody.email === email && meBody.role === "creator");
  check("B1: defaults (Asia/Kolkata, en, female)", meBody.timezone === "Asia/Kolkata" && meBody.defaultLanguage === "en" && meBody.defaultVoiceGender === "female");
  check("B1: createdAt is ISO UTC with ms", typeof meBody.createdAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(meBody.createdAt));
  const periods = usagePeriods("Asia/Kolkata", now);
  const day = periods.dayResetsAt.toISOString();
  check(
    "B1: usage 0 of 3 / 5 / 3000 with resets at local midnight and month end",
    JSON.stringify(meBody.usage) ===
      JSON.stringify({
        videosToday: { used: 0, limit: 3, resetsAt: day },
        projectsToday: { used: 0, limit: 5, resetsAt: day },
        voiceCharactersThisMonth: { used: 0, limit: 3000, resetsAt: periods.monthResetsAt.toISOString() },
      }),
    JSON.stringify(meBody.usage),
  );
  check("B1: daily reset is at 18:30Z (midnight Asia/Kolkata)", day.endsWith("T18:30:00.000Z"));
  check("B1: instagram not connected, 0 unread, no maintenance", JSON.stringify(meBody.instagram) === '{"status":"not_connected","username":null}' && meBody.unreadNotifications === 0 && JSON.stringify(meBody.maintenance) === '{"active":false,"message":null}');
  check("B1: no login-protection or status fields", !/failedLoginCount|lockedUntil|lastLoginAt/.test(JSON.stringify(meBody)) && !("status" in meBody));
  r = await me(cookie, { "x-request-id": "trace-f11-e2e" });
  check("B1: a valid client X-Request-Id is echoed", r.headers.get("x-request-id") === "trace-f11-e2e");
  r = await fetch(`${base}/api/v1/me`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: "{}" });
  check("B1: POST /api/v1/me is not allowed (405)", r.status === 405, `status ${r.status}`);

  // --- B1 rate limit: 300 per minute per user. The counter is filled to 300 instead of sending
  // 300 requests; wait if the minute is about to roll over.
  const rule = API_RATE_LIMITS.readsPerUser;
  if (rateLimitWindow(rule, new Date()).end.getTime() - Date.now() < 5000) await new Promise((res) => setTimeout(res, 5500));
  const at = new Date();
  await db.collection<{ _id: string }>("rateLimits").updateOne(
    { _id: rateLimitId(rule, u!._id.toHexString(), at) },
    { $set: { count: rule.limit, expiresAt: rateLimitWindow(rule, at).end } },
    { upsert: true },
  );
  r = await me(cookie);
  body = (await r.json()) as typeof body & { error?: { details?: { retryAfterSeconds?: number } } };
  const retry = Number(r.headers.get("retry-after"));
  check(
    "B1: request 301 in a minute → 429 RATE_LIMITED + Retry-After",
    r.status === 429 && body.error?.code === "RATE_LIMITED" && retry >= 1 && retry <= 60 && (body.error as { details?: { retryAfterSeconds?: number } }).details?.retryAfterSeconds === retry,
    `status ${r.status}, Retry-After ${retry}`,
  );
  await clearRateLimits();

  // --- An existing session of a suspended user stops working (API.md §3.1).
  await db.collection("user").updateOne({ email }, { $set: { status: "suspended" } });
  r = await me(cookie);
  check("suspended: B1 → 401 UNAUTHENTICATED", r.status === 401);
  r = await page("/dashboard", cookie);
  check("suspended: /dashboard → /login", redirectsTo(r, "/login"));
  await db.collection("user").updateOne({ email }, { $set: { status: "active" } });

  // --- Log out (what the avatar menu's Log out button calls).
  r = await post("/api/auth/sign-out", {}, cookie);
  check("log out: 200", r.status === 200, `status ${r.status}`);
  r = await page("/dashboard", cookie);
  check("after log out: /dashboard → /login", redirectsTo(r, "/login"));
  r = await me(cookie);
  check("after log out: B1 → 401", r.status === 401);

  // --- Log in again lands on My videos (the login form goes to /dashboard; the server agrees).
  r = await post("/api/auth/sign-in/email", { email, password });
  cookie = cookieOf(r);
  r = await page("/dashboard", cookie);
  check("log in again: /dashboard shows the shell", r.status === 200 && (await htmlOf(r)).includes("No videos yet"));

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
