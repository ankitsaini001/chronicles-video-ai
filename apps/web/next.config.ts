import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// One .env for the whole repo: the web app also reads the .env in the project root (two folders
// up), the same file the command-line tools use. Node's built-in loader never overrides values that
// are already set (e.g. on Vercel, or by Next's own apps/web/.env* files).
// (@next/env's loadEnvConfig can't be used here: Next has already called it, and it caches.)
// Keep ONE .env at the project root and never add apps/web/.env* files: when such a file changes,
// `next dev` resets the environment to its start-up snapshot, which drops the root values until a
// restart. Changing the root .env also needs a restart (Next only watches apps/web).
// `next dev`/`next build`/`next start` run with apps/web as the working folder.
// `npm run dev` also loads the root .env into the dev process itself (scripts/dev.mjs): when
// `next dev` restarts its server (e.g. next.config.ts changed during a
// git checkout), the new server inherits the settings instead of losing them.
const rootEnvFile = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, so Next compiles them.
  transpilePackages: ["@bytereel/db"],
  // F13: B4 and the Idea page check which voice sample MP3s exist (lib/voices.ts). On a host that
  // serves public/ from a CDN (Vercel), those files aren't next to the server code unless included.
  outputFileTracingIncludes: {
    "/api/v1/voices": ["./public/voices/*.mp3"],
    "/projects/new": ["./public/voices/*.mp3"],
  },
};

export default nextConfig;
