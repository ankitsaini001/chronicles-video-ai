# F23 — Generate the video (narration → timing → render)

| | |
|---|---|
| **Status** | 🧪 Testing (built 2026-11-15; waiting for code review and the founder's test) |
| **Phase** | A4 · Generate and review video |
| **Depends on** | F22, F00 |
| **Design** | Stitch: ByteReel — Step 3 Making video (`docs/design/stitch/step3-making-video.html`) |
| **Data (MongoDB / storage)** | `jobs` (type `generate`), `speechArtifacts`, `renders`, `usageCounters` (`videos`, `voiceChars`, `appVoiceChars`); R2 `users/{ownerId}/speech/…`, `users/{ownerId}/projects/{projectId}/renders/{renderId}/…` |
| **API endpoints** (docs/API.md) | D8, C1, C6, E1–E3 |

## MUST before starting (founder, 2026-11-13)
- [x] **Before F23: decide the Hindi/Hinglish voice plan.** Decided 2026-11-15: **English only for now** (`ENABLED_LANGUAGES = ["en"]`), the free ElevenLabs plan with the free premade voices Matilda (female) and Brian (male). The Hindi voice plan and the 4 missing Hindi preview samples wait until Hindi/Hinglish are switched back on (README "Language switch").
  - Why: the Hindi voice IDs in `.env` are ElevenLabs "professional" library voices; on the free plan the API refuses them (402 "Free users cannot use library voices via the API"), so Hindi/Hinglish narration would fail. The free premade voices are only American/British/Australian (founder checked). Found in F13.
  - Also: ElevenLabs labels both "Indian English" voices (free premade) with a *British* accent: founder to listen and decide if they are good enough.

## MUST from F16–F20 (code review, 2026-11-14)
F20 built approval #1 without the video job. F23 MUST:
- [x] **Offer a generate action when the current version is approved and has no `generate` job.** D8 for that state creates the job (key `gen:{planVersionId}`) reusing the existing `storyboardApprovals` row, counts videos/day, sends `video.generate.requested`, returns `202 { approval, job, project }`. `allowedActions` entry `generate_video`; the storyboard shows **Generate video** next to "✓ Approved · Version N".
- [x] **Rename the storyboard button to "Approve & generate video".**
- [x] **D3/D4/D5/D7 and `currentRenderId`:** kept (founder decision 5 below). Written in API.md D3/D4/D5/D7 and DATABASE.md §4.8.

## MUST from the language switch (2026-11-15)
- [x] **The generate job follows the language switch:** D8 (right after the project is found, before anything is counted or set up), E2 on a video job (first thing in its transaction) and the worker's first step refuse a switched-off language: `422 LANGUAGE_UNAVAILABLE` / job error `LANGUAGE_UNAVAILABLE` (not retryable), before any ElevenLabs call. No `approve_storyboard` / `generate_video` in `allowedActions` for those projects (approving now starts the paid voice job).

## MUST from F22 (code review, 2026-11-14): R2 writers (ARCHITECTURE §9)
- [x] **Speech lock:** the unique `{ownerId, cacheKey}` `speechArtifacts` document is claimed as `pending` with a conditional insert (upsert `$setOnInsert`) **before** calling ElevenLabs; `ready` → reused; another job's fresh claim → this step tries again in 60 s; this job's own claim (a re-run or a retry) or a claim older than 10 min → taken over. The provider's answer is saved on the document **before** the upload, so a crash after the upload never needs a second paid call.
- [x] **A new `renderId` for every render attempt** (made when the render step starts; an attempt that doesn't finish writes no `renders` document).
- [x] **Create-only uploads:** every narration and video file goes up with `{ createOnly: true }`; `already_exists` is accepted only when the stored file has the same SHA-256 (an earlier run of the same step), otherwise it is an error.
- [ ] **Publish (F29/F30) verifies the R2 object's SHA-256 against `renders.mp4Sha256` before sending it to Instagram.** For F30 (written into that feature's file when it starts). F23 stores `renders.mp4Sha256` (also saved on the R2 object).
- [x] `R2ArtifactStore` used directly with keys from `StorageKeys`; `checkBucket()` in the worker's first step.

## MUST from F22b (code review, 2026-11-15): temporary files
- [x] **The generate worker keeps every temporary file inside the project.** Before the first render the worker checks that the process temp folder (`os.tmpdir()`) is inside the project and sets `TMPDIR=<project>/runs/.tmp` if not. The render runs in its own Node process whose `TMPDIR` is the job's own work folder (`runs/.tmp/generate/<renderId>/tmp`), so Remotion's and Chrome's own work (which they leave behind after a cancel) is removed with the work folder. `RenderJob.workDir` is required. (The online render service is decided at go-live, F38.)

## Note from F22b (video style v4, 2026-11-15)
- The render stage draws video style v4 from `timeline.json` + `captions.json` schema version 2 (`compileTimeline`), the scene audio, and `music: BACKGROUND_MUSIC`. Measured here: a 68–86 s video renders in about 3 min on the shared dev machine, files 6–9 MB.

## Goal
Turn the approved storyboard into an MP4 in the background, with progress steps.

## What you will see
The 'ByteReel — Step 3 Making video' screen: a phone frame on the left and the four steps on the right
(Recording narration → Timing animations → Adding captions → Rendering · N%), with **Back to My videos**
and **Cancel**. When it is done: "Your video is ready" with the video's first picture (the thumbnail).
Watching and downloading it is the next feature (F24).

## In scope
- Narration per scene (ElevenLabs, cached per owner, speech lock)
- Timeline + captions (v2)
- Render (on this computer, in the worker; see decision 3)
- MP4 checks, JPEG thumbnail, upload to R2
- Progress: Recording narration → Timing animations → Adding captions → Rendering
- Cancel and Retry; one video at a time
- My videos cards: real thumbnail, "Waiting to start…", "Making video…", "Video ready", "Older version"

## Not in this feature
- Watching, downloading, caption fixes, video revisions (F24–F26); the settings document and admin limits (F27/F36); Vercel Sandbox (F38).

## Decisions (founder, 2026-11-15; plan approved)
1. **English only.** The language switch is enforced in D8, E2 and the worker before any count or ElevenLabs call (`422 LANGUAGE_UNAVAILABLE`).
2. **ElevenLabs free plan**, voices Matilda (female) and Brian (male), whose ids are `ELEVENLABS_VOICE_ID_INDIAN_FEMALE` / `_MALE` in `.env`. Hindi voice ids are not used. No fallback voice: a missing voice stops the job ("Voice service unavailable right now").
3. **Render on this computer** inside the generate worker, with the existing Remotion path, in its own Node process (`packages/pipeline/src/pipeline/render-child.ts`, run with tsx). **Vercel Sandbox is not used now; the online render setup is decided at go-live (F38).** (ARCHITECTURE §15.)
4. **Voice limits.** Each creator keeps 3,000 characters a month; PLUS an **app-wide guard of 9,000 a month** (`APP_VOICE_CHARACTERS_PER_MONTH` in `packages/db/src/usage.ts`), because the free account has 10,000 a month for everybody. Characters are **reserved before calling ElevenLabs**, all the narration a job still has to record at once (so a video never fails on the limit after narration was paid for), and only for recordings that don't exist yet (cached or unchanged scenes are free). Either limit reached: "Voice limit reached this month." (D8/E2 refuse; the job never starts recording). Videos/day (3) counts when D8 accepts a NEW job.
5. **After a storyboard edit the old video stays** the project's video (`currentRenderId` kept by D3/D4/D5/D7), marked "Older version" on its My videos card and noted on the storyboard, until a new video is made.
6. **One render at a time, app-wide:** Inngest concurrency limit 1 (`scope: env`, fixed key) on the whole `generate-video` function. Inngest counts steps, so a render (one step) never overlaps another; other videos show "Waiting to start…" with how many are ahead. The stuck-job rule fails a video job only when the whole video queue has been still for 15 minutes (waiting is never a failure).

### Choices made while building (engineer)
- **The render runs in a child process**, not inside the Next.js server bundle: Remotion (webpack bundler, Chrome, ffmpeg) stays out of Next's build; the child gets its temp folder explicitly; Cancel is one message (Remotion's cancel signal) with a 20 s kill fallback.
- **A render document is written only when the video is ready** (one transaction with the project), so failed or cancelled attempts never take a video number; the attempt in progress is `jobs.render.renderId`.
- **D8 for a switched-off language is refused** (no approve-only path any more): approving now starts the voice job.
- **No `cancelOn`**: each step checks `cancelRequestedAt` itself, so the job always ends in a known state.
- **Characters for a provider retry** of a scene are reserved too (it may be billed again); spent characters are never refunded (cost-safe).
- **The app-wide month is the UTC calendar month.** If the ElevenLabs account resets on another day, two app months can overlap one ElevenLabs month; then ElevenLabs itself refuses at 10,000 and the job fails with "Voice service unavailable right now" (no cost on the free plan).

## Steps
- [x] 1. Render job + child process: timing, captions v2, v4 render with music, JPEG thumbnail at 1.5 s, MP4 checks, cancel signal (`packages/pipeline/src/pipeline/render-job.ts`, `render-child.ts`, `render-protocol.ts`)
- [x] 2. Server: D8 approve & generate (job, limits in order, approval reused), E2 Try again, E3 Cancel, `allowedActions` (`generate_video`, `cancel_job`, `retry_job`), the speech lock, voice reservation, renders, the queue's stuck rule, F23 indexes; storyboard buttons **Approve & generate video** / **Generate video** (`packages/db/src/generate-jobs.ts`, `speech-artifacts.ts`, `renders.ts`, `stuck-jobs.ts`; `apps/web/app/api/v1/...`)
- [x] 3. Worker: Inngest `generate-video` (start → reserve-voice → speech-N → render), R2 uploads, project → video_ready (`apps/web/lib/video/run-generate-job.ts`, `apps/web/inngest/functions/generate-video.ts`)
- [x] 4. Step 3 screen `/projects/[id]/video` (`components/video/MakingVideoScreen.tsx`)
- [x] 5. My videos cards: thumbnail (15-minute private link), waiting / making / ready, "Older version"
- [x] 6. Unit tests; e2e `tools/e2e/f23-generate.ts` (stand-in voice, real render, real R2 upload)
- [x] 7. Docs: API.md, DATABASE.md, ARCHITECTURE.md, README tracker, `.env.example`

## How to try it (founder)
This makes ONE real video with the real ElevenLabs voice (about 1,000 of the month's characters).
1. Create the F23 indexes in Atlas (one time; the speech lock needs the first one):
   `npm run db -- indexes --feature F23 --apply`
   (creates `speechArtifacts.ownerId_cacheKey_unique`, `renders.projectId_renderNumber_unique`, `renders.ownerId_projectId`).
2. Restart both terminals so the new code and the new Inngest function load: stop them (Ctrl+C), then
   `npm run dev` (terminal 1) and `npm run inngest` (terminal 2). In the Inngest page (http://localhost:8288 → Apps) you should see the function **Make the video**.
3. Open My videos → a storyboard you like (English) → **Approve & generate video**.
   (A storyboard you approved earlier shows **Generate video** instead.)
4. You land on "Making your video": the four steps tick off, Rendering shows a percent. You can leave
   and come back; it keeps going. It takes about 3–4 minutes (the render is the long part).
5. When it is ready you see "Your video is ready" with its first picture. My videos shows the
   thumbnail and "Video ready". The files are in Cloudflare → R2 → `reel-app-dev` → `users/<your id>/…`.
   To watch it before F24: open `output.mp4` there and download it.
6. Optional checks: press **Cancel** during "Rendering" (back to the storyboard within seconds;
   **Generate video** starts it again and reuses the recorded narration for free). Edit one sentence
   after the video exists: the card keeps the thumbnail with "Older version".

## How we test it (done when all are ticked)
- [x] A real MP4 is produced and stored in R2 (e2e: real local render + real upload to `reel-app-dev`; stand-in voice)
- [x] Leaving the page doesn't stop it (the job runs in Inngest on the server; the page only polls)
- [x] Retry after a failure works (e2e: busy voice → Try again → the narration is recorded and the render starts)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Voice decision noted: the founder's chosen English voices (Ranbir, Riya Rao) are Voice Library voices that need a paid plan; testing uses the free US voices Brian (male) and Matilda (female). |
| 2026-11-15 | Plan approved by the founder (decisions 1–6 above). Built in small commits on `dev`: render job + child process; D8 approve & generate with the limits in order, E2/E3, allowed actions, speech lock, voice reservation, renders, the queue's stuck rule, F23 indexes; the `generate-video` worker; the Step 3 screen; My videos thumbnails; unit tests (885 pass); a clean `next build`; docs. Everything ran with TMPDIR inside the project. Zero ElevenLabs and zero Gemini calls (stand-ins only). |
| 2026-11-15 | E2E `tools/e2e/f23-generate.ts` on `bytereel_test` (stand-in voice and Gemini, real local renders, real uploads to `reel-app-dev`): **all 62 checks pass**. A 86 s water-cycle video took about 3.5 min from approval to "ready" (render ≈ 3 min, 8.8 MB); the second video waited "Waiting to start… 1 ahead" while the first rendered; Cancel while rendering stopped it in about 7 s; a busy voice → Try again → narration recorded, only the changed scene paid; the older video stayed after an edit; limits refused in order. The R2 test files (test user ids) are kept in the dev bucket. Ready for code review and the founder's test. |
