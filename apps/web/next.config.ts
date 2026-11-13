import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// One .env for the whole repo: the web app also reads the .env in the project root (two folders
// up), the same file the command-line tools use. Node's built-in loader never overrides values that
// are already set (e.g. on Vercel, or by Next's own apps/web/.env* files).
// (@next/env's loadEnvConfig can't be used here: Next has already called it, and it caches.)
// `next dev`/`next build`/`next start` run with apps/web as the working folder.
const rootEnvFile = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, so Next compiles them.
  transpilePackages: ["@bytereel/db"],
};

export default nextConfig;
