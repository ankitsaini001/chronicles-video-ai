import { readTokenKeys } from "@bytereel/db";
import { getInngest } from "../../inngest/client";
import { storageFromEnv } from "../video/storage";

// F30: before saving anything that starts a publish job (H2, H6): Inngest, the token keys (the job
// decrypts the creator's token) and the R2 bucket (Meta fetches the MP4 through a private link) must
// be set up. Otherwise nothing is saved and the answer is 500 (the reason goes to the server log).

export function assertPublishReady(env: NodeJS.ProcessEnv = process.env): void {
  const inngest = getInngest(env);
  if (!inngest.ok) throw new Error(`Background jobs are not set up: ${inngest.problem}`);
  const keys = readTokenKeys(env);
  if (!keys.ok) throw new Error(`The Instagram token keys are not set up: ${keys.problems.join(" ")}`);
  const storage = storageFromEnv(env);
  if (!storage.ok) throw new Error(`File storage (R2) is not set up: ${storage.problem}`);
}
