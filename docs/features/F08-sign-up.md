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
- After sign-up → My videos (shell comes in F11; temporary page until then)

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Invited email can sign up; user appears in Atlas `user` collection
- [ ] Not-invited email is refused
- [ ] Password is never stored in plain text (check in Atlas)
- [ ] Same email twice → clear error
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
