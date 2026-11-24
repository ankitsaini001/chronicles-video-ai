# F30 — Publish now (approval #2) + Published screen

| | |
|---|---|
| **Status** | 🔨 Building (plan approved 2026-11-25) |
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
- **Decision to make (from the F29 code review, 2026-11-24):** Caption edits after approval: H7 does not bump stateVersion, so F30 must either set the post to approval_invalidated and notify, inside the same transaction, when the saved text's NFC hash differs from posts.approval.captionHash, or refuse H7 while a live post exists (PRD §7: any caption edit invalidates the approval). Also: H7 and H1 only save while the project is `video_ready` today; F30 decides which publish states (`scheduled`, `publish_failed`) may edit the caption.

## Not in this feature
- Scheduling (F31: "Schedule" shows greyed out, "coming soon")
- Waiting out Instagram's daily posting limit automatically (F31; F30 shows the plain message + Try again)
- The notifications bell (F32; F30 only saves the notifications)

## Decisions (founder, 2026-11-25; plan approved)
1. **Caption after approving:** stays editable; on a `publish_failed` post an edit (H7) whose NFC hash differs from `approval.captionHash` moves the post to `approval_invalidated` (+ notification) in the same update; **Try again** then becomes "approve and publish again" (a new H2). H1/H7 allowed in `video_ready` and `publish_failed`.
2. **Retries:** Meta hiccups (5xx, timeouts, container still processing) retried automatically for about 10 minutes, then `publish_failed` + **Try again** (H6). Daily limit (`PUBLISH_LIMIT_REACHED`) → plain message + Try again (no silent waiting in F30).
3. **Never twice:** an unknown outcome after `media_publish` → `outcome_unknown` → check the account's latest media before any new attempt (reconcile); `posts.publishKey` unique.
4. **Notifications** `post_published` / `post_failed` (and `approval_invalidated`) are saved now; the bell shows them in F32.
5. **The MUST above is part of F30:** D3, D4, D5, D7, F4, H7, G3 (other account), G4 move a `scheduled`/`publish_failed` post to `approval_invalidated` (+ notification) in the same transaction; `scheduled` and `publish_failed` are added back to `STORYBOARD_EDIT_STATES` (and F4's allowed states); archive (C5) cancels them and is refused while publishing.
6. **Screens:** Step 4 WHEN + approval tick + Publish now (Stitch "Step 4 Publish"), Published (Stitch "Published"); the publishing progress and failed views follow the video page's progress/failure style (no new Stitch round).
7. **Built now with the stand-in Instagram;** done only after F28 and F29 and the founder's one real test post.

**How it works (as approved):** the approval locks the exact file (`mp4Sha256`), the account (`connectionId` + `igUserId`), the caption (`captionHash`) and the time; the background `publish` job (Inngest, stages approve → create_container → poll → publish, + reconcile) re-checks all of it right before creating the container and before publishing; Meta fetches the video through a private R2 presigned GET link (about 1 hour); Meta's flow: create REELS container → poll `status_code` → `media_publish` → permalink.

## Steps
- [ ] 1. Database: `posts` (approval snapshot, `publishKey`), publish job, indexes
- [ ] 2. Server: H2, H3, H4, H6, the publish job with re-checks and reconcile; the approval-cancel rules in D3, D4, D5, D7, F4, H7, G3, G4, C5
- [ ] 3. Screens: WHEN, approval tick, Publish now, progress, failed + Try again, Published (phone + desktop)
- [ ] 4. Tests: unit + e2e with the stand-in Instagram (success, processing error, lost connection after publish → no duplicate, approval cancelled by a change, Try again)
- [ ] 5. Docs, code review + fixes
- [ ] 6. Founder: one real Reel to Instagram (no voice, no video of the day, no AI)

## How we test it (done when all are ticked)
- [ ] Reel appears on Instagram
- [ ] Changing the caption after approval asks to approve again
- [ ] Retry never creates a duplicate
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-25 | Plan approved by the founder (decisions 1–7); building with the stand-in Instagram. |
