# F33 — Settings page

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A6 · Settings, admin and launch |
| **Depends on** | F32 |
| **Design** | Stitch: ByteReel — Settings |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | B1, B2, B3, A5 |

## Goal
Defaults, usage, password change and account deletion.

## What you will see
The 'ByteReel — Settings' screen.

## In scope
- Name, default language/voice, timezone
- Today's usage
- Change password
- Delete account: 30-day soft delete (hidden + logged out now, Instagram disconnected now), then personal data and videos erased and one anonymous `deletionLog` entry written (DATABASE.md §6.7, founder decision 2026-11-13). The Settings screen tells the user about the 30 days

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Defaults are used on the Idea screen
- [ ] Password change works
- [ ] Delete removes your data from Atlas and R2
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
