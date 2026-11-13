# F08 — Sign up

| | |
|---|---|
| **Status** | ⬜ Not started |
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
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Invited email can sign up; user appears in Atlas `user` collection
- [ ] Not-invited email is refused
- [ ] Password is never stored in plain text (check in Atlas)
- [ ] Same email twice → clear error
- [ ] A user can't set role/status at sign-up or via any auth endpoint
- [ ] Better Auth's real `user`/`session`/`account` documents match DATABASE.md §4.1–4.3 (Q17); the doc is updated if not
- [ ] Check whether the adapter stores `userId` as an ObjectId or a string; if a string, `packages/db` converts consistently (DATABASE.md §4 "Better Auth fields")
- [ ] Check whether the adapter created any indexes; the required ones exist (Atlas → collection → Indexes)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
