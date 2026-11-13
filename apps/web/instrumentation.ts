// Runs once when the Next.js server starts (node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
// Start-up settings check (F06): if a required setting is missing, print one clear message instead
// of a crash later. The public pages still work, so the server keeps running.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { readDbConfig } = await import("@bytereel/db/config");
  const result = readDbConfig(process.env);
  if (result.ok) return;
  const lines = [
    "",
    "┌─ ByteReel settings problem ─────────────────────────────────────────",
    ...result.problems.map((p) => `│ • ${p}`),
    "│ Pages that need the database (sign-up, login, your videos) won't work until this is fixed.",
    "│ Fix the .env file in the project root, then restart: npm run dev",
    "└─────────────────────────────────────────────────────────────────────",
    "",
  ];
  console.error(lines.join("\n"));
}
