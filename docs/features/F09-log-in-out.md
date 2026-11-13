# F09 — Log in and log out

| 2026-11-13 | Built steps 1–8 in 8 commits. 388 tests pass (35 new), typecheck and `next build` clean, no secret in the browser files. End-to-end: 47/47 checks pass against `bytereel_test` (F08 script re-run too, all pass; database dropped afterwards). Found: Better Auth 1.7.14 answers sign-out with 200 even without a session (API.md said 401; docs fixed). Decisions: lock at every 10th wrong password in a row (count resets only on success); `deleting` users get the same `ACCOUNT_SUSPENDED` answer as `suspended`; logout goes to the home page. No new indexes (lookups use the F08 unique `user.email` index). Waiting for code review and the founder's test |
|---|---|
| **Status** | ✅ Done |
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
- [x] 1. Sign-in limits (5 / 15 min per IP and per email) and the 10-failure lockout helpers in `packages/db` (`login-guard.ts`: one atomic update per failure; every 10th wrong password in a row locks for 15 min) (`c46e984`)
- [x] 2. Better Auth: only `active` users get a session (403 `ACCOUNT_SUSPENDED` for `suspended` and `deleting`, checked after the password in the session hook) (`14dca9d`)
- [x] 3. `/api/auth` route: sign-in IP limit → strict body (email, password, optional `rememberMe` dropped) → email limit → lock → Better Auth; wrong email and wrong password get the same 401; lock gets the same 429 as the rate limits; get-session limit 120 / min per IP (`21324b4`)
- [x] 4. Server-side session helpers (`lib/auth/session.ts`: `requireUser`, `redirectIfSignedIn`): private pages go to `/login`; `/login` and `/signup` go to `/dashboard` when signed in (`bad1d0d`)
- [x] 5. `/login` page from the Stitch design (`0e059ce`)
- [x] 6. Log out button (→ home page), and the user's name in the header: home/contact header menu (initial + name, shortened when long; panel with full name, email, My videos, Log out); temporary dashboard shows the name and Log out (`5298d57`)
- [x] 7. End-to-end test over HTTP against `next start` on port 3232 with `bytereel_test` (then dropped); script `tools/e2e/f09-login.ts` (`3239a48`)
- [x] 8. Docs match what was built: API.md, openapi.yaml, DATABASE.md (`f18b6e4`)

## How we test it (done when all are ticked)
- [x] Correct password logs in (automated, in `bytereel_test`; the founder repeats it)
- [x] Wrong password shows an error without saying if the email exists (unknown email gets the identical 401 body)
- [x] Log out works (session row deleted, cookie cleared, name gone from the header)
- [x] Opening a private page while logged out goes to /login
- [x] Code review passed (code-reviewer agent)
- [x] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Built steps 1–8 in 8 commits. 388 tests pass (35 new), typecheck and `next build` clean, no secret in the browser files. End-to-end: 47/47 checks pass against `bytereel_test` (F08 script re-run too, all pass; database dropped afterwards). Found: Better Auth 1.7.14 answers sign-out with 200 even without a session (API.md said 401; docs fixed). Decisions: lock at every 10th wrong password in a row (count resets only on success); `deleting` users get the same `ACCOUNT_SUSPENDED` answer as `suspended`; logout goes to the home page. No new indexes (lookups use the F08 unique `user.email` index). Waiting for code review and the founder's test |
| 2026-11-13 | Code review: no must-fix. Applied the should-fixes: (1) server-side session reads count only `status: active` users as signed in (an old session of a suspended/deleting user no longer shows the name or opens private pages; API.md §3.1 says the `/api/v1` helper must do the same) (`986a091`); (2) documented that the lock on `user` lets someone tell a registered email from an unknown one across windows, accepted for the private beta under the same exception as A1, with the fix noted in Future ideas for public sign-up (`8f51440`); (3) auth request bodies are read with a running byte count, 413 above 64 KB also without Content-Length (`ea41a27`). Known trade-off (required by API.md, fine for an invite-only beta): the 5 / 15 min per-email limit lets anyone who knows an email keep that user out for 15 minutes at a time. 398 tests pass, typecheck and `next build` clean; e2e 49/49 against `bytereel_test` (dropped afterwards). Waiting for the founder's test |
| 2026-11-13 | Founder tested log in, log out, the name in the header and the private-page redirect on http://localhost:3000. Founder: "look good" → ✅. |
