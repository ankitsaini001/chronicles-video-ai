# F07 — Allow-list (invite list)

|---|---|
| **Status** | 🧪 Testing |
| **Phase** | A2 · Accounts and database |
| **Depends on** | F06 |
| **Design** | — |
| **Data (MongoDB / storage)** | `allowlist` |
| **API endpoints** (docs/API.md) | (admin endpoints I1–I3 come in F34) |

## Goal
Only invited emails can sign up. Store the invite list in MongoDB.

## What you will see
Nothing in the UI yet. You add your email with one simple command and see it in Atlas.

## In scope
- `allowlist` collection
- A small command: add / list / remove an email
- Emails saved in lowercase

## Not in this feature
- Admin screen (that's F34)

## Steps
- [x] Invite-list code in `packages/db` (`allowlist.ts`): add / list / remove / isInvited, emails trimmed + lowercased, unique `email` index created on first add
- [x] Command: `npm run db -- invite add <email> [--note "..."]`, `invite list`, `invite remove <email>`
- [x] Tests (25) + live test on Atlas with a throwaway address (added, re-added in other case, listed, removed)
- [ ] Founder adds their own email and checks it in Atlas

## How we test it (done when all are ticked)
- [ ] Founder adds their own email and sees it in Atlas
- [x] Adding the same email twice doesn't duplicate it
- [x] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Built in one go. `packages/db/src/allowlist.ts` + `npm run db -- invite add/list/remove`. Emails are trimmed and lowercased; invalid emails and notes over 200 characters are refused before touching the database; `invitedBy: null` for command-added entries (DATABASE.md Q14). The unique `email_unique` index is created on the first add. Live test on Atlas: `  F07-Test@Example.COM ` saved as `f07-test@example.com`, re-adding in another case changed nothing, a direct duplicate insert was refused by the database (error 11000), remove worked, list now empty. The `bytereel` database is back in Atlas with an empty `allowlist` collection. 260 tests pass (25 new), typecheck clean. Waiting for the code review, then the founder adds their own email. |
| 2026-11-13 | Code review: no must-fix. Applied the 3 should-fixes: two adds of the same email at the same moment now report "already invited" (E11000 handled); the email check uses zod (the same kind of check sign-up uses), so hidden characters from chat apps, angle brackets, double dots and accents are refused; command-added invites get the note "added by setup command" (DATABASE.md Q14). The unique index is now created by the command, not on every `addInvite` (ready for F34). Live check on Atlas ok; 271 tests pass. Waiting for the founder to add their own email. |
