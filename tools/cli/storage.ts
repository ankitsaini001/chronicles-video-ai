import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { loadLocalEnvFile } from "@bytereel/pipeline/config/config";
import { r2Endpoint, R2ArtifactStore, readR2Config, redactR2, StorageError, type R2Config } from "@bytereel/storage";
import { healthcheckKey } from "@bytereel/storage/healthcheck";

/**
 * File storage commands (F22). Reads R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
 * from .env in the project root. Never prints those values.
 *   npm run storage -- check [--print-link]
 *     upload a test file to healthcheck/, read it back, test private links (≈ 80 s).
 *     --print-link also prints a 5-minute private link to open in a browser (it contains the
 *     token's access key ID and a signature: don't share or paste it anywhere).
 * The test file is left in the bucket on purpose, so you can see it in the Cloudflare dashboard.
 * Exit codes: 0 = all checks passed, 1 = a check failed, 2 = usage error.
 */

const USAGE = `Usage:
  npm run storage -- check [--print-link]`;

const LINK_TTL_SECONDS = 60;
const WAIT_AFTER_EXPIRY_SECONDS = 70;
const BROWSER_LINK_TTL_SECONDS = 300;
const FETCH_TIMEOUT_MS = 20_000;

type Print = (line: string) => void;

export async function runStorageCommand(argv: string[], print: Print, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...flags] = argv;
  const printLink = flags.length === 1 && flags[0] === "--print-link";
  if (command !== "check" || (flags.length > 0 && !printLink)) {
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
  return runChecks(read.config, print, printLink);
}

async function runChecks(config: R2Config, print: Print, printLink: boolean): Promise<number> {
  const store = R2ArtifactStore.fromConfig(config, { allowHealthcheck: true });
  // StorageError messages are already safe; anything else (fetch) is redacted before printing.
  const safe = (error: unknown) =>
    error instanceof StorageError ? error.message : redactR2(error instanceof Error ? `${error.name}: ${error.message}` : String(error), config);
  let failures = 0;
  const pass = (text: string) => print(`PASS  ${text}`);
  const fail = (text: string) => {
    failures += 1;
    print(`FAIL  ${text}`);
  };

  // 1. The bucket exists and the token can use it.
  try {
    await store.checkBucket();
    pass(`bucket: ${config.bucket} found, the token can use it`);
  } catch (error) {
    fail(`bucket: ${safe(error)}`);
    return 1;
  }

  const key = healthcheckKey();
  const content = "Hello from the reel app F22 check\n";

  // 2. Upload (create-only, like finished artifacts).
  let uploadedSha: string;
  try {
    const stored = await store.put(key, content, { createOnly: true });
    uploadedSha = stored.sha256;
    pass(`upload: ${key} (${stored.bytes} bytes, ${stored.sha256})`);
  } catch (error) {
    fail(`upload: ${safe(error)}`);
    return 1;
  }

  // 3. Create-only: a second upload to the same key must be refused.
  try {
    await store.put(key, "overwritten\n", { createOnly: true });
    fail("create-only: a second upload to the same key was NOT refused");
  } catch (error) {
    if (error instanceof StorageError && error.code === "already_exists") pass(`create-only: a second upload to the same key is refused (HTTP ${error.status ?? "?"})`);
    else fail(`create-only: ${safe(error)}`);
  }

  // 4. Read back + compare SHA-256
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

  // 5. Not public: an unsigned GET straight to the S3 endpoint must be refused.
  try {
    const unsigned = await fetch(`${r2Endpoint(config.accountId)}/${config.bucket}/${key}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    await unsigned.arrayBuffer();
    if (unsigned.ok) fail(`private: a request WITHOUT a signature could read the file (HTTP ${unsigned.status})`);
    else pass(`private: a request without a signature is refused (HTTP ${unsigned.status})`);
  } catch (error) {
    fail(`private: ${safe(error)}`);
  }

  // 6. Presigned link (60 s): works now, refused after it expires. The link itself is never printed.
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
  print("See it in the Cloudflare dashboard: R2 → your bucket → Objects → healthcheck/.");
  if (!printLink) {
    print("(To also get a 5-minute private link for your browser, run: npm run storage -- check --print-link)");
    return 0;
  }
  try {
    const browser = await store.presignedGet(key, { ttlSeconds: BROWSER_LINK_TTL_SECONDS });
    print("");
    print(`WARNING: this link contains your R2 token's access key ID and a signature. Don't share it, paste it`);
    print(`in chats or commit it. Open it in your browser: it works for ${BROWSER_LINK_TTL_SECONDS / 60} minutes, then shows an error.`);
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
