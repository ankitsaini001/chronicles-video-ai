# F30 — Publish now (approval #2) + Published screen

| | |
|---|---|
| **Status** | 🔨 Building (plan approved 2026-11-25; built with the stand-in Instagram, waiting for code review and the founder's real post) |
| **Phase** | A5 · Instagram publishing |
| **Depends on** | F29 |
| **Design** | Stitch: ByteReel — Step 4 Publish, ByteReel — Published |
| **Data (MongoDB / storage)** | `posts` |
| **API endpoints** (docs/API.md) | H2, H3, H4, H6 |

## MUST from F16–F20 (code review, 2026-11-14)
- [x] **Add the post approval invalidation to every storyboard change and re-allow the two states.** Until F30, D3 (narration edit), D4 (voice), D5 (revision) and D7 (undo/restore) are refused with `409 INVALID_STATE` while the project is `scheduled` or `publish_failed` (`STORYBOARD_EDIT_STATES` in `packages/db/src/projects.ts`). F30 MUST, in the same transaction as each change, move a `scheduled`/`publish_failed` post to `approval_invalidated` and create the `approval_invalidated` notification (API.md §9, DATABASE.md §7.2 rows 3–5), then add `scheduled` and `publish_failed` back to `STORYBOARD_EDIT_STATES`, with tests. *(Done 2026-11-25: `invalidateOpenPosts` in D3, D4, D5, D7, F4, H7, G3, G4; unit tests for D7 and G4, e2e for D3, H7, G4 and C5.)*

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
- **Decision to make (from the F29 code review, 2026-11-24):** Caption edits after approval: H7 does not bump stateVersion, so F30 must either set the post to approval_invalidated and notify, inside the same transaction, when the saved text's NFC hash differs from posts.approval.captionHash, or refuse H7 while a live post exists (PRD §7: any caption edit invalidates the approval). Also: H7 and H1 only save while the project is `video_ready` today; F30 decides which publish states (`scheduled`, `publish_failed`) may edit the caption. *(Decided: decision 1 below.)*

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
8. **Code review (2026-11-26), option A: "an unconfirmed attempt blocks every new approval".** If `media_publish` was sent but never confirmed, the reel may be live. While such a post exists (any state: failed, approval cancelled by a change, archived), Publish now (H2) is refused with "We're still checking whether your last post went live. Tap Check again first." The page offers only **Check again** (H6 in a read-only mode). It looks at Instagram with the approved account's token, then either saves the post as published, or proves it wasn't posted and lets the creator approve again. It never posts. Also from the review: connecting a different Instagram account is refused while a post is being published; the job's reconcile reads with the approved account's token; failure reasons on screen are always the fixed plain lines; reconcile only accepts media from 60 s before the first publish onwards; the approval tick is cleared when the video or account changes and after any refused Publish.

**How it works (as approved):** the approval locks the exact file (`mp4Sha256`), the account (`connectionId` + `igUserId`), the caption (`captionHash`) and the time; the background `publish` job (Inngest, stages approve → create_container → poll → publish, + reconcile) re-checks all of it right before creating the container and before publishing; Meta fetches the video through a private R2 presigned GET link (about 1 hour); Meta's flow: create REELS container → poll `status_code` → `media_publish` → permalink.

**As built:** API.md "As built (F30)" (after H6), DATABASE.md "As built (F30)" (after 4.23), ARCHITECTURE.md §17.4 "As built (F30)". Differences from the plan: no `content_publishing_limit` call before posting (the limit is read from `media_publish`'s refusal); reconcile is a step of the same run, not a separate function.

## Steps
- [x] 1. Database: `posts` (approval snapshot, `publishKey`), publish job, indexes
- [x] 2. Server: H2, H3, H4, H6, the publish job with re-checks and reconcile; the approval-cancel rules in D3, D4, D5, D7, F4, H7, G3, G4, C5
- [x] 3. Screens: WHEN, approval tick, Publish now, progress, failed + Try again, Published (phone + desktop)
- [x] 4. Tests: unit + e2e with the stand-in Instagram (success, processing error, lost connection after publish → no duplicate, approval cancelled by a change, Try again)
- [ ] 5. Docs, code review + fixes *(docs done 2026-11-25; review fixes applied 2026-11-26, waiting for the re-check)*
- [ ] 6. Founder: one real Reel to Instagram (no voice, no video of the day, no AI)

## How we test it (done when all are ticked)
- [ ] Reel appears on Instagram
- [ ] Changing the caption after approval asks to approve again *(passes with the stand-in; tick after the founder sees it)*
- [ ] Retry never creates a duplicate *(passes with the stand-in; tick after the founder sees it)*
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

**Before the founder's real post:** apply the F30 indexes once: `npm run db -- indexes --feature F30 --apply` (the two unique ones are part of "never posts twice").

## Progress log
| Date | What happened |
|---|---|
| 2026-11-25 | Plan approved by the founder (decisions 1–7); building with the stand-in Instagram. |
| 2026-11-25 | Steps 1–3 built: `posts` + publish job + indexes; H2/H3/H4/H6, the `publish-post` job (re-check before the container and before `media_publish`, claimed publish, `outcome_unknown` → reconcile, ~10 min of automatic retries), the approval-cancel rules; Step 4 publish form, progress / failed / Published screens. |
| 2026-11-25 | Step 4 tests: `tests/publish.test.ts` (48: H2 body, caption hash, publish key, Meta client with a fake fetch, the job with a fake store: success, slow, busy, ERROR, EXPIRED, daily limit, change during processing, lost answer → reconcile, Try again after an unknown outcome); older tests updated for F30 (G4, D7, allowedActions, H1 count in `publish_failed`). Full suite 1,259/1,259. E2e with the stand-in Instagram and a private Inngest: `tools/e2e/f30-publish.ts` 47/47 (ONE reel per approval in every case, incl. the lost answer and Try again after the daily limit); F28 43/43 and F29 33/33 (updated for the publish form); F26 64/64. Typecheck and `next build` pass. Zero Meta, Gemini or ElevenLabs calls. |
| 2026-11-25 | Found during the F26 run: Remotion's render server took the first free port from 3000 (the founder's dev site). Fixed: `REMOTION_SERVE_PORT` (default 3200; 3000 and 8288 refused) is passed to every Remotion call; the e2e scripts that render require 3240–3249. |
| 2026-11-25 | Step 5 docs: API.md, openapi.yaml, DATABASE.md, ARCHITECTURE.md "As built (F30)", tracker. Next: code review, then the founder's one real Reel. |
| 2026-11-26 | Code review fixes (decision 8). MUST 1: H2 refused (`retry_instead`) while any post of the project is unconfirmed; `allowedActions` → `retry_post`; H6 Check again mode (reads only: published, not_posted or unknown); the page's Check again view. MUST 2: PublishForm remounts on another video/account (`key`), unticks after a refused Publish, Idempotency-Key made before the caption save and dropped on caption change. SHOULD 3: plain stage errors only. SHOULD 4: G3 to another account refused while a post is in flight (`INSTAGRAM_BUSY`); reconcile reads with any working token for `approval.igUserId`. Nits: concurrency comment, `publishKey` wording, H7 state read inside the transaction, reconcile window = first send − 60 s (`firstPublishAttemptedAt`). Tests: full suite 1,274/1,274; F30 e2e 56/56 (new: lost answer + caption edit + narration edit → H2 refused → Check again finds the live reel, still one reel; dropped answer → Check again proves not posted → approve again posts exactly once; G3 refused in flight); F28 43/43; F29 33/33; typecheck and `next build` pass. F26 not re-run (no render or revision code changed). Also fixed a misplaced test timeout in `tests/generate-video.test.ts` (commit 905a74d) that broke the typecheck. |
