# F17 — Edit narration + versions + undo

| | |
|---|---|
| **Status** | 🧪 Testing |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F16 |
| **Design** | — |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | D1, D3, D7 |

## Goal
Edit a scene's narration inline; each save is a new version; Undo goes back.

## What you will see
Pencil edit on scene cards, 'Version 3 ▾' and '↶ Undo'.

## In scope
- Inline edit → new version
- Version list
- Undo/restore

## Not in this feature
- —

## Steps
- [x] **1. Endpoints** (`e1cfcd3`): D1 version history (newest first, cursor pages), D3 narration edit (a new `user_edit` version checked by the same plan validator as the AI's plans; saved even when invalid, then it can't be approved), D7 undo/restore (no new version; the voice follows the restored plan; an earlier approval of that exact version counts again). One transaction each; the `stateVersion` guard stops two tabs from overwriting each other (409 → "refresh"). No AI call, nothing counted.
- [x] **2. Screen** (`cef38d1`): pencil **Edit** on each card (inline editor, one box per narration part, counter, Escape cancels; after code review one Save of a scene is ONE version (D3 takes all its changed parts, all or nothing), and after Save/Cancel/Undo/restore the keyboard focus goes back to the scene's Edit button or the Version button), **Version N ▾** (list, Restore), **↶ Undo**, a Refresh button after another tab's change, status announced for screen readers.
- [x **Tests** (`66e7378`, `5eb2247`, `e1fa6b3`): unit tests (657 in total, 18 new for F16–F20, fake planner), `next build`, typecheck; e2e on `bytereel_test` with the Gemini stand-in and a private Inngest Dev Server on 8299 (72 checks, all F16–F20 together); live smoke run with the real Gemini (see the progress log).

## How we test it (done when all are ticked)
- [x] Edit saves a new version (automated e2e; please also look in Atlas → planVersions)
- [x] Undo restores the previous text (automated e2e)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## How to try it on your computer
1. Create the new indexes in Atlas once: `npm run db -- indexes --feature F18 --apply` and `npm run db -- indexes --feature F20 --apply`.
2. Terminal 1 `npm run dev`, terminal 2 `npm run inngest` (as in F15).
3. Open a project with a storyboard (My videos → the project, or create one): you land on its storyboard.

## Progress log
| Date | What happened |
|---|---|
| 2026-11-14 | All five built in one go (F16–F20 tested together). Unit tests 657 pass (18 new), typecheck and `next build` pass; e2e `tools/e2e/f16-f20-storyboard.ts` on `bytereel_test` (fake Gemini, Inngest on 8299): 72 checks pass; the F15 e2e still passes. Live smoke (`tools/e2e/f16-f20-smoke-live.ts`, real gemini-3.6-flash): Hindi storyboard "इंद्रधनुष कैसे बनता है?" valid in 25.6 s (1 request: prompt 1,909 tokens, output+thinking 5,659), 5 scenes, 159 words, about 73 s, narration all Devanagari, page marked lang="hi"; English "How do vaccines train the immune system?" (38.0 s, prompt 1,939, output+thinking 8,895) then "make it shorter": revision succeeded in 34.8 s (1 request: prompt 4,194, output+thinking 5,825), 177 → 162 words, about 71 → 65 s, version 2 valid. Waiting for code review and the founder's test. Decisions to confirm: see F20's file. |
| 2026-11-14 | Code review: no critical/high findings; all medium/low points fixed. D3 now saves the edited parts of one scene as ONE version (all or nothing), errors/notices/focus survive the reload, focus returns after save/cancel/undo/restore/voice; storyboard changes refused in `scheduled`/`publish_failed` until F30 (MUST added to F30); F23 MUST list for the generate handoff; collection names in `collections.ts` (no import cycle); change results announced; separate Send/Try again keys; `lang` only on the plan's own text; D7/D8 return the project as C3; plan-video and revise-plan share one limit (2 per creator, 5 in total); button reads "Approve storyboard" with a plain approved state. Unit tests, typecheck and `next build` pass; the e2e waits for Atlas (this computer's address isn't on the Atlas allow list). |
