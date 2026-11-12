import path from "node:path";
import { parseArgs } from "node:util";
import { redactSecrets } from "../../packages/pipeline/src/config/config";
import { runApproveCommand } from "./approve";
import { runGenerateCommand } from "./generate";
import { runFixtureCommand } from "./fixture";
import { runPlanCommand } from "./plan";
import { runPreflight } from "./preflight";
import { runRenderFixtureCommand } from "./render-fixture";

/**
 * Developer CLI. Usage:
 *   npm run pipeline -- preflight [--network]
 *   npm run pipeline -- plan --topic-file examples/water-cycle.md --voice indian-english-female
 *   npm run pipeline -- approve --run <run-id> --plan-hash <hash>
 *   npm run pipeline -- generate --run <run-id> [--scene <scene-id> ...] [--max-characters N]
 *   npm run pipeline -- resume --run <run-id> [--max-characters N]
 *   npm run pipeline -- fixture --file fixtures/water-cycle.plan.json
 *   npm run pipeline -- render-fixture --file fixtures/water-cycle.plan.json [--force]
 *
 * Exit codes: 0 = success, 1 = validation/check failure, 2 = usage error.
 */

const USAGE = `Usage:
  npm run pipeline -- preflight [--network]
  npm run pipeline -- plan --topic-file <topic.md> --voice <preset>
  npm run pipeline -- approve --run <owner/project/version> --plan-hash <sha256:...>
  npm run pipeline -- generate --run <owner/project/version> [--scene <scene-id> ...] [--max-characters N]
  npm run pipeline -- resume --run <owner/project/version> [--max-characters N]
  npm run pipeline -- fixture --file <fixture.plan.json>
  npm run pipeline -- render-fixture --file <fixture.plan.json> [--force]

preflight --network makes read-only provider checks (no generation, no text-to-speech).
plan calls the LIVE Gemini planner and writes plan.json + plan-review.html (awaiting approval).
generate (approved live runs): ElevenLabs speech per scene -> compile -> render with narration -> validate.
  --scene synthesizes only the named scene(s) as a probe and stops; --max-characters caps the run's
  total text-to-speech characters (default 1.5 x the narration). Saved speech is always reused.
resume continues a failed/needs-input run from saved artifacts (never re-synthesizes saved scenes).
render-fixture compiles, renders and validates a fixture with SYNTHETIC SILENT timing (P1).`;

async function main(argv: string[]): Promise<number> {
  const projectRoot = process.cwd();
  const runsDir = path.join(projectRoot, "runs");
  const [command, ...rest] = argv;

  switch (command) {
    case "preflight": {
      const { values } = parseArgs({ args: rest, options: { network: { type: "boolean" } }, strict: true });
      const { ok, lines } = await runPreflight({ projectRoot, runsDir, network: values.network ?? false });
      print(lines);
      return ok ? 0 : 1;
    }
    case "plan": {
      const { values } = parseArgs({ args: rest, options: { "topic-file": { type: "string" }, voice: { type: "string" } }, strict: true });
      if (!values["topic-file"] || !values.voice) {
        print(["Missing --topic-file or --voice.", "", USAGE]);
        return 2;
      }
      const { ok, lines } = await runPlanCommand({ topicFile: values["topic-file"], voice: values.voice, projectRoot, runsDir, print });
      print(lines);
      return ok ? 0 : 1;
    }
    case "approve": {
      const { values } = parseArgs({ args: rest, options: { run: { type: "string" }, "plan-hash": { type: "string" } }, strict: true });
      if (!values.run || !values["plan-hash"]) {
        print(["Missing --run or --plan-hash.", "", USAGE]);
        return 2;
      }
      const { ok, lines } = await runApproveCommand({ run: values.run, planHash: values["plan-hash"], runsDir, projectRoot });
      print(lines);
      return ok ? 0 : 1;
    }
    case "generate":
    case "resume": {
      const { values } = parseArgs({
        args: rest,
        options: { run: { type: "string" }, scene: { type: "string", multiple: true }, "max-characters": { type: "string" } },
        strict: true,
      });
      if (!values.run) {
        print(["Missing --run.", "", USAGE]);
        return 2;
      }
      if (command === "resume" && values.scene?.length) {
        print(["--scene is only for generate (a speech probe).", "", USAGE]);
        return 2;
      }
      const rawMax = values["max-characters"];
      if (rawMax !== undefined && !/^\d+$/.test(rawMax)) {
        print(["--max-characters must be a whole number.", "", USAGE]);
        return 2;
      }
      const { ok, lines } = await runGenerateCommand({
        mode: command,
        run: values.run,
        scenes: values.scene ?? [],
        maxCharacters: rawMax === undefined ? null : Number(rawMax),
        runsDir,
        projectRoot,
        print,
      });
      print(lines);
      return ok ? 0 : 1;
    }
    case "fixture": {
      const { values } = parseArgs({ args: rest, options: { file: { type: "string" } }, strict: true });
      if (!values.file) {
        print(["Missing --file.", "", USAGE]);
        return 2;
      }
      const { ok, lines } = await runFixtureCommand({ file: values.file, projectRoot, runsDir });
      print(lines);
      return ok ? 0 : 1;
    }
    case "render-fixture": {
      const { values } = parseArgs({ args: rest, options: { file: { type: "string" }, force: { type: "boolean" } }, strict: true });
      if (!values.file) {
        print(["Missing --file.", "", USAGE]);
        return 2;
      }
      const { ok, lines } = await runRenderFixtureCommand({ file: values.file, force: values.force ?? false, projectRoot, runsDir, print });
      print(lines);
      return ok ? 0 : 1;
    }
    case undefined:
    case "help":
    case "--help":
      print([USAGE]);
      return command === undefined ? 2 : 0;
    default:
      print([`Unknown command "${command}".`, "", USAGE]);
      return 2;
  }
}

function print(lines: string[]): void {
  // Every line goes through redaction, so a secret can never reach the terminal by accident.
  console.log(redactSecrets(lines.join("\n")));
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(redactSecrets(`Unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
    process.exitCode = 1;
  },
);
