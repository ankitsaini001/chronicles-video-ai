import { fork } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RenderChildMessage, RenderJobResult, RenderJobSpec, RenderParentMessage, RenderPhase } from "@bytereel/pipeline/pipeline/render-protocol";

// Rendering on this computer (F23, founder 2026-11-15; Vercel Sandbox is decided at go-live, F38):
// the generate worker starts packages/pipeline/src/pipeline/render-child.ts in its own Node process
// (with tsx), hands it the job over Node's IPC channel, relays its progress, and can cancel it
// (a "cancel" message → Remotion's cancel signal; killed if it doesn't stop within 20 s).
// Temporary files: the child gets TMPDIR=<project>/runs/.tmp explicitly (Remotion and Chrome use
// the process temp folder, never /tmp, which is shared on the founder's machine).

/** The repository root: the folder that holds packages/pipeline (the web app runs in apps/web). */
export function projectRoot(start: string = process.cwd()): string {
  let dir = path.resolve(/*turbopackIgnore: true*/ start);
  for (;;) {
    if (existsSync(path.join(/*turbopackIgnore: true*/ dir, "packages", "pipeline", "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Couldn't find the project folder (packages/pipeline) from the current folder.");
    dir = parent;
  }
}

/** True when `dir` is inside `root` (not the root itself). */
export function isInside(root: string, dir: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The F22b MUST: before the first render the process temp folder must be inside the project. If
 * TMPDIR points anywhere else (or isn't set, so the OS default /tmp would be used), it is set to
 * <project>/runs/.tmp for this process (os.tmpdir() reads it on every call). Returns the folder.
 */
export function ensureProjectTmp(root: string, env: NodeJS.ProcessEnv = process.env): { tmp: string; changed: boolean } {
  const tmp = path.join(root, "runs", ".tmp");
  mkdirSync(tmp, { recursive: true });
  if (isInside(root, os.tmpdir())) return { tmp: os.tmpdir(), changed: false };
  env.TMPDIR = tmp;
  return { tmp, changed: true };
}

export interface RenderRun {
  result: Promise<RenderJobResult>;
  cancel: () => void;
}

const CANCEL_GRACE_MS = 20_000;
/** A render that takes longer than this is stopped (about 2–4 min is normal). */
export const RENDER_MAX_MS = 20 * 60_000;

export function startRenderProcess(spec: RenderJobSpec, options: { root: string; tmp: string; onProgress: (phase: RenderPhase, percent: number) => void; maxMs?: number }): RenderRun {
  const script = path.join(options.root, "packages", "pipeline", "src", "pipeline", "render-child.ts");
  const loader = path.join(options.root, "node_modules", "tsx", "dist", "loader.mjs");
  if (!existsSync(script) || !existsSync(loader)) {
    return { result: Promise.resolve({ status: "failed", stage: "render", detail: "the render program or tsx was not found in the project" }), cancel: () => undefined };
  }
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: options.tmp };
  delete env.NODE_OPTIONS; // the web server's own Node flags are not for the renderer
  // turbopackIgnore: the script is a separate program run with tsx, never part of the server bundle.
  const child = fork(/*turbopackIgnore: true*/ script, [], {
    cwd: options.root,
    env,
    execArgv: ["--import", pathToFileURL(loader).href],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    serialization: "advanced",
  });
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const result = new Promise<RenderJobResult>((resolve) => {
    let settled: RenderJobResult | null = null;
    const deadline = setTimeout(() => {
      settled ??= { status: "failed", stage: "render", detail: `the render took longer than ${Math.round((options.maxMs ?? RENDER_MAX_MS) / 60_000)} minutes and was stopped` };
      kill();
    }, options.maxMs ?? RENDER_MAX_MS);
    child.on("message", (message: RenderChildMessage) => {
      if (message?.type === "progress") options.onProgress(message.phase, message.percent);
      else if (message?.type === "result") settled = message.result;
    });
    child.on("error", (error) => {
      settled ??= { status: "failed", stage: "render", detail: `the render process couldn't start: ${error.message}` };
    });
    child.on("exit", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      if (settled) return resolve(settled);
      resolve(cancelled ? { status: "cancelled" } : { status: "failed", stage: "render", detail: `the render process stopped without an answer (code ${code}, signal ${signal})` });
    });
  });
  const startMessage: RenderParentMessage = { type: "start", spec };
  child.send(startMessage);
  return {
    result,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      if (child.connected) child.send({ type: "cancel" } satisfies RenderParentMessage);
      killTimer = setTimeout(kill, CANCEL_GRACE_MS);
    },
  };
}
