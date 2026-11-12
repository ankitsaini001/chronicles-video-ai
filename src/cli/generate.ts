import path from "node:path";
import { loadLocalEnvFile, readConfig, voiceIdFor, VOICE_ID_ENV_BY_PRESET } from "../config/config";
import { ArtifactKeys, LocalArtifactStore, LocalSpeechCache, RunLockedError } from "../storage";
import { generateRun, parseRunId, speechConfigFor, type GenerateMode, type GenerateResult } from "../pipeline";
import { ElevenLabsReadClient, ElevenLabsSpeech } from "../providers";

/**
 * `generate --run <id> [--scene <id> ...] [--max-characters N]` and `resume --run <id> [--max-characters N]`.
 *
 * Live: speech (ElevenLabs, per scene, cached) -> compile -> render with narration -> validate.
 * `--scene` synthesizes (or reuses) only the named scenes and stops: a cheap probe before the full run.
 * Before and after, the account's character usage is read from GET /v1/user/subscription (read-only,
 * free) when the key allows it. Keys are never printed.
 */
export async function runGenerateCommand(opts: {
  mode: GenerateMode;
  run: string;
  scenes: string[];
  maxCharacters: number | null;
  runsDir: string;
  projectRoot: string;
  print: (lines: string[]) => void;
}): Promise<{ ok: boolean; lines: string[] }> {
  const run = parseRunId(opts.run);
  if (!run) return { ok: false, lines: ["ERROR: --run must look like <owner>/<project>/<version>"] };
  loadLocalEnvFile(path.join(opts.projectRoot, ".env"));
  const config = readConfig();
  const apiKey = config.values.ELEVENLABS_API_KEY;
  const model = config.values.ELEVENLABS_MODEL;
  const usageClient = apiKey ? new ElevenLabsReadClient(apiKey) : null;

  const usageLine = async (label: string) => {
    if (!usageClient) return null;
    try {
      const usage = await usageClient.getCharacterUsage();
      return usage
        ? `ElevenLabs account ${label}: ${usage.used} / ${usage.limit} characters used (${usage.limit - usage.used} left${usage.tier ? `, tier ${usage.tier}` : ""}${usage.resetsAt ? `, resets ${usage.resetsAt}` : ""})`
        : `ElevenLabs account ${label}: usage not readable with this key`;
    } catch {
      return `ElevenLabs account ${label}: usage lookup failed (network)`;
    }
  };

  const store = new LocalArtifactStore(opts.runsDir);
  const before = await usageLine("before");
  opts.print([`ByteReel ${opts.mode} (LIVE: ElevenLabs narration)`, `Run: ${opts.run}`, ...(before ? [before] : [])]);

  let result: GenerateResult;
  try {
    result = await generateRun({
      store,
      run,
      mode: opts.mode,
      speechCache: new LocalSpeechCache(opts.runsDir),
      ...(opts.scenes.length ? { onlyScenes: opts.scenes } : {}),
      ...(opts.maxCharacters !== null ? { maxCharacters: opts.maxCharacters } : {}),
      speechConfig: (plan) => {
        const voiceId = voiceIdFor(plan.voicePreset, config);
        if (!voiceId) {
          throw new Error(`no voice configured for preset "${plan.voicePreset}": set ${VOICE_ID_ENV_BY_PRESET[plan.voicePreset]} in .env. No other voice is used instead.`);
        }
        if (!model) throw new Error("ELEVENLABS_MODEL is not set in .env");
        return speechConfigFor(plan, voiceId, model);
      },
      speechProvider: () => {
        if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set in .env; a scene needs new speech");
        return new ElevenLabsSpeech(apiKey);
      },
      onProgress: (message) => opts.print([`  ... ${message}`]),
    });
  } catch (error) {
    if (error instanceof RunLockedError) return { ok: false, lines: [`ERROR: ${error.message}`] };
    throw error;
  }

  const after = await usageLine("after");
  const tail = after ? [after] : [];
  if (result.status === "refused") return { ok: false, lines: [`REFUSED: ${result.message}`, "Nothing was generated.", ...tail] };

  const relDir = path.relative(opts.projectRoot, result.runDir);
  const usage = result.manifest.speechUsage;
  const sceneLines = result.scenes.map(
    (s) =>
      `  ${s.sceneId}: ${s.audioSeconds.toFixed(3)} s audio, ${s.characters} chars, ${s.source === "provider" ? "SYNTHESIZED" : `reused (${s.source})`}` +
      `${s.characterCost !== null ? `, provider charged ${s.characterCost}` : ""}, timing from ${s.mappedFrom} alignment${s.retries ? `, ${s.retries} retries` : ""}`,
  );
  const usageSummary = `Run speech usage: ${usage.requests} request(s), ${usage.charactersSent} characters sent` +
    (usage.charactersReported ? `, ${usage.charactersReported} reported charged` : "");
  const common = ["Speech:", ...sceneLines, usageSummary, ...tail];

  switch (result.status) {
    case "speech-only":
      return {
        ok: true,
        lines: [
          ...common,
          `Probe done. Scenes still without speech: ${result.pendingScenes.join(", ") || "(none)"}.`,
          `Run state: "${result.manifest.state}". Continue with: npm run pipeline -- generate --run ${opts.run}`,
        ],
      };
    case "already-done":
      return { ok: true, lines: [`Run ${relDir}/ is already ready for review and its artifacts match their hashes. Nothing to do.`, ...tail] };
    case "needs-input":
      return { ok: false, lines: [...common, `NEEDS INPUT (${result.stage}): ${result.message}`, `Run state: "${result.manifest.state}". See ${relDir}/manifest.json.`] };
    case "failed": {
      const qaLines = result.qa ? result.qa.checks.map((c) => `  [${c.ok ? "ok" : "fail"}] ${c.name}: expected ${c.expected}, got ${c.actual}`) : [];
      return {
        ok: false,
        lines: [...common, `FAILED at ${result.stage}: ${result.message}`, ...qaLines, `Run state: "${result.manifest.state}". Fix the cause, then: npm run pipeline -- ${result.manifest.state === "plan-approved" ? "generate" : "resume"} --run ${opts.run}` +
            " (saved speech is reused; nothing already synthesized is sent again)"],
      };
    }
    case "ready-for-review": {
      const { timeline } = result.compiled;
      const m = result.qa.measured;
      const output = result.manifest.artifacts[ArtifactKeys.output]!;
      return {
        ok: true,
        lines: [
          ...common,
          `Compile: ${timeline.totalFrames} frames = ${(timeline.totalFrames / timeline.fps).toFixed(2)} s, ${timeline.scenes.length} scenes, ${result.compiled.captions.captions.length} captions`,
          `Render: ${(result.render.renderMs / 1000).toFixed(1)} s (bundle ${(result.render.bundleMs / 1000).toFixed(1)} s, previews ${(result.render.stillsMs / 1000).toFixed(1)} s)`,
          "Validate:",
          ...result.qa.checks.map((c) => `  [${c.ok ? "ok" : "fail"}] ${c.name}: ${c.actual}`),
          `Output: ${relDir}/${ArtifactKeys.output} (${(output.bytes / 1024 / 1024).toFixed(2)} MB, ${m.codec} ${m.width}x${m.height} ${m.frameRate} fps, audio ${m.audioCodec} ${m.audioSampleRate ?? "?"} Hz)`,
          `Previews: ${relDir}/preview-frames/ (${result.render.previews.length} PNGs)`,
          `Run state: "${result.manifest.state}". Human review still required.`,
        ],
      };
    }
  }
}

