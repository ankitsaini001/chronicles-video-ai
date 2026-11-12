# F35 — Admin: reset-password link + reset page

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A6 · Settings, admin and launch |
| **Depends on** | F34 |
| **Design** | Stitch: ByteReel — Reset password |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | I7, A6 |

## Goal
No emails in V1: the admin creates a one-time link (valid 1 hour) and shares it.

## What you will see
'Create reset link' in Admin and the 'ByteReel — Reset password' screen.

## In scope
- One-time link, 1 hour
- Reset page
- Old links stop working

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Link works once
- [ ] Expired/used link shows the 'Ask the ByteReel team' message
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
