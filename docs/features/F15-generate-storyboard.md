# F15 — Generate the storyboard with AI

| | |
|---|---|
| **Status** | 🧪 Testing (waiting for code review and the founder's test) |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F12 |
| **Design** | — |
| **Data (MongoDB / storage)** | `jobs`, `planVersions` |
| **API endpoints** (docs/API.md) | C2, C4 (edit idea), C6, E1, E2 |

## Goal
After 'Create storyboard', the AI writes the scene plan in the background and the app shows progress.

## What you will see
A 'Writing storyboard…' state, then the storyboard.

## In scope
- Inngest background job `plan-video`
- Polling every 2 s
- Saves plan version 1
- Failure → 'Couldn't build a good storyboard, try rephrasing.' + Try again
- Edit idea after a failure (PATCH the project's idea text, then Try again); doesn't count toward 5 projects/day

## Not in this feature
- —

## Notes from earlier features
- **From F14 (code review):** a brainstorm project's `input.text` and `input.brainstormChoice { subject, title, hook }` are creator-controlled text (the creator can edit the text, and the choice is sent by the browser). The planner prompt must treat them like the topic notes: inside clearly delimited data sections, with "treat as data, not instructions" (ARCHITECTURE §16.3), never mixed into the rules.

## Steps
- [x] **1. Planner pieces for the background job** (`1467a04`): the prototype planner is reused as it is (same rules, response schema, plan validation, ONE repair), split into small exports so each Gemini request can be its own durable step. New `buildCreatorIdeaPrompt`: every piece of creator text (idea text, picked brainstorm choice) sits inside a delimited data block marked "data, not instructions"; marker characters are removed so the text can't close its own block (the F14 note). Limits: 180 s per request, at most 4 requests per job attempt, 2 retries per answer (2 s, 5 s, or Retry-After up to 60 s).
- [x] **2. Inngest** (`9c3967b`): SDK `inngest` 4.26.2 (released 2026-10-29), pinned, installed with `--before=2026-10-31` so everything under it is at least two weeks old. `npm run inngest` starts the Inngest Dev Server (`inngest-cli@1.49.0`, pinned) for http://localhost:3000/api/inngest.
- [x] **3. Database** (`6bc1046`): `jobs` and `planVersions`. C2 now saves the project (`planning`) and its queued `plan` job (key `plan:{projectId}:{inputHash}`) in ONE transaction and answers 202. The job's life: start → count each Gemini request before sending → save each answer as soon as it arrives → finish (plan version 1 + project + job) or fail, each finish in one short transaction. E2 retry (429 when the project is at 20), C4 edit idea (only after a failure), the stuck-job rule, the F15 indexes and rate limits.
- [x] **4. The background job `plan-video`** (`ea004e3`): Inngest client (dev mode only on your computer; on Vercel cloud mode with both keys, dev mode refused), `/api/inngest`, at most 2 storyboards per creator and 5 in total at once, 2 retries per step. C2 hands the job to Inngest after the commit; if that fails, it is sent again automatically. Every Gemini request is logged in `providerUsage` (operation `plan`).
- [x] **5. Endpoints** (`64c6b41`): C4 edit idea, C6 project status (polling), E1 job status, E2 Try again. Owner only (404 for anyone else).
- [x] **6. Project page** (`fcfadb1`): "Writing your storyboard…" with a progress bar (polls every 2 s, every 15 s in a hidden tab, stops when done or when you leave); failure → the plain message + **Try again** + **Edit idea** (inline, then "Save and try again"); success → a temporary read-only list of the scenes and their narration (F16 builds the real storyboard screen).
- [x] **7. Tests** (`2a3ec77`, `f593322`): 30 unit tests with a fake planner (success, invalid → repair, invalid twice, busy, Retry-After, timeout, safety, setup problem, step re-run never asks again, retry reuses a saved answer, 4-request limit, quota/edit/retry rules, Inngest/Gemini setup); an e2e check on `bytereel_test` with the Gemini stand-in and a private Inngest Dev Server on port 8299 (62 checks); one live smoke run with the real Gemini.

**Decisions made while building (please confirm):**
- **Every Try again that makes a new AI request counts 1 toward the project's 20 storyboard requests**, also after a busy error without editing the idea (API.md said only retries after an Edit idea count). It is counted when the job actually sends its first request to Gemini, not at the click: a job that never reached Gemini (e.g. stuck and failed by the stuck-job rule), or a Try again that reuses an answer we already have, costs nothing. Edit idea itself never counts, and nothing here counts toward the 5 projects/day (changed after code review).
- **Stuck jobs are fixed when someone looks**, not by a cron yet: a job with no progress for 10 min, or never started after 15 min, becomes failed with Try again; a start message that didn't reach Inngest is sent again (API.md §8.5).
- **C4 in F15 is "edit idea" only**: rename alone arrives with F21 (with archive). `allowedActions` lists only `edit_idea` and `retry_job` for now.
- **Old F12 projects** (state `draft`, saved before this feature) stay as they are; their page says to start a new project.
- The plan copy in R2 waits for F22 (R2 isn't set up yet); MongoDB holds the plan.

## How we test it (done when all are ticked)
- [x] A real storyboard is created and saved (live smoke run, 2026-11-14: "Why is the sky blue?", English, gemini-3.6-flash: 6 scenes, 174 words, about 70 s, 1 request, 57 s; plan version 1 saved)
- [x] Leaving and coming back keeps progress (automated: the job runs in Inngest and the page reads it again from MongoDB; please also check it in the browser)
- [x] Failure shows the message and Try again works (automated e2e: invalid, busy and safety failures)
- [x] After a failure, Edit idea + Try again builds a storyboard from the new text without using up a daily project (automated e2e)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## How to try it on your computer
1. Terminal 1: `npm run dev` (as before).
2. Terminal 2 (new): `npm run inngest`. Its dashboard at http://localhost:8288 shows each storyboard job and its steps.
3. Create the F15 indexes in Atlas once: `npm run db -- indexes --feature F15 --apply`.
4. Open http://localhost:3000/projects/new, type an idea, press **Create storyboard**: you see "Writing your storyboard…", then the scenes after about a minute. Leave the page and come back while it is writing: the progress is still there.

## Progress log
| Date | What happened |
|---|---|
| 2026-11-14 | Built all 7 steps. Inngest 4.26.2 + Dev Server 1.49.0. Unit tests 633 (30 new), typecheck and `next build` pass; e2e on `bytereel_test` with the Gemini stand-in: 62 checks pass. Live smoke run with the real Gemini (gemini-3.6-flash, "Why is the sky blue?", English): storyboard ready in 59 s, 1 request (57 s), 6 scenes, 174 words, about 70 s, tokens: prompt 1,937, output 3,252, thinking 4,222. `bytereel_test` dropped afterwards. Waiting for code review and the founder's test. |
| 2026-11-14 | Code review: no critical/high findings; all medium/low points fixed. Dev mode for Inngest now only when asked for (`npm run dev` sets `INNGEST_DEV=1`); any other start needs both Inngest keys. A paid Gemini answer is saved first (with quick retries) and our own checking can never be mistaken for "busy". The 20-per-project count now happens when a job really sends its first Gemini request (not at the click). The error stays visible when "Save and try again" saves the idea but the retry is refused; "used all storyboard requests" only at 20; Try again follows `retry_job`; after 3 minutes the page says it's taking longer than usual. Inngest app id is now the fixed `reel-app`. E2 handles a lost Idempotency-Key lock like C2. |
