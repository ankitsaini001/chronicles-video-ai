import { execFileSync } from "node:child_process";

/**
 * Stopping a render for good (F23, code review): the render child process starts Chrome, which puts
 * itself in its OWN process group (puppeteer starts it detached), and ffmpeg. Killing only the child,
 * or only the child's process group, can leave Chrome running. So the whole tree is found first
 * (with `ps`, on Linux and macOS) and every process in it, and every process group they lead, is
 * killed. Never the caller's own process group. Without `ps`, only `root`'s group and `root` go.
 * Used by the web app's worker (apps/web/lib/video/render-process.ts) and by the render child itself.
 */

type Row = { pid: number; ppid: number; pgid: number };

function processTable(): Row[] | null {
  let out: string;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((parts) => parts.length === 3 && parts.every((n) => Number.isInteger(n) && n > 0))
    .map(([pid, ppid, pgid]) => ({ pid: pid!, ppid: ppid!, pgid: pgid! }));
}

/** Every process below `root` (children, grandchildren…), with their process groups. */
export function descendantsOf(root: number, table: Row[] | null = processTable()): Row[] {
  if (!table) return [];
  const byParent = new Map<number, Row[]>();
  for (const row of table) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const found: Row[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const row of byParent.get(queue.shift()!) ?? []) {
      if (row.pid === root || found.some((f) => f.pid === row.pid)) continue;
      found.push(row);
      queue.push(row.pid);
    }
  }
  return found;
}

/** The caller's own process group (from `ps`), or null when it can't be read. */
export function ownProcessGroup(table: Row[] | null = processTable()): number | null {
  return table?.find((row) => row.pid === process.pid)?.pgid ?? null;
}

/**
 * SIGKILL one process group only: for a render child that has already EXITED. Its bare process ID
 * may already belong to another process (Node reaped it), so it is never killed by ID; its group
 * (what it left running, e.g. ffmpeg) is. Never the caller's own group, never 0 or 1. True = sent.
 */
export function killProcessGroup(group: number, ownGroup: number | null = ownProcessGroup()): boolean {
  if (!Number.isInteger(group) || group <= 1 || group === ownGroup) return false;
  try {
    process.kill(-group, "SIGKILL");
    return true;
  } catch {
    return false; // that group is already gone
  }
}

/** SIGKILL `root`, everything below it and the process groups they lead (never the caller's group). Only while `root` is alive. */
export function killProcessTree(root: number): void {
  const table = processTable();
  const below = descendantsOf(root, table);
  const ownGroup = ownProcessGroup(table);
  const groups = new Set([root, ...below.map((row) => row.pgid)]);
  for (const group of groups) {
    if (group <= 1 || group === ownGroup) continue;
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // that group is already gone
    }
  }
  for (const pid of [...below.map((row) => row.pid), root]) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
