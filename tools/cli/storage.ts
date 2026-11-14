import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { loadLocalEnvFile } from "@bytereel/pipeline/config/config";
import { CONTENT_TYPES, r2Endpoint, R2ArtifactStore, readR2Config, redactR2, type R2Config } from "@bytereel/storage";
import { healthcheckKey } from "@bytereel/storage/healthcheck";

/**
 * File storage commands (F22). Reads R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
 * from .env in the project root. Never prints those values.
 *   npm run storage -- check    upload a test file to healthcheck/, read it back, test private links (≈ 80 s)
 * The test file is left in the bucket on purpose, so you can see it in the Cloudflare dashboard.
 * Exit codes: 0 = all checks passed, 1 = a check failed, 2 = usage error.
 */

const USAGE = `Usage:
  npm run storage -- check`;

const LINK_TTL_SECONDS = 60;
const WAIT_AFTER_EXPIRY_SECONDS = 70;
const BROWSER_LINK_TTL_SECONDS = 300;
const FETCH_TIMEOUT_MS = 20_000;

type Print = (line: string) => void;

export async function runStorageCommand(argv: string[], print: Print, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "check") {
    print(USAGE);
    return 2;
  }

  print("R2 storage check (F22)");
  const read = readR2Config(env);
  if (!read.ok) {
    print("FAIL  config");
    for (const problem of read.problems) print(`      ${problem}`);
    return 1;
  }
  print(`PASS  config: all 4 R2 variables are set (bucket ${read.config.bucket}; key values hidden)`);
  return runChecks(read.config, print);
}

async function runChecks(config: R2Config, print: Print): Promise<number> {
  const store = R2ArtifactStore.fromConfig(config, { allowHealthcheck: true });
  const safe = (error: unknown) => redactR2(error instanceof Error ? `${error.name}: ${error.message}` : String(error), config);
  let failures = 0;
  const pass = (text: string) => print(`PASS  ${text}`);
  const fail = (text: string) => {
    failures += 1;
    print(`FAIL  ${text}`);
  };

  const key = healthcheckKey();
  const content = "Hello from the reel app F22 check\n";

  // 1. Upload
  let uploadedSha: string;
  try {
    const stored = await store.put(key, content, CONTENT_TYPES.text);
    uploadedSha = stored.sha256;
    pass(`upload: ${key} (${stored.bytes} bytes, ${stored.sha256})`);
  } catch (error) {
    fail(`upload: ${safe(error)}`);
    print("      Check that the API token has \"Object Read & Write\" on this bucket and that R2_BUCKET is the bucket's exact name.");
    return 1;
  }

  // 2. Read back + compare SHA-256
  try {
    const data = await store.get(key);
    const info = await store.head(key);
    const readSha = data ? `sha256:${createHash("sha256").update(data).digest("hex")}` : null;
    if (data && readSha === uploadedSha && info?.sha256 === uploadedSha && info.bytes === data.byteLength) {
      pass(`read back: same SHA-256, size ${info.bytes} bytes, type ${info.contentType ?? "unknown"}`);
    } else {
      fail(`read back: the file came back different (found: ${data ? "yes" : "no"}, hash match: ${readSha === uploadedSha})`);
    }
  } catch (error) {
    fail(`read back: ${safe(error)}`);
  }

  // 3. Not public: an unsigned GET straight to the S3 endpoint must be refused.
  try {
    const unsigned = await fetch(`${r2Endpoint(config.accountId)}/${config.bucket}/${key}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    await unsigned.arrayBuffer();
    if (unsigned.ok) fail(`private: a request WITHOUT a signature could read the file (HTTP ${unsigned.status})`);
    else pass(`private: a request without a signature is refused (HTTP ${unsigned.status})`);
  } catch (error) {
    fail(`private: ${safe(error)}`);
  }

  // 4. Presigned link (60 s): works now, refused after it expires.
  let shortLink: string | null = null;
  try {
    shortLink = (await store.presignedGet(key, { ttlSeconds: LINK_TTL_SECONDS })).url;
    const response = await fetch(shortLink, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = await response.text();
    if (response.status === 200 && text === content) pass(`private link (${LINK_TTL_SECONDS} s): opens and shows the same text (HTTP 200)`);
    else fail(`private link (${LINK_TTL_SECONDS} s): expected HTTP 200 with the same text, got HTTP ${response.status}`);
  } catch (error) {
    fail(`private link: ${safe(error)}`);
  }

  if (shortLink) {
    print(`      Waiting ${WAIT_AFTER_EXPIRY_SECONDS} s for the ${LINK_TTL_SECONDS} s link to expire…`);
    for (let left = WAIT_AFTER_EXPIRY_SECONDS; left > 0; left -= 10) {
      await sleep(Math.min(10, left) * 1000);
      if (left > 10) print(`      ${left - 10} s left`);
    }
    try {
      const expired = await fetch(shortLink, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      await expired.arrayBuffer();
      if (expired.status === 401 || expired.status === 403) pass(`expired link: refused after ${WAIT_AFTER_EXPIRY_SECONDS} s (HTTP ${expired.status})`);
      else fail(`expired link: expected HTTP 403 after expiry, got HTTP ${expired.status}`);
    } catch (error) {
      fail(`expired link: ${safe(error)}`);
    }
  }

  print("");
  if (failures > 0) {
    print(`${failures} check(s) FAILED. The test file ${key} stays in the bucket.`);
    return 1;
  }
  print(`All checks passed. The test file stays in the bucket: ${config.bucket} → ${key}`);
  try {
    const browser = await store.presignedGet(key, { ttlSeconds: BROWSER_LINK_TTL_SECONDS });
    print(`Open this private link in your browser (works for ${BROWSER_LINK_TTL_SECONDS / 60} minutes, then shows an error; don't share it):`);
    print(browser.url);
  } catch (error) {
    print(`(Could not make the browser link: ${safe(error)})`);
  }
  return 0;
}

if (import.meta.main) {
  loadLocalEnvFile(".env");
  process.exitCode = await runStorageCommand(process.argv.slice(2), (line) => console.log(line));
}
