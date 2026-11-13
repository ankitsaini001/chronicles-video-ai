# F09 — Log in and log out

| | |
|---|---|
| **Status** | 🔄 In progress |
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
- [ ] 1. Sign-in limits (5 / 15 min per IP and per email) and the 10-failure lockout helpers in `packages/db`
- [ ] 2. Better Auth: only `active` users get a session (403 `ACCOUNT_SUSPENDED`, checked after the password)
- [ ] 3. `/api/auth` route: sign-in rate limits, strict body, lockout, one message for wrong email or password; get-session limit 120 / min per IP
- [ ] 4. Server-side session helpers: private pages go to `/login`; `/login` and `/signup` go to `/dashboard` when signed in
- [ ] 5. `/login` page from the Stitch design
- [ ] 6. Log out button, and the user's name in the header (home page and temporary dashboard)
- [ ] 7. End-to-end test over HTTP against `next start` on port 3232 with `bytereel_test` (then dropped)
- [ ] 8. Docs match what was built

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
