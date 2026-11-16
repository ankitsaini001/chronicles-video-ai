# F25 — Caption fixes

| | |
|---|---|
| **Status** | 🧪 Testing (built 2026-11-17; ready for the founder's test) |
| **Phase** | A4 · Generate and review video |
| **Depends on** | F24 |
| **Design** | Stitch: ByteReel — Step 3 Review video, the Captions tab (`docs/design/stitch/step3-review-video.html`) |
| **Data (MongoDB / storage)** | new `captionOverrides`; `jobs` type `caption`; `renders.captionOverrideSetId`; R2: a new render folder per fix. No new index |
| **API endpoints** (docs/API.md) | F2, F4; E2 and E3 extended to caption jobs |

## Goal
Fix a word in the captions without changing the narration audio.

## What you will see
The **Captions** tab on the review screen, under the video's buttons: one row per caption phrase
(its time, e.g. `0:13`, and the phrase in a text box), the note "Fix a word in the captions. The
narration audio stays the same." and the link **Change the spoken words instead → Edit storyboard**.
A changed row turns amber with an **Edited** tag and its own **Undo**. **Save caption fixes** (greyed
out until something changed) shows the progress screen with two steps, *Updating captions →
Rendering*; when it is done the review screen shows the new video, and the older one stays in the
**Video version ▾** picker.

## In scope
- Edit caption rows
- 'Save caption fixes' re-renders
- Does NOT count toward 3 videos/day

## Not in this feature
- Changing the spoken words (that is a storyboard edit: D3, a new video with new narration).
- Caption fixes in `scheduled` / `publish_failed` (they come with publishing, F28–F30, which must also cancel the post's approval).
- The Hindi/Hinglish script rule for caption text (those languages are switched off; F4 refuses them).
- "Ask for changes" on the video (F26).

## Decisions (founder, 2026-11-16; plan approved)
1. **F2** lists the video's caption phrases from its `captions.json` in R2: `{ sceneId, phraseIndex (per scene from 0), text, originalText, startMs, endMs, overridden }`. Owner only (404 otherwise).
2. **F4** (owner only, Idempotency-Key, 10 an hour) only on the project's current video, in `video_ready`, with no job running. Each fix: the phrase exists, unique pairs, 1–200 characters after trimming, and it must **fit on screen** with the compiler's own line breaking and width estimate, at most 2 lines at the normal caption size; otherwise 400 "This caption is too long to fit on screen. Please shorten it." A fix must never fail later in the render or run into the Reels buttons.
3. **One transaction:** a new override set (the previous set's fixes of the same storyboard version + these; a later edit of the same phrase replaces the earlier one), a `caption` job (`cap:{setId}`), the project `generating`. **No usage counter changes** (no videos/day, no voice characters).
4. **Fixes belong to their storyboard version** (simplest choice): a new storyboard version doesn't carry them (see Known limits).
5. **The caption job** shares the one-at-a-time render queue with the video jobs, uses the video's EXISTING recorded narration, makes **zero voice calls** (missing narration → a plain failure, never a recording), applies the fixes per phrase (same start and end; the new words share the time by length; lines re-broken; amber highlights kept only for words that still match), renders with the same style and music, checks the MP4, makes the thumbnail, uploads create-only under a new video id, and saves the next video number as the current video. Progress *Updating captions → Rendering*, with Cancel and Try again. On failure or cancel the project goes back to `video_ready` with the previous video.
6. **UI:** the Captions tab as in the Stitch design (time + phrase rows, "Edited", per-row Undo, the narration note, the Edit storyboard link, Save caption fixes with an Idempotency-Key per save attempt, the server's messages on the row); the progress screen reuses the "Making your video" layout with two steps.

### Choices made while building (engineer)
- **"Fits on screen" has two parts.** The compiler's own `breakLines` (2 lines of its width estimate at the normal size, no shrinking or splitting a long word) AND each line must fit the 850 px caption box the way the video really draws it (ExtraBold letters, the amber pill's padding around every word, the gaps). With today's sizes the second part never trips when the first passes, but it keeps the promise if the sizes ever change. A fix may also not have more words than its phrase has frames (each word needs a frame to light up).
- **Each fix remembers the text it replaced** (`originalText`). The render checks that the phrase still reads that way before changing it, so a fix is never put on the wrong phrase (for example after a future change to how phrases are made). An edit back to the narration's own words simply removes that fix. Saving when nothing would change answers "These captions already read like this."
- **The worker cannot reach the voice code.** It has no voice dependency at all and imports no voice or provider module (a unit test checks the imports). It takes the narration from the video's own `speech[]` list and checks each file's SHA-256 and cache key; the voice setup comes from the recording's saved request, so even a changed voice setting can't affect it.
- **A failed or cancelled fix** leaves the project on the review screen with a red note ("We couldn't update your captions. …" / "Your caption fix was cancelled. …") and **Try again** (E2), as long as that video is still the current one.
- **The stand-in voice now writes one line per call** to `runs/.tmp/e2e/elevenlabs-stand-in-calls.log` (only on the e2e test server), so the e2e can prove a caption fix made no voice request at all.
- **The shared file helpers** of the two workers (create-only upload, old work-folder clean-up) moved to `apps/web/lib/video/render-files.ts`; the video job behaves exactly as before.

## Steps
- [x] 1. Pipeline: apply fixes to compiled phrases (word times, line breaking, drawn width, key terms) and the "fits on screen" rule (`packages/pipeline/src/timing/caption-overrides.ts`); the render job applies them right after compiling; a recording's voice setup from its saved request (`speech.ts`)
- [x] 2. Database: override sets, the F4 transaction, caption jobs (start, progress, finish, end, retry, cancel), the shared queue and stuck-job rule, `edit_captions` (`packages/db/src/caption-fixes.ts`, `generate-jobs.ts`, `stuck-jobs.ts`, `projects.ts`)
- [x] 3. Worker: `fix-captions` Inngest function and `apps/web/lib/video/run-caption-job.ts` (same narration, zero voice calls)
- [x] 4. API F2 and F4; E2/E3 for caption jobs (`apps/web/lib/video/captions.ts`, the routes)
- [x] 5. UI: the Captions tab (`apps/web/components/video/CaptionsPanel.tsx`), the review screen and the two-step progress screen, the card label "Updating captions…"
- [x] 6. Unit tests (`tests/caption-fixes.test.ts`)
- [x] 7. E2E `tools/e2e/f25-captions.ts` (stand-in voice and Gemini, real renders, real uploads)
- [x] 8. Docs: API.md, DATABASE.md, ARCHITECTURE.md "as built", tracker

## How to try it (founder)
**Restart both terminals first** (a new background job was added): stop `npm run dev` and `npm run inngest` with Ctrl+C, then start `npm run dev` again, and when it says Ready, `npm run inngest` in the second terminal. Nothing else to set up (no new setting, no new index). **This costs nothing:** no AI call and no voice characters (your "Voice characters this month" stays the same). It takes about 3 minutes (one render).
1. Open **My videos → Ready** and click **"Why is the sky blue?"**.
2. Under the video's buttons you now see **Captions**: one row per caption with its time. Click a time (e.g. `0:13`): the video plays from there.
3. Pick a caption and change one word (for example a word you'd like spelled differently). The row turns amber with **Edited**. Try **Undo** on it once, then change it again.
4. Optional: type a very long sentence into another row and press **Save caption fixes**: a red line under that row says "This caption is too long to fit on screen. Please shorten it." Press **Undo** on that row.
5. Press **Save caption fixes**. The screen shows **Updating your captions** with two steps, *Updating captions* → *Rendering · N%* (you may leave the page; it keeps working).
6. After about 3 minutes the review screen shows the new video. Play the part you fixed: the caption shows your word, and the narration sounds exactly the same. **Video version 2 ▾** is current; open it and pick version 1 to see that the old video is still there (it plays and downloads).
7. Check the header: **Videos today** and your voice characters didn't change.

## Known limits
- **Fixes belong to their storyboard version.** If you later change the storyboard (narration edit, voice, a change request, undo to another version) and make a new video, the new video starts without the earlier caption fixes; fix them again there.
- If the way captions are cut into phrases ever changes in a later update, a caption fix saved before that update can no longer be applied to its phrase: the fix then fails with "Something went wrong on our side." instead of changing the wrong phrase. Fixing the captions again from the current video works.
- A fix must fit in 2 lines at the normal caption size (about 18 characters a line); a long word can't be shrunk the way the narration's own long words can.
- If a video's recorded narration were ever deleted from storage, its captions can't be fixed ("This video's narration couldn't be found…"); editing the storyboard makes a new video.
- Caption fixes are not offered for Hindi/Hinglish projects while those languages are switched off.

## How we test it (done when all are ticked)
- [x] Fixed caption appears in the new video (e2e: the new `captions.json` in R2 has the fixed text; F2 shows it as overridden)
- [x] Audio is unchanged (e2e: zero voice requests in `providerUsage` and the stand-in's own call log; the same recordings, keys and SHA-256 as video 1; `timeline.json` identical to video 1's)
- [x] Daily count is unchanged (e2e: videos today and both voice counters unchanged after three caption renders)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-16 | Plan approved by the founder (decisions 1–6). |
| 2026-11-17 | **Built** in small commits on `dev` (see Steps). Found while building: the tool layer turned two `\u200B` escapes in the new test into raw invisible characters; caught by the scan before committing and turned back into escapes. Unit tests: **995 pass** (35 new in `tests/caption-fixes.test.ts`); typecheck and `next build` clean. |
| 2026-11-17 | **E2E `tools/e2e/f25-captions.ts`: 57/57 pass** on `bytereel_test` (port 3235, a private Inngest on 8299; stand-in voice and Gemini; three real local renders and real uploads to `reel-app-dev` under test user ids). Video 1 ("Why is the sky blue?", 48 caption phrases) took 196 s; the caption fix took 184 s (*Updating captions… → Rendering · 0–90% → Checking → Saving*). The new `captions.json` in R2 has the fixed text with its `originalText`; every other phrase and the whole `timeline.json` are identical to video 1's; the same 6 recordings (keys and SHA-256). **Zero voice requests**: `providerUsage` 6 → 6, the stand-in's call log 6 → 6, voice characters 1,160 → 1,160 (creator and app), videos today 1 → 1, after three caption renders. Too long → 400 with the message and path; unknown phrase, duplicate pair, no key → 400; older tab → 409; while rendering → 409 JOB_ALREADY_RUNNING; another user → 404 everywhere; a second fix added up (both fixes in the set), Cancel while rendering stopped it in 6.9 s with video 2 still current, Try again made video 3 with both fixes; video 1 still downloads. No work folder left; no signed link in any output or log. Test servers stopped by pid, test database dropped. The R2 test files stay (33 keys under the test user, listed at the end of `runs/f25-work/e2e.out`). Zero real ElevenLabs and Gemini calls; TMPDIR inside the project throughout. Ready for code review and the founder's test. |
