// Runs once when the Next.js server starts (node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
// Start-up settings check (F06, F08): if a required setting is missing, print one clear message
// instead of a crash later. The public pages still work, so the server keeps running.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { readDbConfig } = await import("@bytereel/db/config");
  const { readAuthConfig } = await import("./lib/auth/config");
  const db = readDbConfig(process.env);
  const auth = readAuthConfig(process.env);
  const problems = [...(db.ok ? [] : db.problems), ...(auth.ok ? [] : auth.problems)];
  if (problems.length === 0) return;
  const lines = [
    "",
    "┌─ ByteReel settings problem ─────────────────────────────────────────",
    ...problems.map((p) => `│ • ${p}`),
    "│ Pages that need the database or login (sign-up, login, your videos) won't work until this is fixed.",
    "│ Fix the .env file in the project root, then restart: npm run dev",
    "└─────────────────────────────────────────────────────────────────────",
    "",
  ];
  console.error(lines.join("\n"));
}
