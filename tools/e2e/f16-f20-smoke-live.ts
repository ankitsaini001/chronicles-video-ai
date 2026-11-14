import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { addInvite, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, readDbConfig } from "@bytereel/db";
import { ObjectId } from "mongodb";

/**
 * F16–F20 LIVE smoke run with the REAL Gemini (free tier; no money):
 *   1. one Hindi storyboard: the plan validates, the narration is Devanagari, and the storyboard
 *      page marks it lang="hi";
 *   2. one English storyboard, then one real revision request "make it shorter" (D5 → revise-plan).
 * Prints times, scene/word counts and the tokens of every Gemini request. At most one Try again per
 * job when Gemini is busy. About 3–8 Gemini requests in total.
 * SAFETY: only on `bytereel_test`, port 3230–3239, against a server WITHOUT the stand-in
 * (E2E_FAKE_GEMINI unset) whose Inngest Dev Server is on port 8299. Setup: see f15-smoke-live.ts.
 *   MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3237 npx tsx tools/e2e/f16-f20-smoke-live.ts
 */

const TEST_DB = "bytereel_test";
process.loadEnvFile(".env");
const base = process.env.E2E_BASE_URL ?? "";
if (!/^http:\/\/localhost:323\d$/.test(base)) throw new Error("Set E2E_BASE_URL to http://localhost:3230–3239 (never port 3000).");
const settings = readDbConfig(process.env);
if (!settings.ok) throw new Error(settings.problems.join(" "));
if (settings.config.dbName !== TEST_DB) throw new Error(`Refusing to run: MONGODB_DB must be ${TEST_DB}.`);
const listing = execFileSync("ss", ["-ltnpH", `sport = :${new URL(base).port}`], { encoding: "utf8" });
const pid = /pid=(\d+)/.exec(listing)?.[1];
if (!pid) throw new Error("No server on that port.");
const env = new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const));
if (env.get("MONGODB_DB") !== TEST_DB || env.get("INNGEST_DEV") !== "http://localhost:8299" || env.get("E2E_FAKE_GEMINI")) {
  throw new Error("Stopping: the server must use bytereel_test, INNGEST_DEV=http://localhost:8299 and no E2E_FAKE_GEMINI.");
}
const db = getDb(settings.config);

type Json = Record<string, any>;
async function call(cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const r = await fetch(`${base}${path}`, { method, headers: { origin: base, cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Json };
}
const key = () => randomBytes(16).toString("hex");

async function wait(cookie: string, projectId: string): Promise<Json> {
  const end = Date.now() + 15 * 60_000;
  let last = "";
  for (;;) {
    const r = await call(cookie, "GET", `/api/v1/projects/${projectId}/status`);
    const message = r.json.activeJob?.progress?.message ?? "";
    if (message && message !== last) console.log(`  … ${message}`);
    last = message;
    if ((r.json.state !== "planning" && r.json.pollAfterMs === null) || Date.now() > end) return r.json;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function report(jobId: string): Promise<void> {
  const rows = await db.collection("providerUsage").find({ jobId: new ObjectId(jobId) }).sort({ at: 1 }).toArray();
  for (const row of rows) console.log(`  Gemini ${row.operation}: ${row.model}, ${row.status}/${row.outcome}, ${(row.latencyMs / 1000).toFixed(1)} s, prompt ${row.units.promptTokens} tokens, output+thinking ${row.units.outputTokens} tokens`);
}

async function storyboard(cookie: string, text: string, language: string): Promise<{ projectId: string; seconds: string } | null> {
  const started = Date.now();
  const created = await call(cookie, "POST", "/api/v1/projects", { inputType: "topic", text, language, voiceGender: "female" }, { "idempotency-key": key() });
  if (created.status !== 202) throw new Error(`C2 answered ${created.status}: ${JSON.stringify(created.json.error)}`);
  const projectId = created.json.project.id as string;
  const jobId = created.json.job.id as string;
  let status = await wait(cookie, projectId);
  if (status.state === "plan_failed" && status.lastError?.code === "PROVIDER_BUSY") {
    console.log("  Gemini was busy: Try again once.");
    await call(cookie, "POST", `/api/v1/jobs/${jobId}/retry`, {}, { "idempotency-key": key() });
    status = await wait(cookie, projectId);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  Result: ${status.state}${status.lastError ? ` (${status.lastError.code})` : ""} after ${seconds} s`);
  await report(jobId);
  return status.state === "storyboard_ready" ? { projectId, seconds } : null;
}

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F14", "F15", "F18", "F20"]));
  const email = `f16-smoke-${randomBytes(4).toString("hex")}@example.com`;
  await addInvite(db, email, { note: "F16-F20 live smoke (bytereel_test)" });
  const signup = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ name: "F16 Smoke", email, password: `E2e-${randomBytes(9).toString("base64url")}` }) });
  const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  console.log("1. Hindi storyboard: इंद्रधनुष कैसे बनता है?");
  const hi = await storyboard(cookie, "इंद्रधनुष कैसे बनता है?", "hi");
  if (hi) {
    const v = (await call(cookie, "GET", `/api/v1/projects/${hi.projectId}/plan-versions/current`)).json;
    const narration = (v.plan.scenes as Json[]).flatMap((s) => (s.narration as Json[]).map((n) => n.text as string)).join(" ");
    const dev = narration.match(/\p{Script=Devanagari}/gu)?.length ?? 0;
    const lat = narration.match(/\p{Script=Latin}/gu)?.length ?? 0;
    const html = await (await fetch(`${base}/projects/${hi.projectId}/storyboard`, { headers: { cookie } })).text();
    console.log(`  valid ${v.validation.valid}; ${v.stats.sceneCount} scenes, ${v.stats.wordCount} words, about ${v.stats.estimatedSeconds} s; voice ${v.plan.voicePreset}`);
    console.log(`  narration letters: Devanagari ${dev}, Latin ${lat}; page has lang="hi": ${html.includes('lang="hi"')}; page has the first line: ${html.includes(String(v.plan.scenes[0].narration[0].text).slice(0, 12))}`);
    for (const [i, scene] of (v.plan.scenes as Json[]).entries()) console.log(`    ${i + 1}. ${scene.type}: ${(scene.narration as Json[]).map((n) => n.text).join(" ")}`);
  }

  console.log("\n2. English storyboard, then a real revision: \"make it shorter\"");
  const en = await storyboard(cookie, "How do vaccines train the immune system?", "en");
  if (!en) return;
  let p = (await call(cookie, "GET", `/api/v1/projects/${en.projectId}`)).json;
  let v = (await call(cookie, "GET", `/api/v1/projects/${en.projectId}/plan-versions/current`)).json;
  console.log(`  Before: ${v.stats.sceneCount} scenes, ${v.stats.wordCount} words, about ${v.stats.estimatedSeconds} s`);
  const started = Date.now();
  const r = await call(cookie, "POST", `/api/v1/projects/${en.projectId}/revisions`, { stage: "storyboard", scope: "project", message: "make it shorter", basePlanVersionId: v.id, expectedStateVersion: p.stateVersion }, { "idempotency-key": key() });
  if (r.status !== 202) throw new Error(`D5 answered ${r.status}: ${JSON.stringify(r.json.error)}`);
  const jobId = r.json.job.id as string;
  await wait(cookie, en.projectId);
  let job = (await call(cookie, "GET", `/api/v1/jobs/${jobId}`)).json;
  if (job.state === "failed" && job.error?.code === "PROVIDER_BUSY") {
    console.log("  Gemini was busy: Try again once.");
    await call(cookie, "POST", `/api/v1/jobs/${jobId}/retry`, {}, { "idempotency-key": key() });
    await wait(cookie, en.projectId);
    job = (await call(cookie, "GET", `/api/v1/jobs/${jobId}`)).json;
  }
  const revision = await db.collection("revisions").findOne({ jobId: new ObjectId(jobId) });
  p = (await call(cookie, "GET", `/api/v1/projects/${en.projectId}`)).json;
  v = (await call(cookie, "GET", `/api/v1/projects/${en.projectId}/plan-versions/current`)).json;
  console.log(`  Revision: job ${job.state}, revision ${revision?.status} after ${((Date.now() - started) / 1000).toFixed(1)} s; reply: ${revision?.assistantReply}`);
  console.log(`  After: version ${v.versionNumber} (${v.source}), valid ${v.validation.valid}, ${v.stats.sceneCount} scenes, ${v.stats.wordCount} words, about ${v.stats.estimatedSeconds} s; Changed: ${v.changedSceneIds.join(", ")}; planRequestCount ${(await db.collection("projects").findOne({ _id: new ObjectId(en.projectId) }))?.planRequestCount}`);
  await report(jobId);
}

main()
  .catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Smoke run failed:", error instanceof Error ? error.message : error);
  })
  .finally(() => closeMongoClient());
