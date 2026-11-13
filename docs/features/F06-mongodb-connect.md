# F06 — Connect the app to MongoDB (test record)

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A2 · Accounts and database |
| **Depends on** | F05 |
| **Design** | — |
| **Data (MongoDB / storage)** | `healthchecks` (temporary) |
| **API endpoints** (docs/API.md) | — |

## Goal
Make the app talk to your Atlas database and prove it by saving one test record you can see in Atlas.

## What you will see
A small dev-only check page/command that writes and reads one test record.

## In scope
- MongoDB client in `packages/db`
- A health check that writes + reads one record
- MongoDB client cached globally (one client reused across serverless starts, DATABASE.md §9)
- Setup script that creates indexes (starts with the required Better Auth indexes, DATABASE.md §8)
- **At the end of F06**, after the founder has seen the test record in Atlas: delete the record and drop the `healthchecks` collection. Later health checks use `db.command({ ping: 1 })`, which writes nothing (DATABASE.md Q16)
- Environment variable check on start-up: clear message if a required key (e.g. the MongoDB connection string) is missing (moved here from F02)

## Not in this feature
- —

## Steps
- [ ] Install the MongoDB driver
- [ ] Add the db client
- [ ] Add the health check
- [ ] Run it
- [ ] Founder sees the record in Atlas
- [ ] Clean up: delete the test record and drop `healthchecks` (only after the founder has seen it)

## How we test it (done when all are ticked)
- [ ] Founder opens Atlas → Browse Collections and sees the test record
- [ ] App shows a clear error if the database is unreachable
- [ ] Missing `MONGODB_URI` shows a clear message (no crash dump)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
