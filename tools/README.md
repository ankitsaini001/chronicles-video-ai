# tools

Developer tools.

- `cli/`: the prototype command-line tool, run with `npm run pipeline -- <command>` (see the root README for the commands). It uses the AI engine through `@bytereel/pipeline/...` imports.
- `video/` (F22b): review tools for the video engine. Free and local (no Gemini or ElevenLabs, nothing downloaded); temporary files stay inside the project.
  - `npm run video:rerender -- --run <runDir> --out <file.mp4> [--sheet <file.png>]`: re-render a recorded run in the current style with its recorded narration (same frames as the original). `--fixture <plan.json>` renders a fixture plan instead (silent, synthetic timing); `--stills 30,470` or `--frames 0-599` for quick looks and benchmarks.
  - `npm run video:heroes -- --out <folder> [--names sun,cloud] [--frames 10,40]`: the hero object library as stills (12 per page).
  - `python3 tools/video/contact_sheet.py <video.mp4> <sheet.png>`: 18 frames of a video in a grid with their times (uses Remotion's ffmpeg and Pillow).
- `project-tmp.ts`: imported first by `cli/index.ts` and the `video/` tools. It points the process temp folder (TMPDIR) at the git-ignored `runs/.tmp`, so Remotion, Chrome and our own temporary files never go to the system temp folder (`/tmp` is shared on the founder's machine).

**Temporary files never go to `/tmp`.** Start tools through their npm scripts (`npm run pipeline`, `npm run video:rerender`, `npm run video:heroes`, `npm test`, ...): each sets `TMPDIR=<project>/runs/.tmp` before starting, which also keeps the tsx and Node compile caches inside the project. If you must start a script by hand, set it yourself first: `mkdir -p runs/.tmp && TMPDIR="$PWD/runs/.tmp" npx tsx <script>`.
