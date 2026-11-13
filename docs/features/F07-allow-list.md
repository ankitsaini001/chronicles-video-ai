# F07 — Allow-list (invite list)

| | |
|---|---|
| **Status** | ⬜ Not started |
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
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Founder adds their own email and sees it in Atlas
- [ ] Adding the same email twice doesn't duplicate it
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
