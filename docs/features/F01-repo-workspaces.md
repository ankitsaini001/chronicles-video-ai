# F01 — Repo setup: npm workspaces + move prototype code

| | |
|---|---|
| **Status** | ⬜ Not started |
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
- [ ] Note the current test count (baseline)
- [ ] Add workspaces to the root package.json
- [ ] Move `src/` pipeline files to `packages/pipeline`
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
| | |
