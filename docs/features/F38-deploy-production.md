# F38 — Deploy to production + invite beta users

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A6 · Settings, admin and launch |
| **Depends on** | F37 |
| **Design** | — |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | — |

## Goal
Put ByteReel online on Vercel with the real domain and invite the first creators.

## What you will see
The live ByteReel website.

## In scope
- Domain (still to decide)
- Vercel production setup
- **Production database:** a second Atlas project with its own free M0 cluster (no cost), so beta users' data never mixes with test data (DATABASE.md Q1)
- **Same region pair as F05:** Atlas region next to the Vercel function region (recommended Atlas Mumbai `ap-south-1` + Vercel `bom1`, DATABASE.md §2.1)
- Paid-tier switches if needed
- Submit Meta App Review
- Invite beta users
- Replace the dummy contact email (`CONTACT_EMAIL` in `apps/web/lib/site.ts`, now `contact@example.com`) with the real one

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Sign up → create → publish works on the live site
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
