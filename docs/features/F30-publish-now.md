# F30 — Publish now (approval #2) + Published screen

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A5 · Instagram publishing |
| **Depends on** | F29 |
| **Design** | Stitch: ByteReel — Step 4 Publish, ByteReel — Published |
| **Data (MongoDB / storage)** | `posts` |
| **API endpoints** (docs/API.md) | H2, H3, H4, H6 |

## Goal
Approve the exact video and account, then publish; show the live post or a clear failure with Retry.

## What you will see
'ByteReel — Step 4 Publish' and 'ByteReel — Published'.

## In scope
- Approval checkbox for the exact video version + account
- Publish now
- Re-check approval right before posting
- Never posts twice
- Retry on failure

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Reel appears on Instagram
- [ ] Changing the caption after approval asks to approve again
- [ ] Retry never creates a duplicate
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
