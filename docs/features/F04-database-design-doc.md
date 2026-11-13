# F04 — Database design document (doc only)

| | |
|---|---|
| **Status** | 🔄 In progress |
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
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Wrote `docs/DATABASE.md` (12 sections): MongoDB explained for a MySQL/Laravel developer; where data lives (your own Atlas M0 cluster, database `bytereel`, files in R2, secrets in env vars); all 25 collections (24 + temporary `healthchecks`) with a fake example, field table, rules and indexes; how they connect; safety and privacy (passwords, encrypted Instagram tokens, owner check, server-owned fields, archive vs delete, account deletion); transactions (§7, as API.md links); indexes summary; size estimate vs 512 MB; backups (none in V1 + manual safety net); what gets created in which feature (A2 = Better Auth collections + `allowlist` + `rateLimits`); glossary; 12 differences from PRD §15; 17 open questions. API.md C5 link fixed to DATABASE.md §6.6. Next: founder reads it. |
