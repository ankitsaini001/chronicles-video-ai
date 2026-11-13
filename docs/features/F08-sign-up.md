# F08 — Sign up

| | |
|---|---|
| **Status** | ✅ Done |
| **Phase** | A2 · Accounts and database |
| **Depends on** | F07 |
| **Design** | Stitch: ByteReel — Sign up |
| **Data (MongoDB / storage)** | `user`, `account`, `session` (Better Auth) |
| **API endpoints** (docs/API.md) | A1, A4 |

## Goal
Invited creators can create an account with name, email and password.

## What you will see
The 'ByteReel — Sign up' screen.

## In scope
- Better Auth with email + password
- Sign-up checks the allow-list
- Not invited → go to Access pending (F10)
- Password 8–128 characters, confirm field
- Better Auth locked down: only the 6 documented auth endpoints are exposed; server-owned user fields use `input: false` (API.md §3.1)
- After sign-up → My videos (shell comes in F11; temporary page until then)
- Better Auth's built-in rate limiter off; sign-up/login limits use our `rateLimits` collection (DATABASE.md §4.6)
- Required Better Auth indexes created by our setup script (DATABASE.md §8), because the adapter may not create them

## Not in this feature
- —

## Steps
- [x] 1. Install Better Auth **1.7.14** (newest release at least 2 weeks old; sub-packages resolved with `--before=2026-10-30`). One `mongodb` copy stays in the repo (`adcc9db`)
- [x] 2. Rate limiter on our `rateLimits` collection in `packages/db` (fixed windows, hashed ids, TTL `expiresAt`); sign-up rule 5 per 15 min per IP; F09 reuses it (`3da512c`)
- [x] 3. Better Auth set-up (`apps/web/lib/auth/`): email + password, no email verification, password 8–128, sessions 30 days rolling, cookie cache off, built-in limiter off, telemetry off, MongoDB adapter on our shared client; allow-list check in the `user.create` hooks (403 `NOT_ALLOWLISTED`, normalized email, `allowlist.signedUpUserId` set after save); server-owned fields `input: false`; every other Better Auth endpoint in `disabledPaths`; start-up check for `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL`; local secret written to `.env` (`011a3d4`)
- [x] 4. `/api/auth/[...all]` route: only the 6 endpoints (404 otherwise), Origin check, JSON only, sign-up rate limit, strict sign-up body (role/status/anything extra → 400), duplicate email → 422 `USER_ALREADY_EXISTS` (`b1339f5`)
- [x] 5. Password field with show/hide button in the UI kit (`4777e4c`)
- [x] 6. `/signup` page from the Stitch design; temporary `/access-pending` (until F10) and `/dashboard` "Signed in as …" (until F11) (`17fd9d9`)
- [x] 7. F08 indexes created in the real `bytereel` database (`npm run db -- indexes --feature F08 --apply`)
- [x] 8. End-to-end test over HTTP against `next start` on port 3231 with the separate `bytereel_test` database; found and fixed a way around the rate limit (`2b12e56`); script `tools/e2e/f08-signup.ts` (`17181e6`); `bytereel_test` dropped afterwards
- [x] 9. Q17 checks; DATABASE.md, API.md and openapi.yaml updated to match (`852f2ac`)
- [x] 10. Founder creates their own account at http://localhost:3000/signup and checks it in Atlas

## How we test it (done when all are ticked)
- [x] Invited email can sign up; user appears in Atlas `user` collection (automated, in `bytereel_test`; the founder repeats it with their own email)
- [x] Not-invited email is refused
- [x] Password is never stored in plain text (check in Atlas)
- [x] Same email twice → clear error
- [x] A user can't set role/status at sign-up or via any auth endpoint
- [x] Better Auth's real `user`/`session`/`account` documents match DATABASE.md §4.1–4.3 (Q17); the doc is updated if not
- [x] Check whether the adapter stores `userId` as an ObjectId or a string; if a string, `packages/db` converts consistently (DATABASE.md §4 "Better Auth fields")
- [x] Check whether the adapter created any indexes; the required ones exist (Atlas → collection → Indexes)
- [x] Code review passed (code-reviewer agent)
- [x] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Built steps 1–9 in 9 commits. 353 tests pass (82 new), typecheck and `next build` clean, no secret in the browser files, one `mongodb` copy. End-to-end: 35/35 checks pass against `bytereel_test` (then dropped). The e2e found that a made-up `X-Forwarded-For` header gave fresh sign-up attempts under `next start`; fixed (header trusted only on Vercel). Q17: fields match, `userId` is an ObjectId, the adapter creates no indexes. Waiting for code review and the founder's own sign-up |
| 2026-11-13 | Code review: the reviewer agent failed twice on an API outage (403 from the AI service), so the main session reviewed handler.ts, endpoints.ts, create-auth.ts, server.ts, route.ts, config.ts, rate-limit.ts and markInviteSignedUp directly. No must-fix: exact-path lockdown (encoded/trailing-slash/other-method → 404), Origin check (missing/`null`/foreign origin refused), role/status forced twice (strict body + hook), invite link stored as ObjectId once, atomic fixed-window counter with E11000 retry, secret never logged. **Known gap for F09 (before any deploy):** sign-in (A2) has no rate limit or lockout yet. change-password (needs a session) and reset-password (no way to create tokens until F35) stay on Better Auth defaults behind the lockdown. 353 tests pass, typecheck clean. Waiting for the founder to create their account. |
| 2026-11-13 | Founder signed up with their own email at http://localhost:3000/signup and landed on the temporary dashboard ("Signed in as Ankit"). Read-only check on Atlas: 1 user (`role creator`, `status active`, Asia/Kolkata), password stored only as a scrypt `salt:hash`, 1 session valid 30 days with `userId` as ObjectId, `allowlist.signedUpUserId` matches the user, all F07/F08 indexes present. Header stays "Log in" only (invite-only); the home page's "Create your first reel" buttons lead to `/signup`. Founder: "F08 look good" → ✅. F09 must show the user's name in the header when signed in. |
