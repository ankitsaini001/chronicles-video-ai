import { fork } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { killProcessGroup, killProcessTree } from "@bytereel/pipeline/pipeline/process-tree";
import type { RenderChildMessage, RenderJobResult, RenderJobSpec, RenderParentMessage, RenderPhase } from "@bytereel/pipeline/pipeline/render-protocol";

// Rendering on this computer (F23, founder 2026-11-15; Vercel Sandbox is decided at go-live, F38):
// the generate worker starts packages/pipeline/src/pipeline/render-child.ts in its own Node process
// (with tsx), hands it the job over Node's IPC channel, relays its progress, and can cancel it.
// - Stopping (Cancel, or the 20-minute limit): a "cancel" message first (Remotion's cancel signal);
//   if it hasn't stopped within 20 s, its whole process tree is killed: the child (detached, so it
//   leads its own group, with ffmpeg in it) and everything below it, including Chrome, which puts
//   itself in a group of its own (killProcessTree). Once the child has exited, Cancel does nothing
//   and only its process group is killed (never its process ID, which the system may reuse).
// - The result resolves exactly once, when the process is gone (exit) or can't be used (error).
// - Environment: only what rendering needs (renderChildEnv): no database, voice, storage, login or
//   AI secrets reach the child or Chrome.
// - Temporary files: the child gets TMPDIR=<the job's work folder>/tmp explicitly (Remotion and Chrome
//   use the process temp folder, never /tmp, which is shared on the founder's machine).

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

/** After "cancel", how long the render may take to stop before its process group is killed. */
export const CANCEL_GRACE_MS = 20_000;
/** A render that takes longer than this is stopped (about 2–4 min is normal). */
export const RENDER_MAX_MS = 20 * 60_000;

/** The only environment variables the render child (and Chrome, ffmpeg) get, besides TMPDIR. */
const CHILD_ENV_NAMES = ["PATH", "HOME", "NODE_ENV", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;
const CHILD_ENV_PREFIXES = ["REMOTION_"] as const;

/**
 * The render child's environment: an allowlist (PATH, HOME, NODE_ENV, the locale, TZ, REMOTION_*)
 * plus its own TMPDIR. Nothing else: the database, ElevenLabs, R2, login and Gemini secrets stay in
 * the web server.
 */
export function renderChildEnv(env: NodeJS.ProcessEnv, tmp: string): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((CHILD_ENV_NAMES as readonly string[]).includes(name) || CHILD_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) out[name] = value;
  }
  out.TMPDIR = tmp;
  return out as NodeJS.ProcessEnv;
}

export function startRenderProcess(
  spec: RenderJobSpec,
  options: { root: string; tmp: string; onProgress: (phase: RenderPhase, percent: number) => void; maxMs?: number; graceMs?: number },
): RenderRun {
  const script = path.join(options.root, "packages", "pipeline", "src", "pipeline", "render-child.ts");
  const loader = path.join(options.root, "node_modules", "tsx", "dist", "loader.mjs");
  if (!existsSync(script) || !existsSync(loader)) {
    return { result: Promise.resolve({ status: "failed", stage: "render", detail: "the render program or tsx was not found in the project" }), cancel: () => undefined };
  }
  const maxMs = options.maxMs ?? RENDER_MAX_MS;
  const graceMs = options.graceMs ?? CANCEL_GRACE_MS;
  // turbopackIgnore: the script is a separate program run with tsx, never part of the server bundle.
  // detached: the child leads its own process group (killed with everything below it when stopping).
  const child = fork(/*turbopackIgnore: true*/ script, [], {
    cwd: options.root,
    env: renderChildEnv(process.env, options.tmp),
    execArgv: ["--import", pathToFileURL(loader).href],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    serialization: "advanced",
    detached: true,
  });
  let stopping: "cancelled" | "timed-out" | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  /** The child process is gone (Node reaped it: its process ID may already belong to another process). */
  let exited = false;
  /** The result was answered (the render is over). */
  let done = false;
  /**
   * While the child runs: kill it, everything below it (Chrome, ffmpeg) and their process groups.
   * After it exited: only its process group (what it left running), never its bare process ID.
   */
  const killGroup = () => {
    if (child.pid === undefined) return;
    if (exited) killProcessGroup(child.pid);
    else killProcessTree(child.pid);
  };
  /** Ask the renderer to stop (Remotion's cancel signal); kill its group if it hasn't stopped in time. */
  const stop = (why: "cancelled" | "timed-out") => {
    // Already stopping, or the render is over (a late Cancel from a progress write): nothing to stop.
    if (stopping || done || exited) return;
    stopping = why;
    if (child.connected) {
      try {
        child.send({ type: "cancel" } satisfies RenderParentMessage);
      } catch {
        // the channel just closed: the kill below still runs
      }
    }
    killTimer = setTimeout(killGroup, graceMs);
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<RenderJobResult>((resolve) => {
    let answer: RenderJobResult | null = null;
    const finish = (value: RenderJobResult) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      resolve(value);
    };
    deadline = setTimeout(() => stop("timed-out"), maxMs);
    child.on("message", (message: RenderChildMessage) => {
      if (message?.type === "progress") options.onProgress(message.phase, message.percent);
      else if (message?.type === "result") answer = message.result;
    });
    // The process couldn't start, or can't be talked to any more: stop it and its group, and answer now.
    child.on("error", (error) => {
      killGroup();
      finish(stopping === "cancelled" ? { status: "cancelled" } : { status: "failed", stage: "render", detail: `the render process failed: ${error.message}` });
    });
    child.on("exit", (code, signal) => {
      exited = true;
      clearTimeout(killTimer); // a pending kill would hit a process ID that may be reused
      killGroup(); // only its process group: anything it left running there (ffmpeg)
      if (stopping === "timed-out") return finish({ status: "failed", stage: "render", detail: `the render took longer than ${Math.round(maxMs / 60_000)} minutes and was stopped` });
      if (answer) return finish(answer);
      finish(stopping === "cancelled" ? { status: "cancelled" } : { status: "failed", stage: "render", detail: `the render process stopped without an answer (code ${code}, signal ${signal})` });
    });
  });
  const startMessage: RenderParentMessage = { type: "start", spec };
  child.send(startMessage, (error) => {
    if (error) child.emit("error", error);
  });
  return { result, cancel: () => stop("cancelled") };
}
