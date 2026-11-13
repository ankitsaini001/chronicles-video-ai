// `npm run dev`: load the project-root .env into this process, then start `next dev` here.
// Why: `next dev` restarts its server by itself (e.g. when next.config.ts changes during a git
// checkout). The restarted server only inherits what was in the environment at start-up, so the
// values must be loaded before Next starts, not only from next.config.ts.
// (Node's --env-file flag can't be used: Next passes it on in NODE_OPTIONS, where Node refuses it.)
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const rootEnvFile = path.resolve(import.meta.dirname, "../../../.env");
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

// Run Next's own command-line entry as if `next dev <args>` had been typed.
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
process.argv = [process.argv[0], nextBin, "dev", ...process.argv.slice(2)];
await import(nextBin);
