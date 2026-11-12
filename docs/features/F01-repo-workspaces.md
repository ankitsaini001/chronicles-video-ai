# F01 — Repo setup: npm workspaces + move prototype code

| | |
|---|---|
| **Status** | 🔄 In progress |
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
- [ ] Move `src/video` to `packages/video`
- [ ] Fix import paths
- [ ] Run tests + typecheck, compare with baseline
- [ ] Founder check

## How we test it (done when all are ticked)
- [ ] `npm test` → all existing tests pass (same count as before)
- [ ] `npm run typecheck` passes
- [ ] The prototype CLI still runs a fixture storyboard
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-12 | Started on branch `dev`. **Baseline:** 16 test files / 185 tests pass; typecheck clean; `fixture --file fixtures/water-cycle.plan.json` → valid, 6 scenes, 204 words, ≈81.6 s, plan hash `sha256:040c4f3b…23fc`. |
| 2026-11-12 | Step 2: root `package.json` now has `"workspaces": ["packages/*"]`; created `packages/pipeline` (`@bytereel/pipeline`) and `packages/video` (`@bytereel/video`) with their own package.json (empty, no code yet); placeholder READMEs in `apps/web` (filled in F02) and `tools`. `apps/*` is added to workspaces in F02, when the web app gets its package.json. `npm install` linked both packages. Re-check: 185/185 tests, typecheck clean, fixture identical (same hash). |
| 2026-11-12 | Step 3: `git mv` of `src/{contracts,planning,providers,timing,validation,pipeline,storage,config,shared}` → `packages/pipeline/src/` (56 files, history kept) and `src/video/theme.ts` → `packages/pipeline/src/theme.ts` (pure constants; removes the only pipeline→video code import). Fixed `timing/compile.ts` (`../theme`) and `pipeline/render.ts` `VIDEO_ENTRY` (file path to `src/video/index.ts`, updated again in step 4). 41 files in `src/video`, `src/cli`, `tests` had import paths rewritten by a script (imports only, 103 lines). Long `../../packages/pipeline/src/...` paths are temporary until steps 4–5. `tsconfig.json` now includes `packages`. Re-check: 185/185 tests, typecheck clean, fixture identical. |
