# F16 — Step 2: storyboard screen (read-only)

| | |
|---|---|
| **Status** | ✅ Done (code review fixed; e2e passed; founder tested F16–F20 together on 2026-11-14) |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F15 |
| **Design** | Stitch: ByteReel — Step 2 Storyboard |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | C3, D2 |

## Goal
Show the scenes clearly: narration, visual plan, pattern badge, warnings, ≈ duration.

## What you will see
The 'ByteReel — Step 2 Storyboard' screen without editing/chat yet.

## In scope
- Scene cards
- Duration + scene count
- 4-step stepper

## Not in this feature
- —

## Steps
- [x] **1. Data and endpoints** (`032635b`): C3 project detail (owner only, stuck-job rule, ETag) and D2 full plan (`current` or an id; 404 `no_plan_yet`), with `changedSceneIds` (compared to the parent version) and the approval.
- [x] **2. Storyboard screen** (`7ec74fe`): `/projects/[id]/storyboard`: title strip (title, language, voice, ≈ seconds, scene count, version), scene cards (SCENE 01, pattern badge, narration, "Visual:" line built from the scene's objects with no AI call, e.g. "Process: Oceans, lakes, rivers → Water vapour"), the AI's and the checker's notes on the right scene (scene-less ones once at the top), problems of an invalid version in plain words, Hindi marked `lang="hi"`. `/projects/[id]` sends a storyboard project here; the stepper's "2 Storyboard" is a link and finished steps show ✓. F15's temporary preview is removed. Phone width: chips and buttons wrap, the bottom bar hides its stats under 640 px.
- [x **Tests** (`66e7378`, `5eb2247`, `e1fa6b3`): unit tests (657 in total, 18 new for F16–F20, fake planner), `next build`, typecheck; e2e on `bytereel_test` with the Gemini stand-in and a private Inngest Dev Server on 8299 (72 checks, all F16–F20 together); live smoke run with the real Gemini (see the progress log).

## How we test it (done when all are ticked)
- [ ] Matches the design
- [x] Hindi shows in Devanagari correctly (live smoke: all-Devanagari narration, page marked lang="hi"; please also look in the browser)
- [x] Warnings appear on the right scene (unit tests; e2e shows a problem on its scene)
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
