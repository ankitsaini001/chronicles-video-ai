# F24 — Step 3: watch and download the video

| | |
|---|---|
| **Status** | 🔄 In progress |
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

## Steps
- [ ] 1. Database: list a project's videos (newest first, pages) and find one video of a project (`current` too); the `RenderSummary` shape (`packages/db/src/renders.ts`)
- [ ] 2. API F1 `GET /api/v1/projects/{projectId}/renders` and F3 `GET …/renders/{renderId}/media` (owner only, 404 for others, 409 when not ready, safe download name, never log a link) (`apps/web/lib/video/media.ts`, `apps/web/app/api/v1/projects/[projectId]/renders/…`)
- [ ] 3. Step 3 review screen: player, version picker, Download MP4, notes and links (`apps/web/components/video/ReviewVideoScreen.tsx`, `VideoVersionMenu.tsx`, the video page)
- [ ] 4. Unit tests (`tests/review-video.test.ts`)
- [ ] 5. E2E `tools/e2e/f24-review.ts` (test database, seeded videos that F23's e2e left in the dev bucket)
- [ ] 6. Docs: API.md "as built", tracker

## How to try it (founder)
_Written when the feature is ready._

## How we test it (done when all are ticked)
- [ ] Video plays
- [ ] Download gives the same MP4
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-16 | Plan approved by the founder (decisions 1–4). Started building. |
