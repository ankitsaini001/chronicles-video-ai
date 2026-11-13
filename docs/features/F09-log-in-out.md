# F09 — Log in and log out

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A2 · Accounts and database |
| **Depends on** | F08 |
| **Design** | Stitch: ByteReel — Log in |
| **Data (MongoDB / storage)** | `session` |
| **API endpoints** (docs/API.md) | A2, A3, A4 |

## Goal
Creators can log in and out. Too many wrong passwords locks the account for a while.

## What you will see
The 'ByteReel — Log in' screen and a Log out option.

## In scope
- Login form
- Log out
- Rate limit + lockout after repeated failures
- 'Forgot your password? Contact the ByteReel team.' text (no email in V1)
- Pages that need login redirect to /login

- **Must, before any deploy (from the F08 review):** sign-in (A2) rate limits and the 10-failure lockout (API.md §3.7) using `hitRateLimit` in packages/db; sign-in currently has none

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Correct password logs in
- [ ] Wrong password shows an error without saying if the email exists
- [ ] Log out works
- [ ] Opening a private page while logged out goes to /login
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
