import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { addInvite, APP_USAGE_OWNER_ID, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, readDbConfig, usageCounterPeriod } from "@bytereel/db";
import { isStorageKey, R2ArtifactStore, readR2Config } from "@bytereel/storage";
import { ObjectId } from "mongodb";

/**
 * F25 end-to-end check over real HTTP: make one video with the STAND-IN voice (E2E_FAKE_ELEVENLABS=1:
 * ZERO ElevenLabs calls) → read its caption phrases (F2) → save a caption fix (F4) → the fix-captions
 * job re-renders it for real on this computer and uploads it to the dev R2 bucket under the test
 * user's ids → video 2 is current, video 1 still downloads. It proves: the new captions.json in R2 has
 * the fixed text; ZERO new voice requests (providerUsage, the stand-in's own call log, the voice
 * counters); the narration used is the same recordings (same keys and SHA-256) as video 1; videos/day
 * unchanged; a too-long fix gets 400; another user gets 404. Also: Cancel while rendering, fixes that
 * add up, Try again. The storyboard comes from the local Gemini stand-in (E2E_FAKE_GEMINI=1: ZERO
 * Gemini calls). Three full renders (about 3 min each on the dev machine): allow ~15 minutes.
 *
 * TEMP FILES: never in /tmp. In every terminal used below, first run from the repo root:
 *   mkdir -p runs/.tmp && export TMPDIR="$PWD/runs/.tmp"
 * SAFETY: only the separate test database `bytereel_test`, ports 3230–3239 (never 3000/8288).
 *
 *   1. in apps/web:  npx next build
 *   2. (in runs/f25-work/inngest) npx --yes inngest-cli@1.49.0 dev --no-discovery -u http://localhost:3235/api/inngest --port 8299 \
 *        --connect-gateway-port 8298 --connect-gateway-grpc-port 50062 --connect-executor-grpc-port 50063
 *   3. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3235 E2E_FAKE_GEMINI=1 E2E_FAKE_ELEVENLABS=1 \
 *        INNGEST_DEV=http://localhost:8299 npx next start -p 3235
 *   4. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3235 E2E_FAKE_GEMINI=1 E2E_FAKE_ELEVENLABS=1 npx tsx tools/e2e/f25-captions.ts
 *   5. drop the bytereel_test database afterwards. The R2 files stay (listed at the end).
 *
 * Before ANY request it reads the environment of the server process on the port (Linux /proc) and
 * stops unless it has E2E_FAKE_GEMINI=1, E2E_FAKE_ELEVENLABS=1, MONGODB_DB=bytereel_test and
 * INNGEST_DEV on port 8299. Presigned links are never printed (they contain the token's key id).
 */

const TEST_DB = "bytereel_test";
process.loadEnvFile(".env");
const base = process.env.E2E_BASE_URL ?? "";
if (!/^http:\/\/localhost:323\d$/.test(base)) throw new Error("Set E2E_BASE_URL to http://localhost:3230–3239 (never port 3000).");
if (process.env.E2E_FAKE_GEMINI !== "1" || process.env.E2E_FAKE_ELEVENLABS !== "1") throw new Error("Run with E2E_FAKE_GEMINI=1 and E2E_FAKE_ELEVENLABS=1: this check must never call the real Gemini or ElevenLabs.");
const settings = readDbConfig(process.env);
if (!settings.ok) throw new Error(settings.problems.join(" "));
if (settings.config.dbName !== TEST_DB) throw new Error(`Refusing to run: MONGODB_DB must be ${TEST_DB}.`);
const db = getDb(settings.config);
const r2 = readR2Config(process.env);
if (!r2.ok) throw new Error(r2.problems.join(" "));
const files = R2ArtifactStore.fromConfig(r2.config);

function serverSettings(port: string) {
  const listing = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" });
  const pid = /pid=(\d+)/.exec(listing)?.[1];
  if (!pid) throw new Error(`No server process found on port ${port}.`);
  const env = new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  return env.get("E2E_FAKE_GEMINI") === "1" && env.get("E2E_FAKE_ELEVENLABS") === "1" && env.get("MONGODB_DB") === TEST_DB && env.get("INNGEST_DEV") === "http://localhost:8299";
}
if (!serverSettings(new URL(base).port)) throw new Error("Stopping before any request: the server must run with E2E_FAKE_GEMINI=1, E2E_FAKE_ELEVENLABS=1, MONGODB_DB=bytereel_test and INNGEST_DEV=http://localhost:8299.");

const ROOT = process.cwd();
/** One line per stand-in voice call, written by the test server (apps/web/lib/video/fake-elevenlabs.ts). */
const STAND_IN_LOG = path.join(ROOT, "runs", ".tmp", "e2e", "elevenlabs-stand-in-calls.log");
const standInCalls = () => (existsSync(STAND_IN_LOG) ? readFileSync(STAND_IN_LOG, "utf8").split("\n").filter(Boolean).length : 0);
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
const key = () => randomBytes(16).toString("hex");
const send = async (cookie: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${url}`, {
    method,
    redirect: "manual",
    headers: { origin: base, cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, headers: r.headers, json: (await r.json().catch(() => ({}))) as Json };
};
const page = async (cookie: string, url: string) => {
  const r = await fetch(`${base}${url}`, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, html: (await r.text()).replace(/<!-- -->/g, "") };
};
const oid = (id: string) => new ObjectId(id);
const projectOf = (id: string) => db.collection("projects").findOne({ _id: oid(id) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll C6 until `done` says so (or the time is up); collects every progress message seen. */
async function waitFor(cookie: string, projectId: string, done: (s: Json) => boolean, timeoutMs: number, seen?: Set<string>): Promise<Json> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await send(cookie, "GET", `/api/v1/projects/${projectId}/status`);
    const message = r.json.activeJob?.progress?.message;
    if (seen && typeof message === "string") seen.add(message);
    if (done(r.json) || Date.now() > end) return r.json;
    await sleep(700);
  }
}

async function signUp(label: string): Promise<{ cookie: string; id: ObjectId }> {
  const email = `f25-e2e-${label}-${tag}@example.com`;
  await addInvite(db, email, { note: "F25 e2e test (bytereel_test)" });
  const r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: `F25 Tester ${label}`, email, password: `E2e-${randomBytes(9).toString("base64url")}` }),
  });
  check(`test account ${label} created`, r.status === 200, `status ${r.status}`);
  const user = await db.collection("user").findOne({ email });
  return { cookie: cookieOf(r), id: user!._id as ObjectId };
}

async function counter(ownerId: ObjectId | string, kind: string, timezone: string): Promise<number> {
  const { period } = usageCounterPeriod(kind as "videos", timezone);
  const doc = await db.collection("usageCounters").findOne({ ownerId: typeof ownerId === "string" ? oid(ownerId) : ownerId, kind, period });
  return (doc?.count as number | undefined) ?? 0;
}

const uploaded: string[] = [];
async function verifyInR2(label: string, keys: string[], shaOf: Record<string, string> = {}) {
  let ok = true;
  for (const k of keys) {
    if (!isStorageKey(k)) {
      ok = false;
      continue;
    }
    const head = await files.head(k);
    if (!head || head.bytes === 0 || (shaOf[k] && head.sha256 !== shaOf[k])) ok = false;
    else if (!uploaded.includes(k)) uploaded.push(k);
  }
  check(label, ok, `${keys.length} file(s)`);
}
const readJson = async (k: string) => JSON.parse(Buffer.from((await files.get(k as never))!).toString("utf8")) as Json;

/** Everything that would move if a voice request were made (or counted). */
async function voiceSnapshot(owner: ObjectId, tz: string) {
  return {
    providerUsage: await db.collection("providerUsage").countDocuments({ provider: "elevenlabs" }),
    standIn: standInCalls(),
    userChars: await counter(owner, "voiceChars", tz),
    appChars: await counter(APP_USAGE_OWNER_ID, "appVoiceChars", "UTC"),
    speechArtifacts: await db.collection("speechArtifacts").countDocuments({}),
    videosToday: await counter(owner, "videos", tz),
  };
}

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F14", "F15", "F18", "F20", "F21", "F23"]));
  await db.collection("rateLimits").deleteMany({});
  const a = await signUp("a");
  const b = await signUp("b");
  const tz = "Asia/Kolkata";

  // ---------- 1. one video with the stand-in voice ----------
  const created = await send(a.cookie, "POST", "/api/v1/projects", { inputType: "topic", text: "Why is the sky blue?", language: "en", voiceGender: "female" }, { "idempotency-key": key() });
  const pid = created.json.project?.id as string;
  let st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null && s.state !== "planning", 90_000);
  check("storyboard made (stand-in Gemini)", st.state === "storyboard_ready", st.state);
  const standInBefore = standInCalls();
  const [p0, v0] = await Promise.all([send(a.cookie, "GET", `/api/v1/projects/${pid}`), send(a.cookie, "GET", `/api/v1/projects/${pid}/plan-versions/current`)]);
  let r = await send(a.cookie, "POST", `/api/v1/projects/${pid}/storyboard-approval`, { planVersionId: v0.json.id, planHash: v0.json.planHash, expectedStateVersion: p0.json.stateVersion }, { "idempotency-key": key() });
  check("Approve & generate video → 202", r.status === 202, `status ${r.status}`);
  let started = Date.now();
  st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null, 12 * 60_000);
  console.log(`      (video 1 took ${((Date.now() - started) / 1000).toFixed(0)} s)`);
  check("video 1 ready", st.state === "video_ready" && typeof st.currentRenderId === "string", `${st.state} ${JSON.stringify(st.lastError)}`);
  check("the stand-in's call log counts its calls (one per scene for video 1)", standInCalls() - standInBefore === v0.json.plan.scenes.length, `${standInCalls() - standInBefore} calls`);
  const render1Id = st.currentRenderId as string;
  const render1 = await db.collection("renders").findOne({ _id: oid(render1Id) });
  check("C3: edit_captions offered on the ready video", ((await send(a.cookie, "GET", `/api/v1/projects/${pid}`)).json.allowedActions ?? []).includes("edit_captions"));

  // ---------- 2. the counters before any caption fix ----------
  const before = await voiceSnapshot(a.id, tz);
  check("baseline: voice requests were logged for video 1 (so 'unchanged' below means something)", before.providerUsage > 0 && before.userChars > 0 && before.videosToday === 1, JSON.stringify(before));

  // ---------- 3. F2: the caption phrases ----------
  r = await send(a.cookie, "GET", `/api/v1/projects/${pid}/renders/current`);
  const phrases = (r.json.captions ?? []) as Json[];
  check("F2 current → 200 RenderSummary + captions[]", r.status === 200 && r.json.id === render1Id && r.json.renderNumber === 1 && phrases.length > 5, `${r.status}, ${phrases.length} phrases`);
  const perScene = new Map<string, number[]>();
  for (const c of phrases) perScene.set(c.sceneId, [...(perScene.get(c.sceneId) ?? []), c.phraseIndex]);
  check("F2 phrases: phraseIndex per scene from 0, text = originalText, not overridden, times in ms", [...perScene.values()].every((ix) => ix.every((n, i) => n === i)) && phrases.every((c) => c.text === c.originalText && c.overridden === false && c.endMs > c.startMs));
  const byId = await send(a.cookie, "GET", `/api/v1/projects/${pid}/renders/${render1Id}`);
  check("F2 by id = F2 current", byId.status === 200 && JSON.stringify(byId.json.captions) === JSON.stringify(phrases));
  for (const [label, url] of [["F2 another user", `/api/v1/projects/${pid}/renders/current`], ["F2 missing render", `/api/v1/projects/${pid}/renders/${new ObjectId().toHexString()}`]] as const) {
    const res = await send(label.includes("another") ? b.cookie : a.cookie, "GET", url);
    check(`${label} → 404`, res.status === 404, `status ${res.status}`);
  }

  // ---------- 4. refused fixes ----------
  const target = phrases.find((c) => c.phraseIndex === 1) ?? phrases[1]!;
  const second = phrases.find((c) => c.sceneId !== target.sceneId && c.phraseIndex === 0)!;
  const FIX = `Sky fix ${tag.slice(0, 4)}.`;
  const FIX2 = "Blue light scatters.";
  const stateVersion = (await projectOf(pid))!.stateVersion as number;
  const fixUrl = `/api/v1/projects/${pid}/renders/current/caption-overrides`;
  r = await send(a.cookie, "POST", fixUrl, { edits: [{ sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: "This caption is far too long to ever fit on the two short lines of a Reel" }], expectedStateVersion: stateVersion }, { "idempotency-key": key() });
  check("F4 too long to fit → 400 'This caption is too long to fit on screen. Please shorten it.' with the path", r.status === 400 && r.json.error?.message === "This caption is too long to fit on screen. Please shorten it." && r.json.error?.details?.issues?.[0]?.path === "edits[0].text", `${r.status} ${r.json.error?.message}`);
  r = await send(a.cookie, "POST", fixUrl, { edits: [{ sceneId: target.sceneId, phraseIndex: 999, text: "Hi" }], expectedStateVersion: stateVersion }, { "idempotency-key": key() });
  check("F4 unknown phrase → 400 (edits[0].phraseIndex)", r.status === 400 && r.json.error?.details?.issues?.[0]?.path === "edits[0].phraseIndex", `${r.status}`);
  r = await send(a.cookie, "POST", fixUrl, { edits: [{ sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: FIX }, { sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: "again" }], expectedStateVersion: stateVersion }, { "idempotency-key": key() });
  check("F4 duplicate pair → 400", r.status === 400, `${r.status}`);
  r = await send(a.cookie, "POST", fixUrl, { edits: [{ sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: FIX }], expectedStateVersion: stateVersion });
  check("F4 without Idempotency-Key → 400", r.status === 400, `${r.status}`);
  r = await send(a.cookie, "POST", fixUrl, { edits: [{ sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: FIX }], expectedStateVersion: stateVersion - 1 }, { "idempotency-key": key() });
  check("F4 from an older tab → 409 STALE_VERSION", r.status === 409 && r.json.error?.code === "STALE_VERSION", `${r.status} ${r.json.error?.code}`);
  r = await send(b.cookie, "POST", fixUrl, { edits: [{ sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: FIX }], expectedStateVersion: stateVersion }, { "idempotency-key": key() });
  check("F4 another user → 404", r.status === 404, `${r.status}`);
  check("refused fixes saved nothing (no set, no caption job)", (await db.collection("captionOverrides").countDocuments({})) === 0 && (await db.collection("jobs").countDocuments({ type: "caption" })) === 0);

  // ---------- 5. save a caption fix ----------
  const fixKey = key();
  const fixBody = { edits: [{ sceneId: target.sceneId, phraseIndex: target.phraseIndex, text: FIX }], expectedStateVersion: stateVersion };
  r = await send(a.cookie, "POST", fixUrl, fixBody, { "idempotency-key": fixKey });
  const job1 = r.json.job?.id as string;
  check("F4 → 202 { captionOverrideSetId, job (caption, queued, cap:{set}), project (generating, cancel_job) }", r.status === 202 && r.json.job?.type === "caption" && r.json.job?.state === "queued" && r.json.project?.state === "generating" && r.json.project?.allowedActions?.join() === "cancel_job" && typeof r.json.captionOverrideSetId === "string", `${r.status} ${JSON.stringify(r.json.error ?? null)}`);
  const jobDoc = await db.collection("jobs").findOne({ _id: oid(job1) });
  check("the job key is cap:{captionOverrideSetId}; inputRef = video 1 + the set", jobDoc?.idempotencyKey === `cap:${r.json.captionOverrideSetId}` && jobDoc.inputRef.renderId?.toHexString() === render1Id);
  const replay = await send(a.cookie, "POST", fixUrl, fixBody, { "idempotency-key": fixKey });
  check("F4 repeated with the same key → replayed, one caption job", replay.headers.get("idempotent-replayed") === "true" && (await db.collection("jobs").countDocuments({ type: "caption" })) === 1);
  r = await send(a.cookie, "POST", fixUrl, { edits: [{ sceneId: second.sceneId, phraseIndex: 0, text: FIX2 }], expectedStateVersion: stateVersion + 1 }, { "idempotency-key": key() });
  check("F4 while the fix renders → 409 JOB_ALREADY_RUNNING", r.status === 409 && r.json.error?.code === "JOB_ALREADY_RUNNING", `${r.status} ${r.json.error?.code}`);
  const seen = new Set<string>();
  started = Date.now();
  st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null, 12 * 60_000, seen);
  console.log(`      (caption fix took ${((Date.now() - started) / 1000).toFixed(0)} s; progress seen: ${[...seen].filter((m) => !/Rendering · \d/.test(m) || /0%$/.test(m)).join(" | ")})`);
  check("caption fix ready: video_ready with a NEW current video", st.state === "video_ready" && st.currentRenderId !== render1Id, `${st.state}`);
  check("progress: Updating captions… → Rendering · N%", seen.has("Updating captions…") && [...seen].some((m) => /^Rendering · \d+%$/.test(m)) && ![...seen].some((m) => /Recording narration/.test(m)));

  // ---------- 6. the checks ----------
  const render2 = await db.collection("renders").findOne({ _id: oid(st.currentRenderId) });
  check("video 2: ready, renderNumber 2, captionOverrideSetId set, same storyboard version", render2?.status === "ready" && render2.renderNumber === 2 && render2.captionOverrideSetId?.toHexString() === jobDoc?.inputRef.captionOverrideSetId?.toHexString() && render2.planVersionId.equals(render1!.planVersionId));
  const done1 = await db.collection("jobs").findOne({ _id: oid(job1) });
  check("caption job succeeded, every stage succeeded, result.renderId", done1?.state === "succeeded" && done1.stages.every((s: Json) => s.status === "succeeded") && done1.result?.renderId?.toHexString() === st.currentRenderId);
  await verifyInR2("R2: video 2's output.mp4 (SHA-256 = renders.mp4Sha256), thumbnail, timeline, captions, qa", [render2!.mp4Key, render2!.thumbnailKey, render2!.timelineKey, render2!.captionsKey, render2!.qaKey], { [render2!.mp4Key]: render2!.mp4Sha256 });
  const captions2 = await readJson(render2!.captionsKey);
  const fixedCaption = captions2.captions.filter((c: Json) => c.sceneId === target.sceneId)[target.phraseIndex];
  check("the NEW captions.json in R2 has the fixed text (and the narration's text as originalText)", fixedCaption?.text === FIX && fixedCaption.originalText === target.text && fixedCaption.lines.join(" ") === FIX, JSON.stringify(fixedCaption?.lines));
  const captions1 = await readJson(render1!.captionsKey);
  const original = captions1.captions.find((c: Json) => c.id === fixedCaption?.id);
  check("…same phrase start and end frame as in video 1", original && fixedCaption.startFrame === original.startFrame && fixedCaption.endFrame === original.endFrame);
  check("…every other phrase is exactly as in video 1", JSON.stringify(captions2.captions.filter((c: Json) => c.id !== fixedCaption.id)) === JSON.stringify(captions1.captions.filter((c: Json) => c.id !== fixedCaption.id)));
  check("timeline.json is identical to video 1's (the narration timing is unchanged)", JSON.stringify(await readJson(render2!.timelineKey)) === JSON.stringify(await readJson(render1!.timelineKey)));
  const after = await voiceSnapshot(a.id, tz);
  check("ZERO new voice requests: providerUsage and the stand-in's call log unchanged", after.providerUsage === before.providerUsage && after.standIn === before.standIn, `${before.standIn} → ${after.standIn}`);
  check("voice counters unchanged (creator and app), no new recordings", after.userChars === before.userChars && after.appChars === before.appChars && after.speechArtifacts === before.speechArtifacts, JSON.stringify(after));
  check("videos/day unchanged", after.videosToday === before.videosToday, `${after.videosToday}`);
  const speech1 = await db.collection("speechArtifacts").find({ _id: { $in: render1!.speech.map((s: Json) => s.speechArtifactId) } }).toArray();
  const speech2 = await db.collection("speechArtifacts").find({ _id: { $in: render2!.speech.map((s: Json) => s.speechArtifactId) } }).toArray();
  const sig = (docs: Json[]) => docs.map((d) => `${d.sceneId}|${d.audioKey}|${d.audioSha256}`).sort().join(",");
  check("the narration used is the same recordings (audio keys and SHA-256) as video 1", speech2.length === render1!.speech.length && sig(speech1) === sig(speech2) && JSON.stringify(render1!.speech) === JSON.stringify(render2!.speech));
  const versions = await send(a.cookie, "GET", `/api/v1/projects/${pid}/renders`);
  check("F1: two versions, video 2 current, video 1 kept", versions.json.items?.length === 2 && versions.json.items[0].renderNumber === 2 && versions.json.items[0].isCurrent === true && versions.json.items[1].isCurrent === false);
  r = await send(a.cookie, "GET", `/api/v1/projects/${pid}/renders/${render1Id}/media?kind=download`);
  const v1file = r.status === 200 ? await fetch(r.json.url, { headers: { Range: "bytes=0-15" } }) : null;
  check("video 1 is still downloadable (F3 download link opens the MP4)", r.status === 200 && (v1file?.status === 206 || v1file?.status === 200) && /attachment/.test(v1file?.headers.get("content-disposition") ?? ""), `${r.status} ${v1file?.status}`);
  const f2 = await send(a.cookie, "GET", `/api/v1/projects/${pid}/renders/current`);
  const shown = (f2.json.captions as Json[]).find((c) => c.sceneId === target.sceneId && c.phraseIndex === target.phraseIndex);
  check("F2 on video 2 shows the fix as overridden", shown?.text === FIX && shown.originalText === target.text && shown.overridden === true);
  check("the job's work folder was removed", !existsSync(path.join(ROOT, "runs", ".tmp", "generate", st.currentRenderId)));
  const view = await page(a.cookie, `/projects/${pid}/video`);
  check("video page: the Captions tab with the narration note and the Edit storyboard link", view.status === 200 && view.html.includes("Captions") && view.html.includes("The narration audio stays the same.") && view.html.includes("Change the spoken words instead"));

  // ---------- 7. a second fix: Cancel while rendering, then Try again; the fixes add up ----------
  const sv2 = (await projectOf(pid))!.stateVersion as number;
  r = await send(a.cookie, "POST", fixUrl, { edits: [{ sceneId: second.sceneId, phraseIndex: 0, text: FIX2 }], expectedStateVersion: sv2 }, { "idempotency-key": key() });
  const job2 = r.json.job?.id as string;
  check("second fix → 202 (on video 2)", r.status === 202, `${r.status} ${JSON.stringify(r.json.error ?? null)}`);
  const set2 = await db.collection("captionOverrides").findOne({ _id: oid(r.json.captionOverrideSetId) });
  check("the fixes add up: the new set has BOTH fixes (the first one kept)", set2?.overrides?.length === 2 && set2.overrides.some((o: Json) => o.text === FIX) && set2.overrides.some((o: Json) => o.text === FIX2));
  st = await waitFor(a.cookie, pid, (s) => s.activeJob?.progress?.stage === "render" || s.pollAfterMs === null, 6 * 60_000);
  r = await send(a.cookie, "POST", `/api/v1/jobs/${job2}/cancel`, {});
  check("E3 Cancel while the fix renders → 202, cancel requested", r.status === 202 && r.json.cancelRequestedAt !== null, `${r.status}`);
  const cancelledAt = Date.now();
  st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null, 90_000);
  check("…cancelled within seconds; back to video_ready with video 2 still current", (await db.collection("jobs").findOne({ _id: oid(job2) }))?.state === "cancelled" && st.state === "video_ready" && st.currentRenderId === render2!._id.toHexString(), `${((Date.now() - cancelledAt) / 1000).toFixed(1)} s`);
  check("…Try again offered (retry_job)", (st.allowedActions ?? []).includes("retry_job"));
  r = await send(a.cookie, "POST", `/api/v1/jobs/${job2}/retry`, {}, { "idempotency-key": key() });
  check("E2 Try again → 202, same caption job, attempt 2", r.status === 202 && r.json.id === job2 && r.json.attempt === 2, `${r.status} ${JSON.stringify(r.json.error ?? null)}`);
  st = await waitFor(a.cookie, pid, (s) => s.pollAfterMs === null, 12 * 60_000);
  const render3 = await db.collection("renders").findOne({ _id: oid(st.currentRenderId) });
  const captions3 = render3 ? await readJson(render3.captionsKey) : { captions: [] };
  check("video 3 ready with BOTH fixes in its captions.json", render3?.renderNumber === 3 && captions3.captions.some((c: Json) => c.text === FIX) && captions3.captions.some((c: Json) => c.text === FIX2));
  if (render3) await verifyInR2("R2: video 3's files", [render3.mp4Key, render3.thumbnailKey, render3.timelineKey, render3.captionsKey, render3.qaKey], { [render3.mp4Key]: render3.mp4Sha256 });
  const end = await voiceSnapshot(a.id, tz);
  check("still ZERO voice requests and no counter changed after three caption renders", end.providerUsage === before.providerUsage && end.standIn === before.standIn && end.userChars === before.userChars && end.appChars === before.appChars && end.videosToday === before.videosToday, JSON.stringify(end));

  // ---------- 8. owner only ----------
  for (const [label, res] of [
    ["E1 on the caption job", await send(b.cookie, "GET", `/api/v1/jobs/${job1}`)],
    ["E2 on the caption job", await send(b.cookie, "POST", `/api/v1/jobs/${job2}/retry`, {}, { "idempotency-key": key() })],
    ["E3 on the caption job", await send(b.cookie, "POST", `/api/v1/jobs/${job1}/cancel`, {})],
    ["F2 on video 2", await send(b.cookie, "GET", `/api/v1/projects/${pid}/renders/${render2!._id.toHexString()}`)],
  ] as const) check(`another user: ${label} → 404`, res.status === 404, `status ${res.status}`);
  check("signed out: F2 → 401", (await send("", "GET", `/api/v1/projects/${pid}/renders/current`)).status === 401);

  const leftovers = existsSync(path.join(ROOT, "runs", ".tmp", "generate")) ? readdirSync(path.join(ROOT, "runs", ".tmp", "generate")) : [];
  check("no render work folders left in runs/.tmp/generate", leftovers.length === 0, leftovers.join(", "));

  // The R2 files of this check (dev bucket, test user ids; kept).
  for (const s of speech1) uploaded.push(s.audioKey, s.alignmentKey, s.normalizedAlignmentKey);
  if (render1) uploaded.push(render1.mp4Key, render1.thumbnailKey, render1.timelineKey, render1.captionsKey, render1.qaKey);
  console.log("\nR2 files uploaded by this check (dev bucket, test user ids; kept):");
  for (const k of [...new Set(uploaded)]) console.log(`  ${k}`);
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error("E2E crashed:", error instanceof Error ? error.stack : error);
  })
  .finally(async () => {
    await closeMongoClient();
    console.log(failures === 0 ? `\nAll F25 checks passed (${passes}).` : `\n${failures} check(s) failed, ${passes} passed.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
