import path from "node:path";
import { approveRun, parseRunId } from "../../packages/pipeline/src/pipeline";
import { ArtifactKeys, LocalArtifactStore, RunLockedError } from "../../packages/pipeline/src/storage";

/** `approve --run <run-id> --plan-hash <hash>`: approve exactly the reviewed plan hash. */
export async function runApproveCommand(opts: { run: string; planHash: string; runsDir: string; projectRoot: string }): Promise<{ ok: boolean; lines: string[] }> {
  const run = parseRunId(opts.run);
  if (!run) return { ok: false, lines: [`ERROR: --run must look like <owner>/<project>/<version>, e.g. local-dev/how-the-water-cycle-works-3fa9c1/v1`] };
  const store = new LocalArtifactStore(opts.runsDir);
  let result;
  try {
    result = await approveRun({ store, run, planHash: opts.planHash.trim() });
  } catch (error) {
    if (error instanceof RunLockedError) return { ok: false, lines: [`ERROR: ${error.message}`] };
    throw error;
  }
  if (!("approval" in result)) {
    return { ok: false, lines: [`NOT APPROVED (${result.status}): ${result.message}`] };
  }
  const rel = path.relative(opts.projectRoot, path.join(result.runDir, ArtifactKeys.approval));
  return {
    ok: true,
    lines: [
      result.status === "approved" ? "Approved." : "Already approved with this hash; nothing changed.",
      `Plan hash: ${result.approval.planHash}`,
      `Approved by ${result.approval.actor} at ${result.approval.approvedAt} (${rel})`,
      `Run state: "${result.manifest.state}". Next: npm run pipeline -- generate --run ${opts.run.trim()}`,
    ],
  };
}
