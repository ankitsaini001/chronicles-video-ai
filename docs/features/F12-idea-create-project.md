# F12 — Step 1 Idea: create a project (no AI yet)

| | |
|---|---|
| **Status** | 🧪 Testing (built 2026-11-13; waiting for the code review and the founder's test) |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F11 |
| **Design** | Stitch: ByteReel — Step 1 Idea |
| **Data (MongoDB / storage)** | `projects`, `idempotencyKeys`, `usageCounters` |
| **API endpoints** (docs/API.md) | C2 (without starting the AI job yet) |

## Goal
The Idea screen saves a new project with the topic, language and voice.

## What you will see
The 'ByteReel — Step 1 Idea' screen (without the Brainstorm panel yet).

## In scope
- Topic/notes box (max 5,000 characters)
- Language: English / हिंदी Hindi / Hinglish
- Voice: Female / Male
- 'Create storyboard' saves the project in MongoDB

## Notes from the F02 code review
- Language and voice chips are single choices: wrap each set in a labelled `role="radiogroup"` (the `Chip` uses `aria-pressed` today).
- Wrap Hindi labels in `<span lang="hi">`.

## Not in this feature
- AI storyboard (F15)
- Brainstorm (F14)
- Voice preview (F13)

## Steps
- [x] **1. Database layer** (`04a2a9b`): `packages/db/src/projects.ts` (C2 body rules, title rule, the `Project` answer, saving a project in one transaction, reading a project only for its owner), `idempotency.ts` (remembers each click for 24 h), `usage-counters.ts` (the projects-per-day counter in your timezone), the F12 indexes and the C2 limit of 10 per hour.
- [x] **2. Finish the `/api/v1` pipeline for POST** (`7ce3d63`): JSON only (`Content-Type`), 64 KB body cap counted while reading, strict body check (unknown fields refused), `Idempotency-Key` (a repeat gets the first answer again; same key with a different idea → refused; a 5xx forgets the key so you can retry).
- [x] **3. Real "projects today" count** in `getMe` / `GET /api/v1/me` (`cfa8471`).
- [x] **4. C2 `POST /api/v1/projects`** (`a408d73`): saves the project (state `draft`, no AI job), `201 { project, job: null }`, `429 QUOTA_EXCEEDED` after 5 projects in a day.
- [x] **5. Language/Voice chips as real radio buttons** (`6504eef`): `ChoiceChips` = a labelled `role="radiogroup"`; arrow keys move the choice; Tab reaches only the chosen chip (F02 review note).
- [x] **6. Step 1 Idea screen** at `/projects/new` (`9abba19`): the Stitch design without Brainstorm and voice preview; step indicator 1 Idea → 2 Storyboard → 3 Video → 4 Publish; "Projects today: x of 5" under the button.
- [x] **7. Temporary project page** `/projects/[id]` (`98130eb`): shows your saved idea, language and voice and "The AI storyboard arrives in F15". Only you can open it; anything else is the normal 404 page.
- [x] **8. End-to-end check** `tools/e2e/f12-idea.ts` (`58bc16d`), test database only.

### Decisions in this feature (please check)
- **C2 without AI:** the spec says C2 creates the project in `planning` plus a `plan` job and answers `202`. Until F15 it creates only the project in state **`draft`**, with `planRequestCount: 0`, and answers **`201 { project, job: null }`**. Written down in API.md C2 "Until F15", DATABASE.md and openapi.yaml.
- **Topic or notes:** there is one box. Up to 300 characters it is sent as a *topic*, above that as *notes* (API.md C2 limits: topic 3–300, notes 20–5,000).
- **The 5 projects/day limit is enforced now** (DATABASE.md said "counting in F12, enforcement in F27"). It is checked inside the same transaction that saves the project, so even 8 clicks at the same moment save exactly 5. DATABASE.md §4.14 updated.
- **After "Create storyboard"** you land on `/projects/[id]` (a temporary page; the storyboard page `/projects/[id]/storyboard` comes in F16).

### For you (founder): create the F12 indexes in Atlas
Run once, from the project folder (it only adds indexes; it changes no data):
```
npm run db -- indexes --feature F12 --apply
```
It creates 6 indexes: `projects` (2), `idempotencyKeys` (2, one deletes clicks after 24 h) and `usageCounters` (2, one is unique so the daily count can't be split). Do it **before** creating your first project: the duplicate-click and daily-limit protection rely on the unique indexes. You'll see them in Atlas → Browse Collections → each collection → *Indexes*.

## How we test it (done when all are ticked)
- [x] Project appears in Atlas `projects` with your user id (e2e on `bytereel_test`; please check it once in your own Atlas after creating a project)
- [x] 5,000-character limit works (box stops at 5,000; the server refuses 5,001)
- [x] Defaults are English + Female (and your own defaults when you change them later)
- [x] 5 projects per day, then "You've created 5 projects today. Try again tomorrow." with the time it resets
- [x] Only the owner can open `/projects/[id]`
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

### How to try it (founder)
1. Run the index command above.
2. `npm run dev`, log in, press **Create your first reel**.
3. Type a topic, pick a language and voice, press **Create storyboard**. You land on your project page.
4. In Atlas → Browse Collections → `bytereel` → `projects`: your project, with `ownerId` = your user's `_id`.
5. Try an empty box (refused), paste a very long text (stops at 5,000), and the keyboard: Tab to the language chips, then ←/→.

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Built steps 1–8. 488 unit tests, typecheck and `next build` pass; e2e `tools/e2e/f12-idea.ts` passed all 63 checks on `bytereel_test` (dropped afterwards). F12 indexes are NOT applied to the real `bytereel` database yet: founder runs the command above. Status 🧪, waiting for the code review and the founder's test. |
