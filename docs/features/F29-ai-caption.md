# F29 — AI caption + hashtags

| 2026-11-24 | Plan approved by the founder (decisions 1–6); building with stand-ins. |
|---|---|
| **Status** | 🔨 Building (built with stand-ins 2026-11-24; next: code review, then the founder's test after F28's real connect) |
| **Phase** | A5 · Instagram publishing |
| **Depends on** | F28 |
| **Design** | Stitch: ByteReel — Step 4 Publish (CAPTION block) |
| **Data (MongoDB / storage)** | `projects.captionDraft` (new, decision 2) |
| **API endpoints** (docs/API.md) | H1, H7 (new: save the caption) |

## Goal
Suggest an Instagram caption and hashtags in the project language; fully editable.

## What you will see
Caption box and '✨ Suggest again' on the Publish screen.

## In scope
- Gemini caption
- Editable
- 2,200-character limit

## Not in this feature
- When (now / schedule), the approval tick and Publish now (F30, F31)

## Decisions (founder, 2026-11-24; plan approved)
1. **First suggestion appears automatically** the first time Step 4 opens with Instagram connected and no saved caption; it is saved. After that only **✨ Suggest again** asks the AI.
2. **The caption is saved on the project on the server** (`captionDraft`: text + when + whether AI-made), so it survives a reload or another device and reopening never spends AI. H1 saves its suggestion; a small save endpoint keeps edits (API.md + DATABASE.md updated; API.md's "not stored" changes).
3. **A suggestion counts toward the project's 20 AI requests**, plus H1's 10/hour. Over the limit → a plain message; typing your own caption always works.
4. **3–5 focused hashtags** (check Meta's current hashtag limit while building); H2's check still allows at most 30.
5. **Caption box only when Instagram is connected** (as in the design).
6. **Built now with stand-ins** (E2E_FAKE_GEMINI, E2E_FAKE_INSTAGRAM) while the founder does the Meta setup; F29 is marked done only after F28.

**What you will see (as approved):** one text box with the caption and its hashtags at the end, a counter "128 / 2,200" (red over the limit), ✨ Suggest again, plain loading and busy messages; above "Publishing comes next" until F30. The AI reads the approved storyboard (title, each scene's narration, project language), writes a short hook-first caption, never invents facts beyond the video.

## Steps
- [x] 1. Server: H1 (Gemini, 30 s, structured output, 20 AI/project + 10/hour, AI usage log), saves `captionDraft`; caption save endpoint
- [x] 2. Screen: caption box, counter, Suggest again on Step 4 (phone + desktop)
- [x] 3. Tests: unit + e2e with stand-in Gemini and Instagram (zero real calls)
- [x] 4. Docs: API.md, openapi.yaml, DATABASE.md, this file, tracker
- [x] 5. Code review + fixes
- [ ] 6. Founder test (~2 Gemini requests, no voice, no video of the day)

## Decisions made while building (2026-11-24)
1. **Model:** the storyboard model `GEMINI_MODEL` (as asked), with `thinkingLevel: "low"` and a 30 s limit. Because brainstorm found gemini-3.6-flash took 55–57 s on the free tier, there is an **optional** `GEMINI_CAPTION_MODEL` (empty = `GEMINI_MODEL`): if the founder test says "busy or taking too long", set it to `gemini-3.1-flash-lite`, no code change. Each timeout still counts 1 of the project's 20 AI requests (same rule as storyboard requests).
2. **Meta's hashtag limit (read 2026-11-24, IG User Media reference, no API call):** "Maximum 2200 characters, 30 hashtags, and 20 @ tags". We suggest 3–5 (decision 4); H2 keeps ≤ 30.
3. **Answer rules:** caption 1–2,000 characters, no hashtag inside it, in the project's script; 3–5 hashtags, each `#` + 1–100 letters/digits/`_` (a missing `#` is added, repeats dropped); **caption + hashtags together ≤ 2,200** (found while testing: 2,000 + five 100-character hashtags would not fit Instagram). Anything else → one repair, then "busy".
4. **Counting:** 1 of the project's 20 AI requests per suggestion, added once right before its first Gemini request in one atomic update that also re-checks the video (retries and the repair add nothing), like D5. Plus `caption-suggestions` 10/hour. No Gemini spend ceiling exists yet (F27), so no `SPEND_CEILING`.
5. **Save endpoint:** **H7 `PUT /api/v1/projects/{projectId}/caption-draft`**, body `{ text }` 0–2,200, 60/minute (`caption-draft`). Characters are counted as Unicode code points everywhere (an emoji is 1), the counter on the page too.
6. **Saving a caption is not a project change:** `stateVersion` and `updatedAt` stay as they are (no "changed in another tab" for the storyboard, no reordering on My videos).
7. **No double AI request:** the page asks once per project per tab (strict mode and remounts), and sends `onlyIfEmpty: true`: if a caption is already saved (another tab, quick reload), H1 answers `409 draft_exists` with it and asks no AI. An empty saved box counts as "no caption".
8. **While the AI writes** (up to 30 s) the box is read-only with "Writing a caption for your video…"; edits are saved first. After a failure typing works at once.
9. **Layout:** the connected card ("Publishing to @username", Disconnect) stays as in F28; the CAPTION card sits below it, and "Publishing comes next…" moved below the caption (it was inside the card).
10. **The saved caption is kept** when the storyboard or video later changes (the creator sees it on Step 4 before publishing; F30's approval hashes the exact caption).

## Code review fixes (2026-11-24)
11. **No double request on a reload:** the count and a **60 s suggestion lease** (`captionSuggestingUntil` + its id) are taken in ONE atomic update that, for `onlyIfEmpty`, also requires an empty box. A second request while one runs → `409 suggestion_in_progress` (Suggest again too, so two tabs can't both spend); the page keeps "Writing…", checks once more after ~10 s, then shows Suggest again. The lease is released after the save and after any failure, and expires by itself after 60 s.
12. **A caption typed while the AI writes is kept:** the `onlyIfEmpty` save only fills an empty box; otherwise H1 returns the typed caption with `applied: false`.
13. **H7 `clientSeq`:** each save from the page carries a growing number; an older or repeated one arriving late is skipped (`applied: false`, `projects.captionDraftSeq`). Text counts as saved only after a successful answer; coming back from the back/forward cache saves what's left. A failure with an answer shows the server's message; only no answer says "Check your internet".
14. **Answer check:** invalid hashtags, repeats and extras beyond 5 are dropped; only fewer than 3 good ones goes to the repair. @mentions and links in the caption go to the repair.
15. **Confirm:** focus goes to Replace when it opens; Escape = Keep mine (focus back on Suggest again). The Gemini free-tier cost constant moved to `apps/web/lib/ai-costs.ts` (brainstorm and caption).
16. **For F30 (noted in its file):** "Caption edits after approval: H7 does not bump stateVersion, so F30 must either set the post to approval_invalidated and notify, inside the same transaction, when the saved text's NFC hash differs from posts.approval.captionHash, or refuse H7 while a live post exists (PRD §7: any caption edit invalidates the approval)."

## Founder test (when F28's real connect works)
1. Open a ready video → **Publish →**. With Instagram connected, the CAPTION box writes a caption by itself (1 Gemini request, ~5–30 s).
2. Reload the page: the same caption, no new request. Edit a word, wait 2 s: "Saved". Reload: your edit is there.
3. Press **✨ Suggest again**: it asks first (your edits would be replaced); press Replace (1 more request).
4. Check the caption fits the video and has 3–5 sensible hashtags. No voice, no video of the day is used. No new index command is needed.

## How we test it (done when all are ticked)
- [ ] Suggestion fits the video
- [ ] Edits are kept
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-24 | Built with stand-ins (zero Gemini/Meta calls): H1 (Gemini 30 s, structured output, 1 of the project's 20 AI requests, 10/hour, usage log with errorCode, saves `captionDraft`), new H7 save endpoint, the CAPTION box on Step 4 (auto-suggest once, Suggest again with a confirm after edits, autosave, n / 2,200 counter, red over). Unit tests 47 (suite 1,199/1,199), e2e `tools/e2e/f29-caption.ts` 31/31, F28 e2e still 43/43, browser check at 390 px and 1440 px 10/10. Found and fixed while testing: an empty box saved an empty caption before the first suggestion (so it never came), and caption + hashtags could exceed 2,200. Docs: API.md H1 as built + H7, openapi.yaml, DATABASE.md, ARCHITECTURE.md, `.env.example` (`GEMINI_CAPTION_MODEL`). |
| 2026-11-24 | Code review fixes (decisions 11–16): atomic count + 60 s suggestion lease (a reload or second tab never spends twice), conditional AI save keeps a caption typed meanwhile, H7 `clientSeq`, saved-only-after-success and back/forward-cache re-sync, confirm focus/Escape, server messages for save failures, softer hashtag check, no @mentions/links, shared cost constant; F30 note on caption edits after approval. Unit tests 54 (suite 1,206/1,206, with an in-memory store that runs the real filters: the reload race, an edit kept, the lease expiring), e2e F29 33/33 (a real two-request race: one count, one Gemini request), F28 43/43, browser 12/12 at 390 px and 1440 px. Still 🔨 until the founder tests. |
