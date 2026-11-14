# F30 — Publish now (approval #2) + Published screen

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A5 · Instagram publishing |
| **Depends on** | F29 |
| **Design** | Stitch: ByteReel — Step 4 Publish, ByteReel — Published |
| **Data (MongoDB / storage)** | `posts` |
| **API endpoints** (docs/API.md) | H2, H3, H4, H6 |

## MUST from F16–F20 (code review, 2026-11-14)
- [ ] **Add the post approval invalidation to every storyboard change and re-allow the two states.** Until F30, D3 (narration edit), D4 (voice), D5 (revision) and D7 (undo/restore) are refused with `409 INVALID_STATE` while the project is `scheduled` or `publish_failed` (`STORYBOARD_EDIT_STATES` in `packages/db/src/projects.ts`). F30 MUST, in the same transaction as each change, move a `scheduled`/`publish_failed` post to `approval_invalidated` and create the `approval_invalidated` notification (API.md §9, DATABASE.md §7.2 rows 3–5), then add `scheduled` and `publish_failed` back to `STORYBOARD_EDIT_STATES`, with tests.

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
