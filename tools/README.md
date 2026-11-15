# tools

Developer tools.

- `cli/`: the prototype command-line tool, run with `npm run pipeline -- <command>` (see the root README for the commands). It uses the AI engine through `@bytereel/pipeline/...` imports.
- `video/` (F22b): review tools for the video engine. Free and local (no Gemini or ElevenLabs, nothing downloaded); temporary files stay inside the project.
  - `npx tsx tools/video/rerender-run.ts --run <runDir> --out <file.mp4> [--sheet <file.png>]`: re-render a recorded run in the current style with its recorded narration (same frames as the original). `--fixture <plan.json>` renders a fixture plan instead (silent, synthetic timing); `--stills 30,470` or `--frames 0-599` for quick looks and benchmarks.
  - `npx tsx tools/video/hero-gallery.ts --out <folder> [--names sun,cloud] [--frames 10,40]`: the hero object library as stills (12 per page).
  - `python3 tools/video/contact_sheet.py <video.mp4> <sheet.png>`: 18 frames of a video in a grid with their times (uses Remotion's ffmpeg and Pillow).
