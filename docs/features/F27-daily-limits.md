# F27 — Daily limits

| | |
|---|---|
| **Status** | 🔨 Building (plan approved 2026-11-18) |
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
   - the app's voice (everyone): "Video making is paused for everyone until 1 December (the app's monthly voice limit is used up). Your videos and downloads still work."
2. **Warn before approving:** on the storyboard, when a new video won't fit (no videos left today, or not enough voice characters), the cost note says so and **Approve** is greyed out with the reason. The server still checks everything (D8).
3. **The same wording** when a background video job hits a limit (rare: D8 checks first).
4. **Tests:** the 4th video of a day refused; counters rise; reset at midnight in unit tests (India and other timezones, month boundary); voice "not enough" and "exactly enough". E2E with the stand-in voice and Gemini only.
5. **Founder test** (free): the new project (needs about 1,000 characters, about 790 left) shows the voice warning and a greyed-out Approve, nothing spent. The 4th-video case is proven by the e2e (on the real account it would cost 3 real videos).

## Steps
_Filled in while building._

## How to try it (founder)
_Filled in when it is ready._

## Known limits
_Filled in while building._

## How we test it (done when all are ticked)
- [ ] 4th video in a day is refused with a clear message
- [ ] Counter updates
- [ ] Resets next day
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-18 | Plan approved by the founder (decisions 1–5). |
