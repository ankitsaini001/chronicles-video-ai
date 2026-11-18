# F27 — Daily limits

| | |
|---|---|
| **Status** | ✅ Done (founder OK 2026-11-18) |
| **Phase** | A4 · Generate and review video |
| **Depends on** | F23 |
| **Design** | — (the storyboard's cost note and approve bar from F26) |
| **Data (MongoDB / storage)** | `usageCounters` (no new collection) |
| **API endpoints** (docs/API.md) | B1 usage, D8 (QUOTA_EXCEEDED / SPEND_CEILING), E2, §10.1, §10.2 |

## Goal
3 videos per user per day and the other limits, with friendly messages.

## What you will see
'Videos today: 1 of 3' chip and the limit message.

## In scope
- 3 videos/day (generate jobs only)
- 5 projects/day
- 20 plan requests/project
- 3,000 narration characters/month
- Reset at midnight in your timezone

## Already built before F27 (verified when planning, 2026-11-18)
- **Videos/day 3:** counted and enforced at D8 since F23 (only a new `generate` job counts; Try again, caption fixes and reusing an existing video don't). Message today: "You've reached today's limit of 3 videos. Try again tomorrow."
- **Projects/day 5:** since F12 (the Idea page already shows the reset time).
- **20 AI requests per project:** since F15/F18.
- **Voice characters 3,000/month per creator and 9,000/month for the app:** since F23, checked at D8/E2 and reserved before any ElevenLabs call. Message today: just "Voice limit reached this month."
- **Reset** at 00:00 in the creator's timezone (voice: the 1st of the month; the app's voice: UTC month).
- **Header chip** "Videos today: N of 3" (real count since F23).

## Not in this feature
- A daily Gemini spend ceiling: Gemini is on the free tier (Google can't charge), so its own free limits are the cap; our own ceiling comes with paid Gemini (F36 admin settings / launch).
- Admin-editable limits: the numbers stay code constants until F36.

## Decisions (founder, 2026-11-18; plan approved)
1. **Clear wording with the reset time** (in the creator's timezone):
   - videos/day: "You've made 3 videos today, the most for one day. You can make more after 12:00 am (midnight) your time."
   - creator's voice: "This video needs about 1,050 voice characters, but you have 794 left this month. The limit resets on 1 December."
   - the app's voice (everyone): "Video making is paused for everyone until 1 December (the app's monthly voice limit is used up). Your videos and downloads still work." (code review: the time is added when the app's month doesn't end at the creator's midnight: "Video making is paused for everyone until 1 December, 5:30 am your time (the app's monthly voice limit is used up). Your videos and downloads still work.")
2. **Warn before approving:** on the storyboard, when a new video won't fit (no videos left today, or not enough voice characters), the cost note says so and **Approve** is greyed out with the reason. The server still checks everything (D8).
3. **The same wording** when a background video job hits a limit (rare: D8 checks first).
4. **Tests:** the 4th video of a day refused; counters rise; reset at midnight in unit tests (India and other timezones, month boundary); voice "not enough" and "exactly enough". E2E with the stand-in voice and Gemini only.
5. **Founder test** (free): the new project (needs about 1,000 characters, about 790 left) shows the voice warning and a greyed-out Approve, nothing spent. The 4th-video case is proven by the e2e (on the real account it would cost 3 real videos).

### Decisions after the code review (founder, 2026-11-18)
- **Projects per day uses the same wording as videos:** "You've created 5 projects today, the most for one day. You can create more after 12:00 am (midnight) your time." (C2's message; the Idea page shows it as is).
- **Try again on the failure screen stays as it is** (not greyed out in advance; it answers with the same sentence while the limit applies).
- **First videos keep no cost note** for now (only the reason when a limit would refuse them).

### Choices made while building (engineer)
- **The server writes the whole sentence.** D8, E2 and a failed video job send the full sentence as the error `message`, built with the creator's timezone; the numbers stay in `details` as before. Every screen just shows the message, so the storyboard, the failure screen and a refused click always read the same. The sentences live in ONE file, `packages/db/src/limit-messages.ts` (no database code in it). Since the code review, C2's projects/day refusal comes from there too (founder decision below).
- **The warning before Approve uses D8's own functions.** `approveLimitCheck` (`packages/db/src/generate-jobs.ts`) only reads the database and follows D8's path and order: this version already has its video → approving costs nothing, never greyed out; a failed or cancelled job of this version (D8 queues the same job again) → only the voice is checked (no video of the day is counted); otherwise videos/day, then the voice (`voiceRefusal`, the very function D8/E2 use), the creator's 3,000 before the app's 9,000. "Exactly enough" passes and one more is refused by one shared rule (`wouldExceed`). A unit test runs the warning and D8 side by side on nine situations in two timezones and expects the same answer (code, words and numbers).
- **Where it shows:** a red note above the scenes ("Can't approve now: …" for screen readers) and the short reason next to the greyed-out button ("No videos left today." / "Not enough voice characters left this month." / "Video making is paused for everyone."); the button points to the note (`aria-describedby`). It works for the first video too (no cost note there, only the reason when it won't fit), for **Approve & make new video** (F26) and for **Generate video** (an approved version whose video was cancelled).
- **F26's cost note fixed on the way:** "It counts as 1 of your 3 videos today (N left)." now shows only when approving really starts a NEW video job (re-queuing a failed or cancelled one doesn't count), and the note is left out when approving just shows this version's existing video (e.g. after an Undo).
- **A video job that hits a limit** gets the same sentence (`endGenerateJob` builds it from the job owner's timezone and the characters our refused reservation asked for: the worker passes them). Our counter refusing ONE request while recording gives no number ("You don't have enough voice characters left this month for this video. The limit resets on 1 December." / the pause sentence); ElevenLabs refusing on its own gives the plain "Voice limit reached this month." (no date we can't know).
- **The app's reset date in each creator's timezone:** the app's month is a UTC month, so it ends on 1 December at 05:30 in India but on 30 November at 7 pm in New York: a New York creator reads "until 30 November" (correct for them).

## Steps
- [x] 1. Database: the sentences (`limit-messages.ts`), the refusals of D8/E2 (`videosPerDayError`, `voiceLimitError`), the read-only check before Approve (`approveLimitCheck`, `voiceRefusal`, `wouldExceed`), a failed job's sentence (`endGenerateJob`; the worker passes the characters) — `aa27326`
- [x] 2. Screens: the storyboard's limit note, greyed-out Approve / Generate video with the reason (`StoryboardScreen.tsx`, `Note.tsx`, the storyboard page, `lib/video/narration-cost.ts` `approveLimitFor`, `lib/video/new-video.ts`); the Idea page reuses the shared reset-time helper — `a5a6984`
- [x] 3. Unit tests (`tests/daily-limits.test.ts`, 48 tests; worker test for the characters in `tests/generate-video.test.ts`) — `e38643b`
- [x] 4. E2E `tools/e2e/f27-limits.ts` (stand-in voice and Gemini, no render) — `4d5309c`
- [x] 5. Docs: API.md (§4.3, §10.1, §10.2, D8, E2 "As built (F27)"), this file, the tracker — `4aadf5a`
- [x] 6. Code review fixes + the founder's projects/day wording — `5139af1`

## How to try it (founder)
**Restart `npm run dev` once** (Ctrl+C, then `npm run dev` again; `npm run inngest` can keep running), so every changed file of the database package is picked up. Nothing else to set up: no new setting, no new index. **Cost: nothing.** You only look; nothing is approved, no voice or AI call.
1. Open **My videos** and click your **new project** (the one without a video yet, id starting `4cd5bb`). It opens on the storyboard.
2. Above the scenes you now see a red note, e.g. "This video needs about 1,0xx voice characters, but you have 79x left this month. The limit resets on 1 December." (your exact numbers).
3. At the bottom, **Approve & generate video** is greyed out and next to it: "Not enough voice characters left this month." Clicking it does nothing.
4. Check that nothing was spent: the header still says the same "Videos today", and your voice characters this month are unchanged.
5. Optional: open one of your ready videos' storyboards ("Edit storyboard"): no red note there (approving a version that already has its video costs nothing).
To make that new video this month, shorten the narration (Edit or "Ask for changes") until the note goes away; or wait until 1 December. The 4th-video-of-the-day case is proven by the e2e (on your real account it would cost 3 real videos).

## Known limits
- **The warning is worked out when the page opens.** If you use voice characters or videos in another tab meanwhile, the button may still look enabled; the click then gets the same sentence from the server (D8 checks everything again). Reloading the page updates it.
- **A failed video's message keeps its date.** A job stopped by the voice limit says e.g. "The limit resets on 1 December."; after that date the old message stays on the failure screen until you press Try again (which works then).
- **Try again on the failure screen is not greyed out in advance** (kept simple): while the limit still applies it answers with the same sentence and changes nothing.
- **ElevenLabs refusing on its own** (characters used outside the app, F23's known limit) shows only "Voice limit reached this month." (no date: we don't know when ElevenLabs' own allowance resets).
- **At a month boundary** (a voice refusal at the very end of a month, the job ending just after midnight) the failure says "You don't have enough voice characters left this month for this video." with the NEW month's reset date, although Try again already works. Very rare; kept simple.
- **"About N voice characters"** is what D8 counts (recordings you already have are free). As in F26, it can overstate (never understate) when an earlier attempt of the same video already reserved some characters.
- The first video shows no cost note (only the reason when it won't fit); the cost note stays an F26 feature of a new video after a change.
- No Gemini spend ceiling (see "Not in this feature"); the limits stay code constants until F36.
- `tools/e2e/f23-generate.ts` was updated to expect the new wording but not re-run (it renders real videos); the same refusals are covered by the F27 e2e.

## How we test it (done when all are ticked)
- [x] 4th video in a day is refused with a clear message (e2e: after D8 accepted the 3rd video of the day (cancelled at once, no render), the 4th → 429 "You've made 3 videos today, …", still 3, no job, no approval; the storyboard showed the note and a greyed-out Approve before the click; the other user unaffected; unit: the warning and D8 agree in 18 situations)
- [x] Counter updates (e2e: the accepted 3rd video took videos today 2 → 3; B1 and the header chip "Videos today: 3 of 3" followed every change of the counters; refused clicks counted nothing)
- [x] Resets next day (unit: the day changes at 18:30 UTC for India and 05:00 UTC for New York, the month at each creator's 1st and the app's in UTC; 3 of 3 one second before midnight is refused, one second after it is allowed. e2e: 3 videos yesterday don't count today; New York's refusal resets at 05:00 UTC)
- [x] Code review passed (code-reviewer agent, 2026-11-18; no must-fix, the money paths unchanged; all points fixed, see the progress log)
- [x] Founder tested it and said OK (2026-11-18)

## Progress log
| Date | What happened |
|---|---|
| 2026-11-18 | Plan approved by the founder (decisions 1–5). |
| 2026-11-18 | **Built** in small commits on `dev` (see Steps). Unit tests: **1097 pass** (48 new in `tests/daily-limits.test.ts`, 1 new worker test; the F23/F26 tests that checked the old words now check the new ones); typecheck clean; `next build` exit 0 (Next.js 16.4.6). **E2E `tools/e2e/f27-limits.ts`: 48/48 pass** on the first run, on a fresh `bytereel_test` (port 3236, a private Inngest on 8299; stand-in voice and Gemini; no render: limits set by writing the test database's counters, and the one accepted video cancelled at once, before its voice reservation). The stand-in storyboard needs 1,160 voice characters: at 2,999 used → "…needs about 1,160 voice characters, but you have 1 left…", 1 short → "…1,159 left…", exactly enough → allowed. The app at 9,000 → 503 "paused for everyone until 1 December" for the India creator and "until 30 November" on the New York creator's storyboard. A job stopped by the voice limit showed the sentence on the failure screen, and Try again was refused with the same words. Test servers stopped by pid, `bytereel_test` dropped before and after; zero real ElevenLabs and Gemini calls; TMPDIR inside the project. Ready for code review and the founder's test. |
| 2026-11-18 | **Code review fixed** (no must-fix; the money paths verified unchanged; 8 points): (1) "paused for everyone until 1 December" named a day still paused (the app's month ends 00:00 UTC = 5:30 am in India, 7 pm on 30 November in New York): the time is now added unless it is local midnight ("until 1 December, 5:30 am your time"); (2) ElevenLabs refusing on its own no longer states a date we can't know: plain "Voice limit reached this month."; (3) one request refused while recording no longer quotes one scene's characters: "You don't have enough voice characters left this month for this video. The limit resets on 1 December."; (4) at a month boundary the numbers could contradict ("needs 1,160, 3,000 left"): the sentence without numbers is used then (rest noted under Known limits); (5) no "It counts as 1 of your 3 videos today" next to a "Can't approve now" note; (6) a dead branch removed (`videosTodayLine`); (7) more tests: the pre-check and D8 now agree in 13 situations × 2 timezones, also on the PATH D8 takes when it accepts (an existing video reused, a cancelled job queued again, characters already reserved: exactly enough / 1 short); (8) **founder decision:** projects/day says "You've created 5 projects today, the most for one day. You can create more after 12:00 am (midnight) your time." (C2; the Idea page no longer adds its own time; API.md, openapi.yaml, the F12 e2e check). Founder decisions also recorded: Try again on the failure screen stays not greyed out; first videos keep no cost note. Unit tests: **1109 pass**; typecheck clean; `next build` exit 0. **E2E 50/50** on a fresh `bytereel_test` (adds the 6th project of the day → 429 with the new words, nothing created; the pause now reads "until 1 December, 5:30 am your time" for India and "until 30 November, 7:00 pm your time" for New York). Test servers stopped by pid, `bytereel_test` dropped before and after; zero real ElevenLabs and Gemini calls; TMPDIR inside the project. |
| 2026-11-18 | **Founder tested it and said OK**: the sunset project's change (Version 3, about 135 voice characters, fits) shows the cost note with "(3 left)" and an enabled "Approve & make new video"; the new project (a full first video, about 1,000 characters with about 790 left) shows the red voice note and a greyed-out Approve. Nothing approved, nothing spent. ✅ Done. |
