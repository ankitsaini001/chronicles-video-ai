# F05 — MongoDB Atlas: create the account and database (together)

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A2 · Accounts and database |
| **Depends on** | F04 |
| **Design** | — |
| **Data (MongoDB / storage)** | MongoDB Atlas (cloud, founder's own account) |
| **API endpoints** (docs/API.md) | — |

## Goal
Create YOUR free MongoDB Atlas database, step by step together, so you know exactly where the data lives.

## What you will see
Your Atlas dashboard in the browser showing an empty `bytereel` database.

## In scope
- Create a free Atlas account (founder does the clicks, I guide)
- Create a free M0 cluster in a nearby region (Mumbai if available)
- **Region next to the server, not the users:** choose the Atlas region and the Vercel function region together. **Founder chose Mumbai (2026-11-13):** **Atlas Mumbai (AWS `ap-south-1`) + Vercel functions in Mumbai (`bom1`)** (DATABASE.md §2.1). Write the choice in the progress log so F38 uses the same pair
- Read the current M0 limits (connections, operations per second, data transfer) on Atlas's page and note them in DATABASE.md §9 (no guessed numbers)
- Create a database user + password
- Allow network access
- Copy the connection string into `.env` (never into .env.example)

## Not in this feature
- Any app code

## Steps
- [ ] Sign up on mongodb.com/atlas
- [ ] Create the M0 cluster
- [ ] Create the database user
- [ ] Network access
- [ ] Get the connection string
- [ ] Save it in .env
- [ ] Tour of the Atlas data browser (Browse Collections)

## How we test it (done when all are ticked)
- [ ] Founder can log in to Atlas and see the cluster
- [ ] Connection string is in `.env` only
- [ ] Founder can explain where the data will be stored
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
