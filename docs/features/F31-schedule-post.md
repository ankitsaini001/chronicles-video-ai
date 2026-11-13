# F31 — Schedule a post

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A5 · Instagram publishing |
| **Depends on** | F30 |
| **Design** | — |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | H2, H5 |

## Goal
Pick a date/time (IST) to publish later; cancel if needed.

## What you will see
'Schedule' option on the Publish screen; Scheduled tab.

## In scope
- Schedule
- Cancel
- Any change resets the approval immediately when it is requested (revision, narration edit, voice switch, undo, caption fix), not when its job finishes; the post goes back to "needs approval" and the creator is told

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Scheduled reel posts at the right time
- [ ] Cancel stops it
- [ ] Asking for a revision (or editing narration/voice/captions) on a scheduled project at once shows the post as "needs approval" with a notification
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
