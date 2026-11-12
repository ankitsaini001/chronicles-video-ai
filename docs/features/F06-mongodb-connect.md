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
- Delete the test record afterwards

## Not in this feature
- —

## Steps
- [ ] Install the MongoDB driver
- [ ] Add the db client
- [ ] Add the health check
- [ ] Run it
- [ ] Founder sees the record in Atlas
- [ ] Clean up the test record

## How we test it (done when all are ticked)
- [ ] Founder opens Atlas → Browse Collections and sees the test record
- [ ] App shows a clear error if the database is unreachable
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
