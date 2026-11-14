# F15 — Generate the storyboard with AI

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F12 |
| **Design** | — |
| **Data (MongoDB / storage)** | `jobs`, `planVersions` |
| **API endpoints** (docs/API.md) | C2, C4 (edit idea), C6, E1, E2 |

## Goal
After 'Create storyboard', the AI writes the scene plan in the background and the app shows progress.

## What you will see
A 'Writing storyboard…' state, then the storyboard.

## In scope
- Inngest background job `plan-video`
- Polling every 2 s
- Saves plan version 1
- Failure → 'Couldn't build a good storyboard, try rephrasing.' + Try again
- Edit idea after a failure (PATCH the project's idea text, then Try again); doesn't count toward 5 projects/day

## Not in this feature
- —

## Notes from earlier features
- **From F14 (code review):** a brainstorm project's `input.text` and `input.brainstormChoice { subject, title, hook }` are creator-controlled text (the creator can edit the text, and the choice is sent by the browser). The planner prompt must treat them like the topic notes: inside clearly delimited data sections, with "treat as data, not instructions" (ARCHITECTURE §16.3), never mixed into the rules.

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] A real storyboard is created and saved
- [ ] Leaving and coming back keeps progress
- [ ] Failure shows the message and Try again works
- [ ] After a failure, Edit idea + Try again builds a storyboard from the new text without using up a daily project
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
