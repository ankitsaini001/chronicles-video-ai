# F31 — Schedule a post

| | |
|---|---|
| **Status** | 🧪 Testing (built with the stand-in Instagram 2026-11-27; waiting for code review and the founder's test) |
| **Phase** | A5 · Instagram publishing |
| **Depends on** | F30 |
| **Design** | Stitch: ByteReel — Step 4 Schedule, Step 4 Post Scheduled, Step 4 Needs Approval (`docs/design/stitch/step4-schedule.html`, `step4-scheduled.html`, `step4-needs-approval.html`; screenshots `runs/f31-design/`) |
| **Data (MongoDB / storage)** | `posts` (`mode: scheduled`, `scheduledAt`), `jobs`. No new collection, field or index (`posts { state, scheduledAt }` already exists) |
| **API endpoints** (docs/API.md) | H2 (`mode: "scheduled"`), H5 |

## Goal
Pick a date/time (IST) to publish later; cancel if needed.

## What you will see
'Schedule' option on the Publish screen; the Scheduled view; Scheduled tab with the time on the card.

## In scope
- Schedule
- Cancel
- Any change resets the approval immediately when it is requested (revision, narration edit, voice switch, undo, caption fix), not when its job finishes; the post goes back to "needs approval" and the creator is told

## Not in this feature
- Waiting out Instagram's daily posting limit automatically (F30 listed it for F31): **deferred — recommended skip for V1, pending founder confirmation** (code review 2026-11-27). Until then the plain message + Try again.
- The notifications bell (F32; F31 only saves the notifications)
- Instagram token refresh (F32)

## Decisions (founder, 2026-11-26; plan and design approved)
1. **Window:** at least 10 minutes and at most **7 days** from now (API.md said 75 days; Inngest's free plan sleeps at most 7 days in one go, and 7 days stays well inside the 60-day Instagram token).
2. **Picker:** DATE + TIME in **India time (IST)**, **5-minute steps**. H2 receives `scheduledAt` as ISO with an offset (the page sends `+05:30`), stored in UTC. The server **refuses** a time off the 5-minute step (it never rounds), so the creator approves exactly the time that is posted.
3. **Missed:** if the job hasn't started publishing **1 hour** after the time, the post is never posted: `publish_failed` with `SCHEDULE_MISSED` (not retryable with Try again; Publish now or Schedule again is a new approval) + a notification. Found by the job when it wakes late, and at read time (like the stuck-job rule) when the job never woke. Up to 1 hour late it posts normally. No cron.
4. **Mechanism:** H2 Schedule saves the post `scheduled`, its job, project `scheduled`, and sends `post.publish.requested` at once; the publish job sleeps until the time (`step.sleepUntil`), then wakes: only while the post is still `scheduled` does it move to `publishing` (then the full F30 run with all its re-checks). Anything else → ends quietly, no Instagram call. `cancelOn: job.cancelled` for tidiness; the post's state is the real guard. The stuck-job rule never treats a sleeping scheduled job as stuck.
5. **H5 Cancel schedule** as in API.md (`scheduled` or `approval_invalidated` → `cancelled`; job cancelled + `job.cancelled`; project → `video_ready`; already cancelled → 200). Origin + session + owner, 10/hour (the `publish` counter), audit. Refused while publishing.
6. **Change time** = cancel (H5), then the schedule form again with the caption kept; the creator ticks the approval again (a new H2). No separate reschedule endpoint.
7. **Token expired at the time** → the F30 behaviour (`INSTAGRAM_TOKEN_EXPIRED`, Try again after reconnecting the same account keeps the approval). The approval-cancel rules (D3/D4/D5/D7/F4/H7/G3/G4/C5) already cover `scheduled` posts; approving again works in both modes.
8. **"Scheduling is coming soon"** removed.
9. **Design corrections:** the needs-approval badge says "Needs approval"; the Scheduled view's caption is plain read-only text; the Missed text is "This post was due at 7:00 PM IST but couldn't go out at that time. Publish now or pick a new time." (code review NICE 3: shown with the date too, "due at Sat 28 Nov, 7:00 PM IST"); times in IST everywhere ("Sat 28 Nov, 7:00 PM IST").

**How it works (as built):** API.md "As built (F31)" (after the F30 notes under H6), DATABASE.md "As built (F31)" (after 4.22), ARCHITECTURE.md §17.5, §20.3 and the `publish-post` row.
- **Built choices** (not in the decisions): a sleeping scheduled job is **not** the project's active job (`activeJobId` stays null), so every change stays allowed and cancels the approval at once; a change or archive also marks the waiting job `cancelled`; the caption box (H1/H7) is also editable while `scheduled` (needed by the Needs approval and Schedule-again forms; a different caption cancels a still-scheduled approval); `publish-post` now allows `finish: "8d"` (it was 1 hour, which counts the sleep); a start event is re-sent only when it was never handed over (the 2-minute re-send after the time was removed by the code review, MUST 1); the My videos card shows "Posts Sat 28 Nov, 7:00 PM IST" (C1 `latestPost` for `scheduled` projects).

**Code review fixes (2026-11-27):**
- **MUST 1 (a second run could post twice):** the stuck-job rule no longer re-sends a scheduled job's event after its time (Inngest drops a repeated id only for 24 h; a lost sleep is covered by the missed rule). Every attempt-1 run of a scheduled post goes through the wake, whatever the post's state; only the run that woke the post (its run id is saved) continues; `start` also refuses any other run. The wake's "project changed" error now says truthfully that nothing was saved and Inngest runs the step again.
- **SHOULD 2:** WHEN uses native radio inputs (Tab reaches the group, the arrow keys move to and select the other choice).
- **NICE 3:** the Missed banner shows the date and time.
- **NICE 4:** H2 Schedule refuses a time after the Instagram connection ends (+ the 1-hour grace): `409 INSTAGRAM_TOKEN_EXPIRED` "Your Instagram connection ends before this time. Reconnect Instagram, then schedule." (F32's refresh can lift this).
- **Left as is (reviewed, accepted):** a needs-approval post whose time has passed stays in the Scheduled tab (the card says "Was due …"); H5 also accepts an `approval_invalidated` post when the project is in another state (the project is then left alone); `finish: "8d"` also applies to Publish now runs (they end in about 10 minutes anyway).

## Steps
- [x] 1. Server: H2 Schedule + window/step check, the job's sleep + wake + missed, the stuck-job exclusion + read-time missed rule + notification, H5 cancel; unit tests
- [x] 2. Step 4 screens: schedule form (DATE + TIME IST), Scheduled view (Change time / Cancel schedule), Needs approval view, Missed view, dashboard card time; `allowedActions` (`cancel_post`) consistent with the server
- [x] 3. Tests with the stand-in Instagram and a private Inngest: `tools/e2e/f31-schedule.ts`; F30, F28, F29 e2e again
- [x] 4. Docs: API.md, openapi.yaml, DATABASE.md, ARCHITECTURE.md, this file, the tracker
- [ ] 5. Code review + fixes *(fixes applied 2026-11-27, waiting for the re-check)*
- [ ] 6. Founder test (with the stand-in now; one real scheduled Reel after F28/F30's real test)

## How we test it (done when all are ticked)
- [ ] Scheduled reel posts at the right time *(passes with the stand-in and a real Inngest sleep; tick after the founder sees it)*
- [ ] Cancel stops it *(passes with the stand-in: nothing is sent when the run wakes)*
- [ ] Asking for a revision (or editing narration/voice/captions) on a scheduled project at once shows the post as "needs approval" with a notification *(passes with the stand-in for H7, D3, D4, G3, G4; C5 cancels; D5/D7/F4 use the same shared rule, covered by unit tests)*
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

**Founder test:** open a ready video's Publish step → Schedule → pick a time 15 minutes away → tick → Schedule post → the Scheduled view, and the card on My videos ("Posts …"). Then try Change time (the form comes back with the caption) and Cancel schedule. For a post that should go out: keep `npm run dev` (and its Inngest Dev Server) running until the time. If the Inngest Dev Server is restarted while a post waits, it forgets the sleep: an hour after its time that post shows "Missed its time" (never posted late).

## Progress log
| Date | What happened |
|---|---|
| 2026-11-26 | Plan and design approved by the founder (decisions 1–9); building with the stand-in Instagram. Stitch screens downloaded to `docs/design/stitch/`. |
| 2026-11-26 | Step 1 (server, commit fbe52f1): `packages/db/src/post-schedule.ts` (window, 5-minute steps, IST words), H2 Schedule in `approvePost`, `packages/db/src/scheduled-posts.ts` (wake, missed, H5), the job's `schedule` → `sleepUntil` → `wake` steps, `finish: "8d"`, `cancelOn: job.cancelled`, the stuck-job rule for sleeping jobs, H5 route, `cancel_post`, waiting jobs cancelled by changes/archive, the caption box in `scheduled`, the card's time. Unit tests `tests/schedule.test.ts`; F30 tests updated. |
| 2026-11-26 | Step 2 (screens, commit a585f27): WHEN with Schedule (DATE + TIME (IST)), the approval line with the time, "Schedule post"; Scheduled view (`ScheduledCard`); Needs approval and Missed banners; badge "Needs approval"; F30 e2e updated (Schedule no longer "Coming soon"). |
| 2026-11-27 | Step 3 (tests, commit a4eb07e): `tools/e2e/f31-schedule.ts` 47/47 with a private Inngest (real sleep and wake; test-only time shift on `bytereel_test` + a re-delivered event); F30 e2e 71/71. Noted: 28 Nov 2026 is a Saturday (the design's "Fri 28 Nov" was only an example). |
| 2026-11-27 | Step 4 docs (API.md, openapi.yaml, DATABASE.md, ARCHITECTURE.md, tracker). Next: code review, then the founder's test. |
| 2026-11-28 | Code review fixes (see "Code review fixes" above): MUST 1 (no re-send after the time; every attempt-1 run goes through the wake; only the run that woke the post continues; `start` refuses other runs; truthful wake error), SHOULD 2 (native radios), NICE 3 (date in the Missed banner), NICE 4 (refuse a time after the connection ends). Daily-limit waiting noted as deferred (recommended skip, pending founder confirmation). Tests: unit (second run after the wake → no Instagram call; scheduledWait for every attempt-1 run; start refuses another run; no re-send after the time); full suite 1,321/1,321; F31 e2e 49/49 (new on MongoDB: a second run with a fresh event id of an already-woken post → one container, one reel; H2 refused when the connection ends first); F30 71/71; F28 43/43; F29 33/33; typecheck and `next build` pass. Next: the re-check, then the founder's test. |
