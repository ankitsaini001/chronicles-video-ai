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
- **From the F30 code reviews (2026-11-26), B3 MUST:**
  - **Refuse while a post is being published.** Check `hasPostInFlight(db, { ownerId })` (`packages/db/src/post-approval.ts`) inside B3's transaction. While a post is `publishing` / `outcome_unknown`, answer 409 with a plain message ("A post is being published to Instagram right now. Please try again in a few minutes."), like G4 Disconnect does. Otherwise the running job could post after the account is gone.
  - **The user stops being `active` at once.** The publish job's approval re-check already requires `user.status === "active"` (`recheckPublishApproval`, reason `user_not_active`). B3 must set the status (soft-deleted, not `active`) in the same transaction, so no scheduled or retried post can publish afterwards.
  - Also cancel the user's open posts (`scheduled` / `publish_failed`) in the same transaction (`cancelOpenPosts` per project, or `invalidateOpenPosts`).

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
