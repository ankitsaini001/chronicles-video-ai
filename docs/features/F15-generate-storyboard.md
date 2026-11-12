# F15 — Generate the storyboard with AI

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F12 |
| **Design** | — |
| **Data (MongoDB / storage)** | `jobs`, `planVersions` |
| **API endpoints** (docs/API.md) | C2, C6, E1, E2 |

## Goal
After 'Create storyboard', the AI writes the scene plan in the background and the app shows progress.

## What you will see
A 'Writing storyboard…' state, then the storyboard.

## In scope
- Inngest background job `plan-video`
- Polling every 2 s
- Saves plan version 1
- Failure → 'Couldn't build a good storyboard, try rephrasing.' + Try again

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] A real storyboard is created and saved
- [ ] Leaving and coming back keeps progress
- [ ] Failure shows the message and Try again works
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
