# F04 — Database design document (doc only)

| | |
|---|---|
| **Status** | 🧪 Testing (founder review) |
| **Phase** | A2 · Accounts and database |
| **Depends on** | — |
| **Design** | — |
| **Data (MongoDB / storage)** | Design only |
| **API endpoints** (docs/API.md) | — |

## Goal
Write docs/DATABASE.md in plain language: which collections we store, what one record looks like, and how they connect.

## What you will see
A document to read. No database is created yet.

## In scope
- Every collection with a small example record
- Which collections each feature adds (Phase A2 only needs users, sessions, allow-list)
- Indexes and rules explained simply

## Not in this feature
- Creating any database

## Steps
- [x] Write the doc
- [ ] Founder reads it
- [ ] Answer questions / fix
- [ ] Founder approves

## How we test it (done when all are ticked)
- [ ] Founder has read it and the questions are answered
- [x] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Wrote `docs/DATABASE.md` (12 sections): MongoDB explained for a MySQL/Laravel developer; where data lives (your own Atlas M0 cluster, database `bytereel`, files in R2, secrets in env vars); all 25 collections (24 + temporary `healthchecks`) with a fake example, field table, rules and indexes; how they connect; safety and privacy (passwords, encrypted Instagram tokens, owner check, server-owned fields, archive vs delete, account deletion); transactions (§7, as API.md links); indexes summary; size estimate vs 512 MB; backups (none in V1 + manual safety net); what gets created in which feature (A2 = Better Auth collections + `allowlist` + `rateLimits`); glossary; 12 differences from PRD §15; 17 open questions. API.md C5 link fixed to DATABASE.md §6.6. Next: founder reads it. |
| 2026-11-13 | Code-review fixes applied (all must-fix, should-fix and nice-to-have items). Must-fix: a change, archive, suspend, disconnect, Meta deauthorize or account deletion now also stops `publish_failed` posts (not only `scheduled`), and the publish re-check (job, H6, I9) also requires project not archived, user `active` and the approved render/plan still current (API.md, openapi.yaml, ARCHITECTURE §17/§18 updated too); `deletionRequests.confirmationCode` is a partial unique index; the Better Auth indexes are required for A2 and created by our setup script. Also: TTL caveats, region next to the server (Atlas Mumbai + Vercel `bom1`, decided in F05), local development on the Atlas dev database, complete transactions list, account-deletion list, session-token security note, Better Auth core fields, M0 limits, voice-limit note (about 3 voiced videos per user per month). Open questions Q1–Q17 decided, except **Q10 (account deletion details), which waits for the founder**. ARCHITECTURE §8 aligned; F05, F06, F08, F38 updated. |
