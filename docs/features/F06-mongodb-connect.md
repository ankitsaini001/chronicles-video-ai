# F06 — Connect the app to MongoDB (test record)

| | |
|---|---|
| **Status** | 🧪 Testing |
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
- [x] Install the MongoDB driver
- [x] Add the db client
- [x] Add the health check
- [x] Run it
- [x] Founder sees the record in Atlas
- [x] Clean up: delete the test record and drop `healthchecks` (only after the founder has seen it)

## How we test it (done when all are ticked)
- [x] Founder opens Atlas → Browse Collections and sees the test record
- [x] App shows a clear error if the database is unreachable
- [x] Missing `MONGODB_URI` shows a clear message (no crash dump)
- [x] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
| 2026-11-13 | Built in one go. New `packages/db` (`@bytereel/db`): settings check (`readDbConfig`, catches missing value, `<db_password>` left in, raw special characters in the password, a port on `+srv`), one shared client on `globalThis`, plain-language errors (auth, bad connection string, DNS/SRV lookup, unreachable/Network Access, TLS, index conflict), health check (one fixed record in `bytereel.healthchecks`), cleanup, ping, and the index list for F07/F08 with `ensureIndexes` (not applied yet: F07/F08 apply their own). `npm run db -- check | ping | cleanup | indexes`. Web: `next.config.ts` loads the root `.env` (`process.loadEnvFile`; `@next/env` caches and did nothing), `instrumentation.ts` prints a clear box when a setting is wrong while public pages keep working. Driver `mongodb@7.7.0`, one copy at the root (also listed by the web app for F08). Checks: ping Pune → Mumbai ~9 ms; 5 failure cases give clear messages and never show the password; a temporary web route using the driver built without warnings and answered ok (removed again); no connection string in `.next/static`; 240 tests pass (54 for the database), typecheck clean. Code review: 1 must-fix (badly formatted connection string crashed the command) and 5 should-fixes, all fixed. Test record written to Atlas, waiting for the founder to see it. |
| 2026-11-13 | Founder saw the test record in Atlas (bytereel-dev → bytereel → healthchecks, written 12:31:33 IST). Then `npm run db -- cleanup` deleted it; the empty `bytereel` database disappears until F07 writes real data (normal for MongoDB). The test-record code (`check`/`cleanup`) was removed; `npm run db -- ping` remains (writes nothing). 235 tests pass, typecheck clean. Waiting for the founder's dev-server restart check and OK. |
