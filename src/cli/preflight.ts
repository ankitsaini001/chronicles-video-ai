import { existsSync, statfsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadLocalEnvFile, readConfig, VOICE_ID_ENV_BY_PRESET, type ConfigReport } from "../../packages/pipeline/src/config/config";
import { checkGeminiModel, ElevenLabsReadClient, ProviderError } from "../../packages/pipeline/src/providers";
import { atomicWriteFile } from "../../packages/pipeline/src/storage";

/**
 * Preflight (PIPELINE_DESIGN.md §10): checks the local runtime, configuration presence,
 * disk space and output folder access. It makes NO network calls, so it can never
 * trigger paid generation. Missing credentials are reported, not treated as failures,
 * because P0/P1 fixture work does not need them.
 */

const MIN_NODE_MAJOR = 24;
const MIN_FREE_BYTES = 1 * 1024 ** 3; // below this: fail
const RECOMMENDED_FREE_BYTES = 5 * 1024 ** 3; // below this: warn (renders need room)

type Level = "ok" | "warn" | "fail" | "info";
interface Check {
  level: Level;
  message: string;
}

export interface PreflightOptions {
  projectRoot: string;
  runsDir: string;
  /** Explicit, read-only auth/model/voice checks against the providers. Never generates anything. */
  network?: boolean;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export async function runPreflight({ projectRoot, runsDir, network = false, fetch: fetchFn }: PreflightOptions): Promise<{ ok: boolean; lines: string[] }> {
  const checks: Check[] = [];

  // Node.js version
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= MIN_NODE_MAJOR
      ? { level: "ok", message: `Node.js v${process.versions.node} (need >= ${MIN_NODE_MAJOR})` }
      : { level: "fail", message: `Node.js v${process.versions.node} is too old; install Node ${MIN_NODE_MAJOR} LTS or newer` },
  );

  // Output folder access (create it if needed, then write and remove a probe file atomically)
  let outputOk = false;
  try {
    await fs.mkdir(runsDir, { recursive: true });
    const probe = path.join(runsDir, ".preflight-probe");
    await atomicWriteFile(probe, Buffer.from("ok"));
    await fs.rm(probe, { force: true });
    outputOk = true;
    checks.push({ level: "ok", message: `Output folder is writable: ${path.relative(projectRoot, runsDir) || runsDir}/` });
  } catch (error) {
    checks.push({ level: "fail", message: `Cannot write to output folder ${runsDir}: ${(error as Error).message}` });
  }

  // Disk space where artifacts are written
  try {
    const stats = statfsSync(outputOk ? runsDir : projectRoot);
    const free = stats.bavail * stats.bsize;
    const freeText = `${(free / 1024 ** 3).toFixed(1)} GB free`;
    if (free < MIN_FREE_BYTES) checks.push({ level: "fail", message: `Disk space: only ${freeText}; need at least 1 GB` });
    else if (free < RECOMMENDED_FREE_BYTES) checks.push({ level: "warn", message: `Disk space: ${freeText}; 5 GB+ recommended once rendering starts (P1)` });
    else checks.push({ level: "ok", message: `Disk space: ${freeText}` });
  } catch (error) {
    checks.push({ level: "warn", message: `Disk space could not be checked: ${(error as Error).message}` });
  }

  // Render tooling: Remotion's own headless Chromium (no system browser needed).
  const headlessShell = path.join(projectRoot, "node_modules", ".remotion", "chrome-headless-shell");
  checks.push(
    existsSync(headlessShell)
      ? { level: "ok", message: "Render tooling: Remotion + its chrome-headless-shell are installed" }
      : { level: "warn", message: "Render tooling: Remotion's headless browser is not downloaded yet; run `npx remotion browser ensure` (about 100 MB) or let the first render fetch it" },
  );
  if (!network) {
    checks.push({ level: "info", message: "Network and credential checks: not run (add --network for read-only provider checks)" });
  }

  // Configuration (presence only; secret values are never printed)
  const envFileLoaded = loadLocalEnvFile(path.join(projectRoot, ".env"));
  const config = readConfig();
  const configLines = config.entries.map((entry) => {
    const level: Level = entry.status === "set" ? "ok" : entry.status === "invalid" ? "fail" : "warn";
    const needed = entry.neededFor === "live-english" ? "live English (P2)" : "Hindi + Hinglish (P3)";
    return `  ${tag(level)} ${entry.name.padEnd(36)} ${entry.shown}  [needed for ${needed}]`;
  });
  const invalidConfig = config.entries.some((e) => e.status === "invalid");
  const missingEnglish = config.entries.filter((e) => e.neededFor === "live-english" && e.status !== "set").length;
  const missingAll = config.entries.filter((e) => e.status !== "set").length;

  const networkChecks = network ? await runNetworkChecks(config, fetchFn) : null;
  const networkOk = networkChecks ? !networkChecks.some((c) => c.level === "fail") : true;

  const localOk = !checks.some((c) => c.level === "fail") && !invalidConfig;
  const ok = localOk && networkOk;
  const lines = [
    network ? "ByteReel preflight (with read-only network checks; no generation calls)" : "ByteReel preflight (no network calls)",
    "",
    "Runtime",
    ...checks.map((c) => `  ${tag(c.level)} ${c.message}`),
    "",
    `Configuration (${envFileLoaded ? "loaded .env" : "no .env file found; reading environment only. Copy .env.example to .env"})`,
    ...configLines,
    ...(networkChecks ? ["", "Network checks (models get/list, voice lookup; no text-to-speech, no generation)", ...networkChecks.map((c) => `  ${tag(c.level)} ${c.message}`)] : []),
    "",
    "Summary",
    `  Fixture work (P0/P1):   ${localOk ? "READY" : "NOT READY (fix the [fail] items above)"}`,
    `  Live English (P2):      ${!config.readyFor["live-english"] ? `NOT READY (${missingEnglish} setting(s) missing)` : networkChecks ? (networkOk ? "READY (network checks passed)" : "NOT READY (network checks failed)") : "configured (run with --network to verify keys, model and voices)"}`,
    `  Hindi/Hinglish (P3):    ${!config.readyFor["live-hindi-hinglish"] ? `NOT READY (${missingAll} setting(s) missing)` : networkChecks ? (networkOk ? "READY (network checks passed)" : "NOT READY (network checks failed)") : "configured (run with --network to verify)"}`,
    "  Voices: Hinglish presets use the Hindi voice IDs (no separate Hinglish voices).",
  ];
  return { ok, lines };
}

function tag(level: Level): string {
  return `[${level}]`.padEnd(6);
}

// ---------- --network ----------

const PRESETS_BY_VOICE_ENV: Record<string, string[]> = {};
for (const [preset, envName] of Object.entries(VOICE_ID_ENV_BY_PRESET)) (PRESETS_BY_VOICE_ENV[envName] ??= []).push(preset);

/**
 * Read-only provider checks: Gemini models.get (+ models.list when the configured model is missing),
 * ElevenLabs GET /v1/models and GET /v1/voices/{id}. No generation and no text-to-speech.
 * A missing model is reported with the available Flash-class models; nothing is substituted.
 */
async function runNetworkChecks(config: ConfigReport, fetchFn?: typeof fetch): Promise<Check[]> {
  const checks: Check[] = [];
  const v = config.values;

  // Gemini
  const geminiKey = v.GEMINI_API_KEY;
  const geminiModel = v.GEMINI_MODEL;
  if (!geminiKey || !geminiModel) {
    checks.push({ level: "fail", message: "Gemini: GEMINI_API_KEY and GEMINI_MODEL must be set before the network check" });
  } else {
    const result = await checkGeminiModel(geminiKey, geminiModel, fetchFn);
    if (result.ok) {
      const m = result.model;
      checks.push({
        level: "ok",
        message: `Gemini: key accepted; model "${m.id}" is available${m.displayName ? ` (${m.displayName})` : ""}, ` +
          `input limit ${m.inputTokenLimit ?? "?"} tokens, output limit ${m.outputTokenLimit ?? "?"} tokens, supports generateContent`,
      });
    } else {
      checks.push({ level: "fail", message: `Gemini: ${result.message}` });
      if (result.flashModels) {
        checks.push({
          level: "info",
          message: result.flashModels.length
            ? `Gemini: Flash-class models available to this key (no automatic substitution; set GEMINI_MODEL to the one you choose): ${result.flashModels.map((f) => f.id).join(", ")}`
            : "Gemini: no Flash-class models are listed for this key",
        });
      }
    }
  }

  // ElevenLabs
  const elevenKey = v.ELEVENLABS_API_KEY;
  if (!elevenKey) {
    checks.push({ level: "fail", message: "ElevenLabs: ELEVENLABS_API_KEY is not set" });
    return checks;
  }
  const client = new ElevenLabsReadClient(elevenKey, fetchFn);
  try {
    const models = await client.listModels();
    const configured = v.ELEVENLABS_MODEL;
    const match = configured ? models.find((m) => m.id === configured) : undefined;
    if (!configured) checks.push({ level: "fail", message: "ElevenLabs: ELEVENLABS_MODEL is not set" });
    else if (!match) {
      checks.push({ level: "fail", message: `ElevenLabs: key accepted, but model "${configured}" is not listed. TTS models available: ${models.filter((m) => m.canDoTextToSpeech).map((m) => m.id).join(", ") || "(none)"}` });
    } else if (!match.canDoTextToSpeech) {
      checks.push({ level: "fail", message: `ElevenLabs: model "${configured}" is listed but cannot do text-to-speech` });
    } else {
      const hindi = match.languages.some((l) => /hindi/i.test(l));
      checks.push({ level: "ok", message: `ElevenLabs: key accepted; model "${match.id}"${match.name ? ` (${match.name})` : ""} is available for text-to-speech; ${match.languages.length} languages${hindi ? " incl. Hindi" : ""}` });
    }
  } catch (error) {
    checks.push({ level: "fail", message: `ElevenLabs: ${describe(error)}` });
    if (error instanceof ProviderError && error.kind === "auth") return checks;
  }

  // Free-plan accounts cannot use Voice Library ("professional") voices through the API: text-to-speech
  // answers 402 payment_required even though the voice lookup succeeds (observed 2026-11-12).
  let tier: string | null = null;
  try {
    const usage = await client.getCharacterUsage();
    tier = usage?.tier ?? null;
    if (usage) checks.push({ level: "info", message: `ElevenLabs account: tier ${usage.tier ?? "?"}, ${usage.used} / ${usage.limit} characters used this period` });
  } catch {
    // usage is informational only
  }
  for (const [envName, presets] of Object.entries(PRESETS_BY_VOICE_ENV)) {
    const spec = config.entries.find((e) => e.name === envName);
    const voiceId = v[envName];
    const label = `${envName} (${presets.join(", ")})`;
    if (!voiceId) {
      checks.push({ level: spec?.neededFor === "live-english" ? "fail" : "warn", message: `Voice ${label}: not configured` });
      continue;
    }
    try {
      const lookup = await client.getVoice(voiceId);
      if (!lookup.found) {
        checks.push({ level: "fail", message: `Voice ${label}: ${voiceId} was not found or is not accessible to this key (${lookup.detail}). Add it to "My Voices" or configure another voice ID; no replacement is used` });
        continue;
      }
      const voice = lookup.voice;
      const labels = Object.entries(voice.labels).filter(([, val]) => val).map(([k, val]) => `${k}: ${val}`).join(", ");
      const described = `Voice ${label}: ${voiceId} = "${voice.name ?? "?"}"${voice.category ? `, category ${voice.category}` : ""}${labels ? ` (${labels})` : ""}`;
      if (tier === "free" && voice.category === "professional") {
        checks.push({
          level: "fail",
          message: `${described}. This is a Voice Library voice: on the free plan ElevenLabs refuses it for API text-to-speech (402 payment_required). Use a premade/own voice or a paid plan; no replacement is used automatically`,
        });
      } else {
        checks.push({ level: "ok", message: described });
      }
    } catch (error) {
      checks.push({ level: "fail", message: `Voice ${label}: ${describe(error)}` });
    }
  }
  checks.push({ level: "info", message: "Text-to-speech was NOT called (quota is only spent by generate/resume)." });
  return checks;
}

function describe(error: unknown): string {
  if (error instanceof ProviderError) return `${error.message}${error.kind === "auth" ? " (check the API key and its permissions)" : ""}`;
  return error instanceof Error ? error.message : String(error);
}
