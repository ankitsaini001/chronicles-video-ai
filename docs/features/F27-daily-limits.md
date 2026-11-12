# F27 — Daily limits

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A4 · Generate and review video |
| **Depends on** | F23 |
| **Design** | — |
| **Data (MongoDB / storage)** | `usageCounters` |
| **API endpoints** (docs/API.md) | B1 usage, QUOTA_EXCEEDED |

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

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] 4th video in a day is refused with a clear message
- [ ] Counter updates
- [ ] Resets next day
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
