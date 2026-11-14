import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { addInvite, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, readDbConfig } from "@bytereel/db";
import { ObjectId } from "mongodb";

/**
 * F15 LIVE smoke run: ONE real storyboard through the whole flow (C2 → Inngest plan-video → real
 * Gemini → plan version 1), then prints scenes, words, estimated length, time and tokens.
 * Costs one planner job on Gemini (free tier: no money; at most 4 requests). If Gemini is busy, it
 * presses Try again (E2) at most once.
 * SAFETY: only on the test database `bytereel_test`, port 3230–3239, and only against a server
 * WITHOUT the stand-in (E2E_FAKE_GEMINI unset) whose Inngest Dev Server is on port 8299.
 *
 *   1. in apps/web: npx next build
 *   2. npx --yes inngest-cli@1.49.0 dev --no-discovery -u http://localhost:3237/api/inngest --port 8299 \
 *        --connect-gateway-port 8298 --connect-gateway-grpc-port 50062 --connect-executor-grpc-port 50063
 *   3. in apps/web: MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3237 INNGEST_DEV=http://localhost:8299 npx next start -p 3237
 *   4. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3237 npx tsx tools/e2e/f15-smoke-live.ts
 *   5. drop the bytereel_test database afterwards
 */

const TEST_DB = "bytereel_test";
const TOPIC = "Why is the sky blue?";
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

async function wait(cookie: string, projectId: string): Promise<Json> {
  const end = Date.now() + 15 * 60_000;
  let last = "";
  for (;;) {
    const r = await call(cookie, "GET", `/api/v1/projects/${projectId}/status`);
    const message = r.json.activeJob?.progress?.message ?? "";
    if (message && message !== last) console.log(`  … ${message}`);
    last = message;
    if (r.json.state !== "planning" || Date.now() > end) return r.json;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12", "F14", "F15"]));
  const email = `f15-smoke-${randomBytes(4).toString("hex")}@example.com`;
  await addInvite(db, email, { note: "F15 live smoke (bytereel_test)" });
  const signup = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ name: "F15 Smoke", email, password: `E2e-${randomBytes(9).toString("base64url")}` }) });
  const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const started = Date.now();
  const created = await call(cookie, "POST", "/api/v1/projects", { inputType: "topic", text: TOPIC, language: "en", voiceGender: "female" }, { "idempotency-key": randomBytes(16).toString("hex") });
  if (created.status !== 202) throw new Error(`C2 answered ${created.status}: ${JSON.stringify(created.json.error)}`);
  const projectId = created.json.project.id as string;
  const jobId = created.json.job.id as string;
  console.log(`C2 202: project ${projectId}, job ${jobId}`);
  let status = await wait(cookie, projectId);
  if (status.state === "plan_failed" && status.lastError?.code === "PROVIDER_BUSY") {
    console.log("Gemini was busy: pressing Try again once.");
    const r = await call(cookie, "POST", `/api/v1/jobs/${jobId}/retry`, {}, { "idempotency-key": randomBytes(16).toString("hex") });
    console.log(`E2 ${r.status}`);
    status = await wait(cookie, projectId);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const job = await db.collection("jobs").findOne({ _id: new ObjectId(jobId) });
  const rows = await db.collection("providerUsage").find({ jobId: new ObjectId(jobId) }).sort({ at: 1 }).toArray();
  console.log(`\nResult: ${status.state}${status.lastError ? ` (${status.lastError.code})` : ""} after ${seconds} s (click to result), attempts ${job?.attempt}`);
  for (const row of rows) console.log(`  Gemini request: ${row.model}, ${row.status}/${row.outcome}, ${(row.latencyMs / 1000).toFixed(1)} s, prompt ${row.units.promptTokens} tokens, output+thinking ${row.units.outputTokens} tokens`);
  const version = await db.collection("planVersions").findOne({ projectId: new ObjectId(projectId) });
  if (version) {
    console.log(`Plan version ${version.versionNumber}: "${version.plan.topic}", ${version.stats.sceneCount} scenes, ${version.stats.wordCount} words, about ${version.stats.estimatedSeconds} s; model ${version.plannerUsage.model}; tokens prompt ${version.plannerUsage.promptTokens}, output ${version.plannerUsage.outputTokens}, thinking ${version.plannerUsage.thinkingTokens}; ${version.plannerUsage.attempts} request(s); ${version.validation.warnings.length} review warning(s), ${version.plan.warnings.length} plan warning(s)`);
    for (const [i, scene] of (version.plan.scenes as Json[]).entries()) console.log(`  ${i + 1}. ${scene.type}: ${(scene.narration as Json[]).map((n) => n.text).join(" ")}`);
  }
}

main()
  .catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Smoke run failed:", error instanceof Error ? error.message : error);
  })
  .finally(() => closeMongoClient());
