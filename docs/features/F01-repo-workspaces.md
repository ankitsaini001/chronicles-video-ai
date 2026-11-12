# F01 — Repo setup: npm workspaces + move prototype code

| | |
|---|---|
| **Status** | ✅ Done |
| **Phase** | A1 · Foundation (project setup) |
| **Depends on** | — |
| **Design** | — |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | — |

## Goal
Organise the repo the way ARCHITECTURE §6 describes, without changing how the prototype works.

## What you will see
Nothing new on screen. The prototype CLI and all existing tests still work.

## In scope
- Create `apps/` and `packages/` folders with npm workspaces
- Move prototype code into `packages/pipeline` and `packages/video` (no behaviour change)
- Keep the CLI working from `tools/`

## Not in this feature
- Any new app code
- Changing pipeline behaviour

## Steps
- [x] Note the current test count (baseline)
- [x] Add workspaces to the root package.json
- [x] Move `src/` pipeline files to `packages/pipeline`
- [x] Move `src/video` to `packages/video`
- [x] Fix import paths (+ move the CLI from `src/cli` to `tools/cli`)
- [x] Run tests + typecheck, compare with baseline
- [x] Founder check

## How we test it (done when all are ticked)
- [x] `npm test` → all existing tests pass (same count as before; +1 new guard test = 186)
- [x] `npm run typecheck` passes
- [x] The prototype CLI still runs a fixture storyboard
- [x] Code review passed (code-reviewer agent)
- [x] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-12 | Started on branch `dev`. **Baseline:** 16 test files / 185 tests pass; typecheck clean; `fixture --file fixtures/water-cycle.plan.json` → valid, 6 scenes, 204 words, ≈81.6 s, plan hash `sha256:040c4f3b…23fc`. |
| 2026-11-12 | Step 2: root `package.json` now has `"workspaces": ["packages/*"]`; created `packages/pipeline` (`@bytereel/pipeline`) and `packages/video` (`@bytereel/video`) with their own package.json (empty, no code yet); placeholder READMEs in `apps/web` (filled in F02) and `tools`. `apps/*` is added to workspaces in F02, when the web app gets its package.json. `npm install` linked both packages. Re-check: 185/185 tests, typecheck clean, fixture identical (same hash). |
| 2026-11-12 | Step 3: `git mv` of `src/{contracts,planning,providers,timing,validation,pipeline,storage,config,shared}` → `packages/pipeline/src/` (56 files, history kept) and `src/video/theme.ts` → `packages/pipeline/src/theme.ts` (pure constants; removes the only pipeline→video code import). Fixed `timing/compile.ts` (`../theme`) and `pipeline/render.ts` `VIDEO_ENTRY` (file path to `src/video/index.ts`, updated again in step 4). 41 files in `src/video`, `src/cli`, `tests` had import paths rewritten by a script (imports only, 103 lines). Long `../../packages/pipeline/src/...` paths are temporary until steps 4–5. `tsconfig.json` now includes `packages`. Re-check: 185/185 tests, typecheck clean, fixture identical. |
| 2026-11-12 | Step 4: `git mv src/video packages/video/src` (21 files). Video now imports the AI engine by package name (`@bytereel/pipeline/contracts`, `/theme`, `/timing`, `/planning/icon-catalog`), declared in `packages/pipeline/package.json` `exports`; `@bytereel/video` depends on `@bytereel/pipeline`. `render.ts` VIDEO_ENTRY → `packages/video/src/index.ts`; `npm run studio` path updated. **Issue found + fixed:** the first real render failed ("React is not defined") because Remotion uses the nearest package.json folder (now `packages/video`) as its root and reads `tsconfig.json` there raw → added `packages/video/tsconfig.json` (jsx react-jsx; esbuild ignores `extends`, so jsx/strict/verbatimModuleSyntax are repeated) and cleared the stale cache `packages/video/node_modules/.cache`. **Render check:** `render-fixture --force` passes all MP4 checks (1080×1920, 30 fps, 2,555 frames, 85.2 s). Compared with a render of the original commit 7de6352 in a temp worktree: timeline.json, captions.json, plan.json and all 6 preview PNGs are byte-identical; 17/18 sampled video frames identical. The frame at 30 s also differs between two renders of the *original* code (renderer non-determinism, not caused by the move) — note for F23: MP4 bytes are not reproducible run to run. Tests 185/185, typecheck clean. |
| 2026-11-12 | Step 5: `git mv src/cli tools/cli` (7 files); `src/` removed. CLI imports `@bytereel/pipeline/{config/config,contracts,pipeline,pipeline/render-fixture,planning,providers,storage}` (added to exports). `npm run pipeline` → `tools/cli/index.ts`; 2 tests now import `../tools/cli/…`; tsconfig include = packages, tools, tests. Tests keep relative imports into `packages/pipeline/src` because they test internal modules. README: new "Repository layout" table + all `src/…` paths updated; `tools/README.md` updated. Re-check: 185/185 tests, typecheck clean, `fixture` same hash, `render-fixture --force` via the moved CLI → timeline/captions/plan + 6 preview PNGs identical to step 4. |
| 2026-11-12 | **Code review: passed, no blocking issues** (code-reviewer agent). Confirmed: no logic changed; package-name and relative imports load the same module (no duplicate instances); the video tsconfig is required. Fixed from the review: (1) new test `tests/video-entry.test.ts` guards the `VIDEO_ENTRY` file path; (2) stale `src/…` paths updated in docs/API.md, docs/openapi.yaml, fixtures/README.md and 3 code comments; (4) `target: ES2023` added to `packages/video/tsconfig.json` (esbuild reads it); (5) `npm run studio` checked: builds and serves. Re-render after the tsconfig change: 9/9 outputs identical. Tests now 186/186 (17 files; +1 new guard test). Review item 3 (Next.js setup notes) moved into F02. Item 6 (export names like `./config/config`) left as is: cosmetic. ARCHITECTURE/PIPELINE_DESIGN keep their historical prototype paths. |
| 2026-11-12 | Founder ran `npm test` (17 files, 186 passed) and approved. **F01 ✅ Done.** Pushed to `dev`. |
