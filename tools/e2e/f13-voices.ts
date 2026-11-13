import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { addInvite, closeMongoClient, ensureIndexes, getDb, indexesForFeatures, readDbConfig, VOICE_PRESET_LIST } from "@bytereel/db";

/**
 * F13 end-to-end check over real HTTP, against a running `next start` server: B4
 * GET /api/v1/voices, the static samples under /voices/, and the Idea page's ▶ buttons.
 * Also checks that nothing the browser downloads mentions ElevenLabs (▶ only plays a static MP3).
 * SAFETY: works only on the separate test database `bytereel_test` (never the real `bytereel`).
 *
 *   1. in apps/web:  npx next build
 *   2. in apps/web:  MONGODB_DB=bytereel_test BETTER_AUTH_URL=http://localhost:3236 npx next start -p 3236
 *   3. MONGODB_DB=bytereel_test E2E_BASE_URL=http://localhost:3236 npx tsx tools/e2e/f13-voices.ts
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

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

const get = (p: string, cookie = "") => fetch(`${base}${p}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
type VoiceJson = { items?: Record<string, unknown>[]; error?: { code?: string; details?: { issues?: { path: string; message: string }[] } } };

async function main(): Promise<void> {
  await ensureIndexes(db, indexesForFeatures(["F07", "F08", "F12"]));
  await db.collection("rateLimits").deleteMany({});

  let r = await get("/api/v1/voices");
  check("signed out: B4 → 401 UNAUTHENTICATED", r.status === 401 && ((await r.json()) as VoiceJson).error?.code === "UNAUTHENTICATED");

  const email = `f13-e2e-${tag}@example.com`;
  await addInvite(db, email, { note: "F13 e2e test (bytereel_test)" });
  r = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: "F13 Tester", email, password: `E2e-${randomBytes(9).toString("base64url")}` }),
  });
  check("test account created through sign-up", r.status === 200, `status ${r.status}`);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  // --- B4
  r = await get("/api/v1/voices", cookie);
  let body = (await r.json()) as VoiceJson;
  check("B4: 200, no-store, 6 presets in order", r.status === 200 && r.headers.get("cache-control") === "no-store" && JSON.stringify(body.items?.map((i) => i.preset)) === JSON.stringify(VOICE_PRESET_LIST.map((p) => p.preset)));
  check("B4: every item enabled, exact fields, no voice ids", (body.items ?? []).every((i) => i.enabled === true && Object.keys(i).sort().join() === "enabled,gender,label,language,preset,sampleText,sampleUrl") && !/voice_?id|ELEVENLABS/i.test(JSON.stringify(body)));
  r = await get("/api/v1/voices?language=hi", cookie);
  body = (await r.json()) as VoiceJson;
  check("B4 ?language=hi: the 2 Hindi presets with Hindi labels", r.status === 200 && body.items?.length === 2 && body.items[0]!.label === "महिला आवाज़ (Female)" && body.items[1]!.label === "पुरुष आवाज़ (Male)");
  r = await get("/api/v1/voices?language=fr", cookie);
  body = (await r.json()) as VoiceJson;
  check("B4 ?language=fr: 400 INVALID_INPUT on `language`", r.status === 400 && body.error?.code === "INVALID_INPUT" && body.error.details?.issues?.[0]?.path === "language");

  // --- Static samples (only the files that are committed; see F13 for the missing ones).
  const onDisk = new Set(await readdir(path.join("apps", "web", "public", "voices")).catch(() => [] as string[]));
  for (const p of VOICE_PRESET_LIST) {
    const file = `${p.preset}.mp3`;
    if (!onDisk.has(file)) {
      console.log(`SKIP  ${p.sampleUrl} (file not recorded yet)`);
      continue;
    }
    r = await get(p.sampleUrl);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const local = await readFile(path.join("apps", "web", "public", "voices", file));
    check(`${p.sampleUrl}: 200 audio/mpeg, same bytes as the committed file, no login needed`, r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("audio/mpeg") && bytes.length === local.length && bytes.length > 1000);
  }

  // --- Idea page: ▶ buttons, and no ElevenLabs anywhere in what the browser downloads.
  r = await get("/projects/new", cookie);
  const html = (await r.text()).replace(/<!-- -->/g, "");
  check("Idea page: one ▶ per voice with a clear label", html.includes('aria-label="Play female voice sample"') && html.includes('aria-label="Play male voice sample"'));
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
  let mentions = 0;
  for (const src of scripts) {
    const js = await (await get(src)).text();
    if (/elevenlabs|xi-api-key|text-to-speech/i.test(js)) mentions++;
  }
  check("no page script mentions ElevenLabs (▶ only plays the static file)", scripts.length > 0 && mentions === 0, `${scripts.length} scripts`);
  check("the page's scripts reference the /voices/ samples", await (async () => {
    for (const src of scripts) if ((await (await get(src)).text()).includes("/voices/")) return true;
    return false;
  })());
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error("FAIL  unexpected error:", error instanceof Error ? error.message : error);
  })
  .finally(async () => {
    await closeMongoClient();
    console.log(failures === 0 ? "\nAll F13 checks passed." : `\n${failures} check(s) failed.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
