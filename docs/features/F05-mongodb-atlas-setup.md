# F05 — MongoDB Atlas: create the account and database (together)

| | |
|---|---|
| **Status** | ✅ Done |
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
- [x] Sign up on mongodb.com/atlas
- [x] Create the M0 cluster
- [x] Create the database user
- [x] Network access
- [x] Get the connection string
- [x] Save it in .env
- [x] Tour of the Atlas data browser (Browse Collections)

## How we test it (done when all are ticked)
- [x] Founder can log in to Atlas and see the cluster
- [x] Connection string is in `.env` only
- [x] Founder can explain where the data will be stored
- [x] Code review passed (code-reviewer agent)
- [x] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
| 2026-11-13 | Done together. Atlas organization "ankit's Org - 2026-11-13", project renamed to `ByteReel13092026`, project time zone (+05:30) Kolkata. Free cluster **`bytereel-dev`** (free tier, 512 MB) in **Mumbai (AWS ap-south-1)**, MongoDB 8.0, replica set. Sample dataset not loaded. Database user `ankitsaini594_db_user` created by Atlas (Atlas Admin role: fine for dev; production gets a least-privilege user in F38). Network access: the founder's current IP only (Vercel access decided in F38). `MONGODB_URI` + `MONGODB_DB=bytereel` saved in the git-ignored `.env`; `.env.example` has empty placeholders. Connection tested with a ping from the laptop: OK, transactions supported. Free-tier limits read from MongoDB's official page and written into DATABASE.md §9; correction: free clusters can now have a free daily backup (§10). Region pair for F38: Atlas Mumbai + Vercel `bom1`. |
