# F24 — Step 3: watch and download the video

| | |
|---|---|
| **Status** | ✅ Done (built and code review fixed 2026-11-16; e2e 29/29; founder played and downloaded the real video and said OK 2026-11-17) |
| **Phase** | A4 · Generate and review video |
| **Depends on** | F23 |
| **Design** | Stitch: ByteReel — Step 3 Review video (`docs/design/stitch/step3-review-video.html`) |
| **Data (MongoDB / storage)** | reads `projects`, `renders`; R2 reads only (15-minute private links). No new collection, no new index |
| **API endpoints** (docs/API.md) | F1, F3 (F2 comes with F25 caption fixes) |

## Goal
Play the finished video and download the MP4.

## What you will see
The 'ByteReel — Step 3 Review video' screen: the video playing in the phone frame on the left; on the
right the title, "Video ready", a **Video version N ▾** picker, **⬇ Download MP4**, "Publish — coming
soon" (greyed out), **Back to My videos** and **Edit storyboard**.

## In scope
- Player with private link
- Download MP4
- Video versions list

## Not in this feature
- The Captions tab and caption fixes (F25, with F2 render detail), "Ask for changes" (F26), publishing (F28+).

## Decisions (founder, 2026-11-16; plan approved)
1. **F1** lists the project's videos, newest first, with `limit`/`cursor` like the storyboard versions (D1). The version picker loads it when it opens.
2. **F3** gives a 15-minute private link (`kind` video / download / thumbnail; `redirect=true` → 302; `current` = the project's video). The download is named after the project title, cleaned up (always ends in `.mp4`, `video.mp4` when nothing is left).
3. **Step 3 screen:** the HTML5 player with the real MP4 and the thumbnail as its poster; an expired link is renewed quietly and the video goes on at the same second. Older videos are never deleted and can still be played and downloaded.
4. No Captions tab and no "Ask for changes" yet; "Continue to publish" is shown as "Publish — coming soon" (disabled).

### Choices made while building (engineer)
- **The page makes the first links itself** (the current video's thumbnail and play link, right after the owner check), so the video is there at once without an extra request. The player asks F3 for a new link only when it needs one (another version chosen, or the 15 minutes ran out). If a fresh link also fails within 10 seconds, it shows "We couldn't play this video. Please reload the page." instead of trying forever.
- **The version picker loads F1 each time it opens** (like the storyboard's "Version N ▾"), so its thumbnail links are always fresh.
- **Download MP4 is the screen's one gold button**, because publishing isn't there yet; "Publish — coming soon" is a grey disabled button. A click first asks for the file's private link, then the browser saves the file and the page stays; a problem (logged out, too many requests, a server error) shows as a plain red line, never a raw error page (code review). Middle-click still opens the link directly.
- **Download name:** the title cleaned up (see API.md F3 "as built"). Apostrophes stay ("Let's…"), double quotes go; joined emoji and Hindi half-letters stay whole (code review). "Why is the sky blue?" downloads as `Why is the sky blue.mp4`.
- **F1 has no `status` filter** (every saved video is ready since F23); API.md says so.
- **A link never reaches a log:** if making one fails, only a plain reason is logged.

## Steps
- [x] 1. Database: list a project's videos (newest first, pages) and find one video of a project (`current` too); the `RenderSummary` shape (`packages/db/src/renders.ts`)
- [x] 2. API F1 `GET /api/v1/projects/{projectId}/renders` and F3 `GET …/renders/{renderId}/media` (owner only, 404 for others, 409 when not ready, safe download name, never log a link) (`apps/web/lib/video/media.ts`, `apps/web/app/api/v1/projects/[projectId]/renders/…`)
- [x] 3. Step 3 review screen: player, version picker, Download MP4, notes and links (`apps/web/components/video/ReviewVideoScreen.tsx`, `VideoVersionMenu.tsx`, the video page)
- [x] 4. Unit tests (`tests/review-video.test.ts`)
- [x] 5. E2E `tools/e2e/f24-review.ts` (test database, seeded videos that F23's e2e left in the dev bucket)
- [x] 6. Docs: API.md "as built", tracker

## How to try it (founder)
No restart is needed: your `npm run dev` picks up the new files by itself. Nothing to set up (no new setting, no new index). Nothing here costs anything (no AI or voice call).
(If the video page shows an error page the first time, reload it once. While building, the page briefly had a file with a typing mistake for a few minutes; if it still shows an error after a reload, stop `npm run dev` with Ctrl+C and start it again.)
1. Open **My videos → Ready** and click the **"Why is the sky blue?"** card.
2. The video page shows your video in the phone frame with its first picture. Press ▶: it plays with sound. Try the timeline (jump forward and back) and full screen.
3. On the right: the title, a green **Video ready**, and **Video version 1 ▾**. Open it: one video, marked "current" and "playing" (a second version appears there after a new video is made; older ones stay and can be played).
4. Press **⬇ Download MP4**. Your browser saves `Why is the sky blue.mp4` (about 6.9 MB). Open it in a video player: it is the same 67-second video.
5. **Publish — coming soon** is greyed out (Instagram comes in F28–F30). **Edit storyboard** and **Back to My videos** work as before.
6. Optional: pause the video, leave the tab for more than 15 minutes, come back and press ▶ or jump ahead. It goes on from the same second (the page fetched a fresh private link quietly).

## Known limits
- The first picture (poster) and the version picker's thumbnails are also 15-minute links. After a long time on the page the poster may not show again until the page is reloaded; the video itself always plays (its link is renewed).
- If the seeded test videos of the F23 e2e are ever deleted from the dev bucket, `tools/e2e/f24-review.ts` needs two other render folders (constants at its top).

## How we test it (done when all are ticked)
- [x] Video plays (e2e: the play link streams, a Range request answers 206 with MP4 bytes; the page has the player)
- [x] Download gives the same MP4 (e2e: the downloaded bytes' SHA-256 equals `renders.mp4Sha256`, for version 2 and the older version 1)
- [x] Code review passed (code-reviewer agent; no blockers, all five findings fixed 2026-11-16)
- [x] Founder tested it and said OK (2026-11-17: "Why is the sky blue?" played in the review screen; Download MP4 works)

## Progress log
| Date | What happened |
|---|---|
| 2026-11-16 | Plan approved by the founder (decisions 1–4). Started building. |
| 2026-11-16 | **Built** in small commits on `dev`: database list/find of a project's videos; API F1 and F3; the Step 3 review screen (player, video versions, Download MP4, older-storyboard note, Publish coming soon); MakingVideoScreen keeps only its waiting/making/failed states. Found and fixed while testing: raw invisible characters in the download-name code (now escapes), and an error's text could have reached the log (now only a plain reason). Unit tests: **952 pass** (27 new in `tests/review-video.test.ts`); typecheck and `next build` clean. **E2E `tools/e2e/f24-review.ts`: 29/29 pass** on `bytereel_test` (port 3234; no Inngest; two real F23 test videos in the dev bucket, read only): F1 newest first with `isCurrent` and paging; the play link streams (206); the download is an attachment named `Why is the sky blue - F24 e2e.mp4` and its SHA-256 equals `mp4Sha256` (8,944,350 bytes); version 1 too (8,810,929 bytes); another user 404 everywhere; not ready 409; the page has the player and the Download link; the Ready card opens it. No link printed in any output or server log. Test server stopped by pid, test database dropped. Zero ElevenLabs and zero Gemini calls; nothing uploaded to or deleted from R2; TMPDIR inside the project throughout. The F23 e2e's ready-page check now expects the player. Ready for code review and the founder's test. |
| 2026-11-16 | **Code review fixed** (no blockers, 5 findings): Download MP4 asks F3 for the link as JSON and shows a plain message on a problem instead of a raw error page (href kept for middle-click); the player's renew-or-give-up and which-answer-counts decisions moved to a small helper (`apps/web/lib/video/player-link.ts`) with unit tests, the 10-second guard now counts from when a link is applied, and a recovered video drops the old message; the download name keeps ZWJ/ZWNJ between two visible characters (emoji sequences, Devanagari half-forms) in both the name and the download header (`removeInvisible` in `packages/storage`), bidi and other invisible characters still removed; API.md fixed (Windows-forbidden characters become a space); the unused `getRender` removed. Unit tests: **960 pass**; typecheck and `next build` clean. **E2E `tools/e2e/f24-review.ts`: 29/29 pass** on `bytereel_test` (port 3234, no Inngest); no link in any output or server log; test server stopped by pid, test database dropped. Zero ElevenLabs and zero Gemini calls; R2 read only; TMPDIR inside the project throughout. Ready for the founder's test. |
| 2026-11-17 | **Founder OK, marked Done.** The founder played the real "Why is the sky blue?" video in the review screen (player, version picker, Download MP4) and said it works. The header shows "Videos today: 1 of 3" (F23 fix). |
