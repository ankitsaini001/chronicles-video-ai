import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { addInvite, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, readDbConfig, type InstagramConnectionDocument, type ProjectDocument, type RenderDocument } from "@bytereel/db";
import { ObjectId } from "mongodb";
import { fakeIgUserId } from "../../apps/web/lib/instagram/fake-instagram";
import { signState, stateKey } from "../../apps/web/lib/instagram/state";

/**
 * F28 end-to-end check over real HTTP ("Connect / disconnect Instagram") with the Instagram
 * STAND-IN (E2E_FAKE_INSTAGRAM=1: its own pretend login page and token answers, ZERO calls to Meta).
 * No video is made: the check seeds one ready project (and its render document) per test user in the
 * TEST database, like F24's check. It proves: signed out → /login (G2, G3, the page) and 401 (G1);
 * "Publish →" and the stepper's 4 Publish on the ready video; the Step 4 page (Connect your
 * Instagram); G2 → the stand-in login page with a signed state; a Creator account connects
 * (@username on the page, B1 and G1, the token ENCRYPTED in the database and never in any answer, the
 * audit entry); a personal account, a token without the posting permission and Cancel are refused
 * with the plain codes; a second user can't
 * connect the same account (also when two users finish at the same moment: one wins); forged,
 * expired and other-session states; a foreign project in returnTo (404) and a foreign project page
 * (404); Disconnect (Origin check, token removed, revoked, audit, 404 the second time, B1 back to
 * not_connected); the freed account can then be connected by the other user; reconnecting keeps ONE
 * document per user.
 *
 * TEMP FILES: never in /tmp. In every terminal used below, first run from the repo root:
 *   mkdir -p runs/.tmp && export TMPDIR="$PWD/runs/.tmp"
 * SAFETY: only the separate test database `bytereel_test`, ports 3230–3239 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3238 E2E_FAKE_INSTAGRAM=1 E2E_FAKE_GEMINI=1 \
 *        E2E_FAKE_ELEVENLABS=1 INNGEST_DEV=http://localhost:8299 TOKEN_ENCRYPTION_KEYS='{"1":"<openssl rand -base64 32>"}' \
 *        TOKEN_ENCRYPTION_ACTIVE_VERSION=1 npx next start -p 3238
 *      (a throw-away test key; no Inngest is started, nothing listens on 8299)
 *   3. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3238 npx tsx tools/e2e/f28-instagram.ts
 *   4. stop the server (by its pid) and drop the bytereel_test database afterwards.
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has E2E_FAKE_INSTAGRAM=1 and MONGODB_DB=bytereel_test. It signs one EXPIRED state
 * itself with the same BETTER_AUTH_SECRET (from .env) to prove the time limit. Tokens are never printed.
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
if (env.get("E2E_FAKE_INSTAGRAM") !== "1" || env.get("MONGODB_DB") !== TEST_DB) throw new Error("Stopping before any request: the server must run with E2E_FAKE_INSTAGRAM=1 and MONGODB_DB=bytereel_test.");
const authSecret = (env.get("BETTER_AUTH_SECRET") ?? process.env.BETTER_AUTH_SECRET ?? "").trim();

const tag = randomBytes(4).toString("hex");
let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  else passes++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

type Json = Record<string, any>;
/** Every answer body and Location seen, to prove no token ever leaves the server. */
const seen: string[] = [];
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
async function get(cookie: string, path: string): Promise<{ status: number; location: string; text: string }> {
  const r = await fetch(path.startsWith("http") ? path : `${base}${path}`, { headers: { cookie }, redirect: "manual" });
  const text = (await r.text()).replace(/<!-- -->/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
  const location = r.headers.get("location") ?? "";
  seen.push(text, location);
  return { status: r.status, location, text };
}
async function send(cookie: string, method: string, path: string, headers: Record<string, string> = { origin: base }): Promise<{ status: number; json: Json }> {
  const r = await fetch(`${base}${path}`, { method, headers: { cookie, ...headers }, redirect: "manual" });
  const text = await r.text();
  seen.push(text);
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = {};
  }
  return { status: r.status, json };
}

type Tester = { cookie: string; id: ObjectId; email: string; password: string; projectId: string };

async function signUp(label: string): Promise<Tester> {
  const email = `f28-e2e-${label}-${tag}@example.com`;
  const password = `E2e-${randomBytes(9).toString("base64url")}`;
  await addInvite(db, email, { note: "F28 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ name: `F28 Tester ${label}`, email, password }) });
  check(`test account ${label} created`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  const id = user!._id as ObjectId;
  return { cookie: cookieOf(r), id, email, password, projectId: await seedReadyProject(id) };
}

async function logInAgain(t: Tester): Promise<string> {
  const r = await fetch(`${base}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: t.email, password: t.password }) });
  return cookieOf(r);
}

/** The id of the login session behind a cookie (to sign the test's own expired state). */
async function sessionIdOf(cookie: string): Promise<string> {
  const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".")[0];
  const session = await db.collection("session").findOne({ token });
  return String(session!._id);
}

/** One ready project with one ready video and its storyboard version (no real file is needed: the pages only sign links). */
async function seedReadyProject(ownerId: ObjectId): Promise<string> {
  const now = new Date();
  const projectId = new ObjectId();
  const renderId = new ObjectId();
  const planVersionId = new ObjectId();
  const project: ProjectDocument = {
    _id: projectId,
    ownerId,
    schemaVersion: 1,
    title: "How rainbows form / F28 e2e",
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
    createdAt: now,
    updatedAt: now,
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
  // The storyboard version the video was made from (the video page reads it), from the fixture plan.
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
  return projectId.toHexString();
}

const connections = () => db.collection<InstagramConnectionDocument>("instagramConnections");

/** G2 for this user → the stand-in login page address (with the signed state). */
async function startConnect(t: Tester, returnTo = `publish:${t.projectId}`): Promise<{ status: number; location: string; state: string }> {
  const r = await get(t.cookie, `/api/v1/instagram/connect?returnTo=${encodeURIComponent(returnTo)}`);
  const state = r.location ? (new URL(r.location, base).searchParams.get("state") ?? "") : "";
  return { status: r.status, location: r.location, state };
}
const callback = (params: Record<string, string>) => `/api/v1/instagram/callback?${new URLSearchParams(params).toString()}`;
const back = (t: Tester, query: string) => `/projects/${t.projectId}/publish?${query}`;

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F23", "F28"]));
  const a = await signUp("a");
  const b = await signUp("b");
  const alpha = `alpha${tag}`;

  // ---------- signed out ----------
  const outG2 = await get("", "/api/v1/instagram/connect");
  const outG3 = await get("", callback({ code: "e2e.creator.x", state: "x.y" }));
  const outG1 = await send("", "GET", "/api/v1/instagram/connection");
  const outPage = await get("", `/projects/${a.projectId}/publish`);
  check("signed out: G2 and G3 → /login, G1 → 401, the Step 4 page → /login", outG2.status === 302 && outG2.location.endsWith("/login") && outG3.location.endsWith("/login") && outG1.status === 401 && [302, 307].includes(outPage.status) && outPage.location.includes("/login"), `${outG2.status} ${outG3.location} ${outG1.status} ${outPage.status}`);

  // ---------- the ready video → Publish → ; the Step 4 page ----------
  const video = await get(a.cookie, `/projects/${a.projectId}/video`);
  check("the ready video has 'Publish →' to /publish (no 'coming soon')", video.status === 200 && video.text.includes(`href="/projects/${a.projectId}/publish"`) && video.text.includes("Publish →") && !video.text.includes("coming soon"), String(video.status));
  const step4 = await get(a.cookie, `/projects/${a.projectId}/publish`);
  check(
    "Step 4: 'Connect your Instagram', the three promises and Connect Instagram (a real link to G2)",
    step4.status === 200 &&
      step4.text.includes("Connect your Instagram") &&
      step4.text.includes("Nothing is posted without your approval") &&
      step4.text.includes(`href="/api/v1/instagram/connect?returnTo=publish%3A${a.projectId}"`),
    String(step4.status),
  );
  check("Step 4: the stepper is on 4 Publish, with links back to the storyboard and the video", /aria-current="step"[^>]*>[\s\S]{0,400}Publish/.test(step4.text) && step4.text.includes(`href="/projects/${a.projectId}/video"`));
  const foreignPage = await get(a.cookie, `/projects/${b.projectId}/publish`);
  check("another user's project: the Step 4 page is a 404", foreignPage.status === 404, String(foreignPage.status));
  const g1Before = await send(a.cookie, "GET", "/api/v1/instagram/connection");
  const meBefore = await send(a.cookie, "GET", "/api/v1/me");
  check("before: G1 connection null, B1 instagram not_connected", g1Before.status === 200 && g1Before.json.connection === null && meBefore.json.instagram?.status === "not_connected", JSON.stringify(meBefore.json.instagram));

  // ---------- G2 ----------
  const badReturn = await get(a.cookie, "/api/v1/instagram/connect?returnTo=https://evil.example");
  const foreignReturn = await get(a.cookie, `/api/v1/instagram/connect?returnTo=publish:${b.projectId}`);
  check("G2: a bad returnTo → 400 INVALID_INPUT; another user's project → 404", badReturn.status === 400 && badReturn.text.includes("INVALID_INPUT") && foreignReturn.status === 404, `${badReturn.status} ${foreignReturn.status}`);
  const startA = await startConnect(a);
  const authorize = startA.location ? new URL(startA.location) : null;
  check(
    "G2 → 302 to the stand-in login page with client_id, the callback address, the two scopes and a state",
    startA.status === 302 &&
      authorize?.origin === base &&
      authorize.pathname === "/api/v1/instagram/e2e-authorize" &&
      authorize.searchParams.get("redirect_uri") === `${base}/api/v1/instagram/callback` &&
      authorize.searchParams.get("scope") === "instagram_business_basic,instagram_business_content_publish" &&
      authorize.searchParams.get("response_type") === "code" &&
      startA.state.split(".").length === 2,
    startA.location.slice(0, 80),
  );
  const fakePage = await get(a.cookie, startA.location);
  check("the stand-in login page opens (tests only)", fakePage.status === 200 && fakePage.text.includes("Instagram stand-in") && fakePage.text.includes("access_denied"), String(fakePage.status));

  // ---------- connect a Creator account ----------
  const done = await get(a.cookie, callback({ code: `e2e.creator.${alpha}`, state: startA.state }));
  check("Creator account → 302 back to Step 4 with ?instagram=connected", done.status === 302 && done.location === back(a, "instagram=connected"), done.location);
  const g1 = await send(a.cookie, "GET", "/api/v1/instagram/connection");
  check(
    "G1: active, @username, MEDIA_CREATOR, ~60 days, no token field",
    g1.json.connection?.status === "active" &&
      g1.json.connection.username === `e2e_${alpha}` &&
      g1.json.connection.accountType === "MEDIA_CREATOR" &&
      g1.json.connection.igUserId === fakeIgUserId(alpha) &&
      Math.abs(new Date(g1.json.connection.tokenExpiresAt).getTime() - Date.now() - 60 * 86_400_000) < 120_000 &&
      !JSON.stringify(g1.json).includes("accessToken"),
    JSON.stringify(g1.json.connection ?? null).slice(0, 120),
  );
  const me = await send(a.cookie, "GET", "/api/v1/me");
  check("B1 instagram: active with the username", me.json.instagram?.status === "active" && me.json.instagram.username === `e2e_${alpha}`, JSON.stringify(me.json.instagram));
  const docA = await connections().findOne({ ownerId: a.id });
  const token = docA?.accessToken;
  check(
    "database: the token is ENCRYPTED ({ ciphertext, iv, tag, keyVersion }), never the plain token",
    !!token && token.keyVersion === "1" && Buffer.from(token.iv, "base64").length === 12 && Buffer.from(token.tag, "base64").length === 16 && !JSON.stringify(docA).includes("e2e-long") && docA!.scopes.length === 2,
  );
  const auditConnected = await db.collection("auditLogs").findOne({ actorId: a.id, action: "instagram.connected" });
  check("audit: instagram.connected (no token in it)", !!auditConnected && !JSON.stringify(auditConnected).includes(token?.ciphertext ?? "-") && !JSON.stringify(auditConnected).includes("e2e-long"));
  const step4Connected = await get(a.cookie, back(a, "instagram=connected"));
  check(
    "Step 4 connected: 'Publishing to @username', 'Instagram connected.', Disconnect, 'Publishing comes next'",
    step4Connected.text.includes(`data-testid="instagram-username">@e2e_${alpha}`) && step4Connected.text.includes("Instagram connected.") && step4Connected.text.includes("Disconnect") && step4Connected.text.includes("Publishing comes next"),
  );

  // ---------- refusals for user B ----------
  const startB1 = await startConnect(b);
  const personal = await get(b.cookie, callback({ code: `e2e.personal.bravo${tag}`, state: startB1.state }));
  check("personal account → INSTAGRAM_ACCOUNT_INELIGIBLE, nothing saved", personal.location === back(b, "instagram_error=INSTAGRAM_ACCOUNT_INELIGIBLE") && (await connections().countDocuments({ ownerId: b.id })) === 0, personal.location);
  const ineligiblePage = await get(b.cookie, personal.location);
  check("…and the page says it plainly (switch to Creator or Business)", ineligiblePage.text.includes("This Instagram account is personal. Switch it to a Creator or Business account"));
  const startB1b = await startConnect(b);
  const noPublish = await get(b.cookie, callback({ code: `e2e.nopublish.bravo${tag}`, state: startB1b.state }));
  check("posting un-ticked on Instagram's page → reason=missing_permission, nothing saved", noPublish.location === back(b, "instagram_error=INSTAGRAM_OAUTH_FAILED&reason=missing_permission") && (await connections().countDocuments({ ownerId: b.id })) === 0, noPublish.location);
  const noPublishPage = await get(b.cookie, noPublish.location);
  check("…and the page says to allow posting", noPublishPage.text.includes("Please allow posting when Instagram asks, then connect again."));
  const startB2 = await startConnect(b);
  const denied = await get(b.cookie, callback({ error: "access_denied", error_reason: "user_denied", error_description: "The user denied your request.", state: startB2.state }));
  check("Cancel on Instagram → INSTAGRAM_OAUTH_FAILED&reason=access_denied", denied.location === back(b, "instagram_error=INSTAGRAM_OAUTH_FAILED&reason=access_denied"), denied.location);
  const startB3 = await startConnect(b);
  const inUse = await get(b.cookie, callback({ code: `e2e.creator.${alpha}`, state: startB3.state }));
  check("the same Instagram account for a second user → INSTAGRAM_ACCOUNT_IN_USE, nothing saved", inUse.location === back(b, "instagram_error=INSTAGRAM_ACCOUNT_IN_USE") && (await connections().countDocuments({ ownerId: b.id })) === 0, inUse.location);
  const inUsePage = await get(b.cookie, inUse.location);
  check("…and the page says it plainly", /This Instagram account is already connected to another \S+ account\./.test(inUsePage.text));

  // ---------- states ----------
  const startB4 = await startConnect(b);
  const [body] = startB4.state.split(".");
  const forged = await get(b.cookie, callback({ code: `e2e.creator.bravo${tag}`, state: `${body}.${"A".repeat(43)}` }));
  check("a forged state → /dashboard with invalid_state (its returnTo isn't trusted)", forged.location === "/dashboard?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=invalid_state", forged.location);
  const crossUser = await get(a.cookie, callback({ code: `e2e.creator.bravo${tag}`, state: startB4.state }));
  check("B's state used by A (another session; B's project) → /dashboard invalid_state", crossUser.location === "/dashboard?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=invalid_state", crossUser.location);
  const bSecond = await logInAgain(b);
  const otherSession = await get(bSecond, callback({ code: `e2e.creator.bravo${tag}`, state: startB4.state }));
  check("the same user in ANOTHER login session → back to Step 4 with invalid_state", otherSession.location === back(b, "instagram_error=INSTAGRAM_OAUTH_FAILED&reason=invalid_state"), otherSession.location);
  if (authSecret.length >= 32) {
    const expired = signState(stateKey(authSecret), await sessionIdOf(b.cookie), { kind: "publish", projectId: b.projectId }, new Date(Date.now() - 11 * 60_000));
    const late = await get(b.cookie, callback({ code: `e2e.creator.bravo${tag}`, state: expired }));
    check("an expired state (11 minutes old) → invalid_state", late.location === back(b, "instagram_error=INSTAGRAM_OAUTH_FAILED&reason=invalid_state"), late.location);
  } else {
    check("an expired state (needs BETTER_AUTH_SECRET in .env)", false, "BETTER_AUTH_SECRET not readable");
  }
  check("none of these saved anything for B", (await connections().countDocuments({ ownerId: b.id })) === 0);
  const noState = await get(b.cookie, "/api/v1/instagram/callback?code=e2e.creator.x");
  check("a callback with no state → JSON 400", noState.status === 400 && noState.text.includes("INVALID_INPUT"), String(noState.status));

  // ---------- two users finishing at the same moment ----------
  const c = await signUp("c");
  const d = await signUp("d");
  const race = `race${tag}`;
  const [sc, sd] = await Promise.all([startConnect(c), startConnect(d)]);
  const [rc, rd] = await Promise.all([get(c.cookie, callback({ code: `e2e.creator.${race}`, state: sc.state })), get(d.cookie, callback({ code: `e2e.creator.${race}`, state: sd.state }))]);
  const outcomes = [rc.location.includes("instagram=connected"), rd.location.includes("instagram=connected")];
  const refused = [rc.location.includes("INSTAGRAM_ACCOUNT_IN_USE"), rd.location.includes("INSTAGRAM_ACCOUNT_IN_USE")];
  const activeRace = await connections().countDocuments({ igUserId: fakeIgUserId(race), status: "active" });
  check("two users finish at once: exactly one connects, the other gets IN_USE, one active document", outcomes.filter(Boolean).length === 1 && refused.filter(Boolean).length === 1 && activeRace === 1, `${rc.location} | ${rd.location} | active ${activeRace}`);

  // ---------- disconnect ----------
  const noOrigin = await send(a.cookie, "DELETE", "/api/v1/instagram/connection", {});
  check("G4 without the app's Origin → 403 (nothing changed)", noOrigin.status === 403 && (await connections().findOne({ ownerId: a.id }))?.status === "active", String(noOrigin.status));
  const off = await send(a.cookie, "DELETE", "/api/v1/instagram/connection");
  const docOff = await connections().findOne({ ownerId: a.id });
  check("G4 → 200 status revoked; database: token removed, revokedAt set", off.status === 200 && off.json.connection?.status === "revoked" && docOff?.status === "revoked" && docOff.accessToken === undefined && docOff.revokedAt instanceof Date, `${off.status} ${JSON.stringify(off.json).slice(0, 100)}`);
  check("audit: instagram.disconnected", (await db.collection("auditLogs").countDocuments({ actorId: a.id, action: "instagram.disconnected" })) === 1);
  const offAgain = await send(a.cookie, "DELETE", "/api/v1/instagram/connection");
  check("G4 again → 404 'No Instagram account is connected.'", offAgain.status === 404 && offAgain.json.error?.message === "No Instagram account is connected.", String(offAgain.status));
  const meOff = await send(a.cookie, "GET", "/api/v1/me");
  const g1Off = await send(a.cookie, "GET", "/api/v1/instagram/connection");
  check("after Disconnect: B1 not_connected, G1 shows the revoked connection", meOff.json.instagram?.status === "not_connected" && meOff.json.instagram.username === null && g1Off.json.connection?.status === "revoked");
  const step4Off = await get(a.cookie, `/projects/${a.projectId}/publish`);
  check("after Disconnect: Step 4 shows Connect your Instagram again", step4Off.text.includes("Connect your Instagram") && !step4Off.text.includes("instagram-username"));

  // ---------- the freed account; reconnect ----------
  const startB5 = await startConnect(b);
  const bTakes = await get(b.cookie, callback({ code: `e2e.creator.${alpha}`, state: startB5.state }));
  check("after A disconnected, B can connect that account", bTakes.location === back(b, "instagram=connected"), bTakes.location);
  const startA2 = await startConnect(a);
  const aBack = await get(a.cookie, callback({ code: `e2e.creator.${alpha}`, state: startA2.state }));
  check("…and now A can't take it back (IN_USE)", aBack.location === back(a, "instagram_error=INSTAGRAM_ACCOUNT_IN_USE"), aBack.location);
  const startA3 = await startConnect(a, "settings");
  const aOther = await get(a.cookie, callback({ code: `e2e.business.other${tag}`, state: startA3.state }));
  const aDocs = await connections().find({ ownerId: a.id }).toArray();
  check(
    "A reconnects another (Business) account (returnTo settings → /dashboard until F33): ONE document per user, same id, active again",
    aOther.location === "/dashboard?instagram=connected" && aDocs.length === 1 && aDocs[0]!._id.equals(docA!._id) && aDocs[0]!.status === "active" && aDocs[0]!.accountType === "BUSINESS" && aDocs[0]!.revokedAt === null,
    `${aOther.location} docs ${aDocs.length}`,
  );

  // ---------- never a token in any answer ----------
  const leaked = seen.some((text) => /e2e-(long|short)\./.test(text));
  check("no answer, page or redirect ever contained a token", !leaked, `${seen.length} answers checked`);

  console.log(`\n${passes} passed, ${failures} failed`);
}

try {
  await main();
} finally {
  await closeMongoClient();
}
if (failures > 0) process.exitCode = 1;
