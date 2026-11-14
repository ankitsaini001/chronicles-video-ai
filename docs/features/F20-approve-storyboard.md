# F20 — Approve storyboard (approval #1)

| | |
|---|---|
| **Status** | 🧪 Testing |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F18 |
| **Design** | — |
| **Data (MongoDB / storage)** | `storyboardApprovals` |
| **API endpoints** (docs/API.md) | D8 (video job starts in F23) |

## Goal
'Approve & generate video' locks the exact version that will be turned into a video.

## What you will see
The bottom bar button on the storyboard screen.

## In scope
- Approval tied to the version + hash
- Any later change needs a new approval

## Not in this feature
- —

## Steps
- [x] **1. Endpoint** (`2e26079`): D8 approves the exact current version + plan hash (checks: current, same hash, valid, no job running, `stateVersion`); ONE transaction writes `storyboardApprovals` (or reuses the version's existing one after an undo), an `auditLogs` entry and the project's `approvedPlanVersionId`. **No video job and no videos/day count yet** (F23): the answer is 200 `{ approval, job: null, project }` and the project stays `storyboard_ready` with the approved version current, which is the state F23 continues from. Indexes for F18 and F20.
- [x] **2. Screen** (`5cf50cd`): the bottom bar's **Approve & generate video**; afterwards "✓ Approved · Version N" and "Making the video comes in a later update." No fake progress. Disabled (with the reason) while the version has problems or a change runs. Any later edit, voice switch, change or undo needs a new approval.
- [x **Tests** (`66e7378`, `5eb2247`, `e1fa6b3`): unit tests (657 in total, 18 new for F16–F20, fake planner), `next build`, typecheck; e2e on `bytereel_test` with the Gemini stand-in and a private Inngest Dev Server on 8299 (72 checks, all F16–F20 together); live smoke run with the real Gemini (see the progress log).

**Decisions made while building (please confirm):**
- **D8 in F20 answers 200 with `job: null`** (approval only); F23 adds the video job and the videos/day count. API.md D8 and openapi.yaml say so.
- **A change request whose answer changes nothing** ends as "rejected" with a reply asking what exactly to change (no new version, still counts 1 of the 20 because Gemini was asked). This is how unclear requests ("make it better") end; there is no separate "AI asks a question" format.
- **The AI's chat reply is written by our code** from what changed ("Done. I changed scenes 2 and 3. Now 6 scenes, about 70 seconds."), not by the AI, so it is always true and costs nothing.
- **Editing a scene with two narration parts** and changing both saves two versions (one per part, as D3 is one part per call); Undo then goes back one part at a time.
- **Editing a part's text clears its pronunciation/caption forms** (`speech`/`display`), so the new words are what is spoken and shown.
- **Undo of a voice switch switches the voice chip back** (the project's voice follows the restored version).
- **No Cancel for a running change** (E3 isn't built; a change takes about a minute).
- Revise jobs use the same concurrency as storyboards (2 per creator, 5 in total) instead of ARCHITECTURE's "one per project" (a project already has at most one job).

## How we test it (done when all are ticked)
- [x] Approval saved in Atlas (automated e2e on bytereel_test; please also check `storyboardApprovals` in Atlas after the indexes)
- [x] Editing after approval removes the approval (automated e2e)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## How to try it on your computer
1. Create the new indexes in Atlas once: `npm run db -- indexes --feature F18 --apply` and `npm run db -- indexes --feature F20 --apply`.
2. Terminal 1 `npm run dev`, terminal 2 `npm run inngest` (as in F15).
3. Open a project with a storyboard (My videos → the project, or create one): you land on its storyboard.

## Progress log
| Date | What happened |
|---|---|
| 2026-11-14 | All five built in one go (F16–F20 tested together). Unit tests 657 pass (18 new), typecheck and `next build` pass; e2e `tools/e2e/f16-f20-storyboard.ts` on `bytereel_test` (fake Gemini, Inngest on 8299): 72 checks pass; the F15 e2e still passes. Live smoke (`tools/e2e/f16-f20-smoke-live.ts`, real gemini-3.6-flash): Hindi storyboard "इंद्रधनुष कैसे बनता है?" valid in 25.6 s (1 request: prompt 1,909 tokens, output+thinking 5,659), 5 scenes, 159 words, about 73 s, narration all Devanagari, page marked lang="hi"; English "How do vaccines train the immune system?" (38.0 s, prompt 1,939, output+thinking 8,895) then "make it shorter": revision succeeded in 34.8 s (1 request: prompt 4,194, output+thinking 5,825), 177 → 162 words, about 71 → 65 s, version 2 valid. Waiting for code review and the founder's test. Decisions to confirm: see Steps. |
