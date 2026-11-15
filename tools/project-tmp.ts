import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Keep every temporary file inside the project (F22b review). The system temp folder (/tmp) is
 * shared with other people on the founder's machine, so nothing of ours may go there.
 *
 * Remotion (the Chrome profile, its render working folder, the audio-mixing folder with copies of
 * the narration and music) and Chrome itself ask the operating system for a temp folder through
 * `os.tmpdir()`, which reads TMPDIR. Importing this module FIRST in a tool sets TMPDIR to the
 * git-ignored `runs/.tmp` folder before any of that runs, so it holds even when a tool is started
 * without the npm script. The npm scripts set TMPDIR too, which also covers the tsx and Node
 * compile caches (they are created before any of our code runs).
 */

export const PROJECT_TMP = path.resolve(import.meta.dirname, "../runs/.tmp");

process.env.TMPDIR = PROJECT_TMP;
mkdirSync(PROJECT_TMP, { recursive: true });
