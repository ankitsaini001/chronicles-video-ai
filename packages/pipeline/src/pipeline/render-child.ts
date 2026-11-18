import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeCancelSignal } from "@remotion/renderer";
import { killProcessTree } from "./process-tree";
import { runRenderJob } from "./render-job";
import type { RenderChildMessage, RenderJobResult, RenderParentMessage, RenderPhase } from "./render-protocol";

/**
 * The render child process (F23). Started by the web app's generate worker
 * (apps/web/lib/video/render-process.ts) with Node's IPC channel:
 *   worker → { type: "start", spec }   then optionally   { type: "cancel" }
 *   child  → { type: "progress", phase, percent } …   then   { type: "result", result }
 * It renders one video from local files (render-job.ts) and exits. The worker starts it detached (its
 * own process group) with only the environment rendering needs (no secrets), and stops it by killing
 * its whole process tree (process-tree.ts: Chrome runs in a group of its own). A failure's `detail`
 * (with its stack) goes to the worker's server log only.
 *
 * Temporary files: Remotion and Chrome use the process temp folder (TMPDIR), not the job's work
 * folder. The worker starts this process with TMPDIR=<project>/runs/.tmp; as a second guard, this
 * file sets it there itself if it points anywhere else (never /tmp, which is shared on the machine).
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../../..");
const PROJECT_TMP = path.join(PROJECT_ROOT, "runs", ".tmp");
const inside = (dir: string) => {
  const relative = path.relative(PROJECT_ROOT, path.resolve(dir));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};
if (!inside(os.tmpdir())) process.env.TMPDIR = PROJECT_TMP;
mkdirSync(PROJECT_TMP, { recursive: true });

function send(message: RenderChildMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send || !process.connected) return resolve();
    process.send(message, () => resolve());
  });
}

const { cancelSignal, cancel } = makeCancelSignal();
let cancelled = false;
let started = false;

async function start(spec: Extract<RenderParentMessage, { type: "start" }>["spec"]): Promise<void> {
  let last = "";
  let result: RenderJobResult;
  try {
    result = await runRenderJob(spec, {
      cancelSignal,
      isCancelled: () => cancelled,
      onProgress: (phase: RenderPhase, percent: number) => {
        const key = `${phase}:${percent}`;
        if (key === last) return;
        last = key;
        void send({ type: "progress", phase, percent });
      },
    });
  } catch (error) {
    result = cancelled ? { status: "cancelled" } : { status: "failed", stage: "render", detail: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  await send({ type: "result", result });
  process.exit(0);
}

process.on("message", (message: RenderParentMessage) => {
  if (message?.type === "cancel") {
    cancelled = true;
    cancel();
    return;
  }
  if (message?.type === "start" && !started) {
    started = true;
    void start(message.spec);
  }
});

// The worker went away (crash, restart): stop rendering for nobody. After a short grace everything
// this process started (Chrome in its own group, ffmpeg) is killed, then it exits.
process.on("disconnect", () => {
  cancelled = true;
  cancel();
  setTimeout(() => {
    killProcessTree(process.pid);
    process.exit(1);
  }, 5000).unref();
});
