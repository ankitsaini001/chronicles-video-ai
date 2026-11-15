# F23 — Generate the video (narration → timing → render)

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A4 · Generate and review video |
| **Depends on** | F22, F00 |
| **Design** | Stitch: ByteReel — Step 3 Making video |
| **Data (MongoDB / storage)** | `jobs`, `speechArtifacts`, `renders` |
| **API endpoints** (docs/API.md) | D8, C6, E1–E3 |

## MUST before starting (founder, 2026-11-13)
- [ ] **Before F23: decide the Hindi/Hinglish voice plan** — a paid ElevenLabs plan (also check the free plan's commercial-use/attribution rules) or another text-to-speech service for Hindi; then run `npm run voices:samples` for the 4 missing preview files (about 202 characters).
  - Why: the Hindi voice IDs in `.env` are ElevenLabs "professional" library voices; on the free plan the API refuses them (402 "Free users cannot use library voices via the API"), so Hindi/Hinglish narration would fail. The free premade voices are only American/British/Australian (founder checked). Found in F13.
  - Also: ElevenLabs labels both "Indian English" voices (free premade) with a *British* accent: founder to listen and decide if they are good enough.

## MUST from F16–F20 (code review, 2026-11-14)
F20 built approval #1 without the video job. F23 MUST:
- [ ] **Offer a generate action when the current version is approved and has no `generate` job.** After F20 a project can be `storyboard_ready` with `approvedPlanVersionId === currentPlanVersionId` and no job (the bar then shows only "✓ Approved"). D8 for that state (and for an approval made before F23) must create the `generate` job (key `gen:{planVersionId}`) reusing the existing `storyboardApprovals` row (no second row), count the videos/day quota, send `video.generate.requested`, and return the documented `202 { approval, job, project }`. Add the matching `allowedActions` entry and a visible button for that state.
- [ ] **Rename the storyboard button to "Approve & generate video"** (it reads "Approve storyboard" until F23; `components/storyboard/StoryboardScreen.tsx`).
- [ ] **Decide what D3/D4/D5/D7 do to `currentRenderId` when they move a project out of `video_ready`** (today they set `storyboard_ready` and leave `currentRenderId` as it is): keep the old render as "the video" until a new one is ready, or clear it; and what ③ Video shows meanwhile. Write it in API.md D3/D4/D5/D7 and DATABASE.md §4.8.

## MUST from the language switch (2026-11-15)
- [ ] **The generate job follows the language switch:** D8's generate path and E2's generate retry call `assertLanguageEnabled(project.language)` (packages/db/src/projects.ts) **before** counting videos/day or voice characters and before any ElevenLabs call → `422 LANGUAGE_UNAVAILABLE`. The worker also refuses a queued job for a switched-off language before calling ElevenLabs (a job queued before a switch-off, or re-sent by the stuck-job rule). No `generate` action in `allowedActions` for those projects. English only while `ENABLED_LANGUAGES = ["en"]`.

## MUST from F22 (code review, 2026-11-14): R2 writers (ARCHITECTURE §9)
- [ ] **Speech lock:** the unique `{ownerId, cacheKey}` `speechArtifacts` document is the lock. Claim it as `pending` with a conditional insert **before** calling ElevenLabs; the loser waits for `ready` or reuses it (no double payment, no audio and alignment from different requests).
- [ ] **A new `renderId` for every render attempt** (never reuse a render folder).
- [ ] **Create-only uploads for finished artifacts:** `store.put(key, data, { createOnly: true })`; `already_exists` means another attempt got there first.
- [ ] **Publish (F29/F30) verifies the R2 object's SHA-256 against `renders.mp4Sha256` before sending it to Instagram** (write it into that feature's file when it starts).
- [ ] Call `R2ArtifactStore` directly with keys from `StorageKeys` (no ArtifactStore adapter); call `checkBucket()` at worker start.

## Note from F22b (video style v4, 2026-11-15)
- The render stage now draws **video style v4 "hero visuals"** (packages/video, ARCHITECTURE §15.6): it needs `timeline.json` + `captions.json` **schema version 2** (hero track, caption words) from `compileTimeline`, the scene audio, and `music: BACKGROUND_MUSIC` (the code-generated music bed is written into the render's public folder by `renderExplainer`). Pass `workDir` so the Remotion bundle stays in the job's temp folder.
- **Render time is now about 2 minutes locally** for a 68 s video (about 105 s idle and up to about 140 s busy on the 8-thread dev machine; old engine 78 s; the approved sample took about 4 minutes before the speed work), files about 7 MB. Budget the "Rendering" progress step for **up to about 4 minutes** on slower hosts (Vercel Sandbox with fewer vCPUs, cold start); measure it in the Sandbox benchmark (ARCHITECTURE §15.5).
- Plans may carry `hero` per narration block; old plans without it render with keyword heroes (no migration).

## Goal
Turn the approved storyboard into an MP4 in the background, with progress steps.

## What you will see
The 'ByteReel — Step 3 Making video' screen.

## In scope
- Narration per scene (ElevenLabs, cached)
- Timeline + captions
- Render (Vercel Sandbox)
- Upload to R2
- Progress: Recording narration → Timing animations → Adding captions → Rendering
- Cancel and Retry

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] A real MP4 is produced and stored in R2
- [ ] Leaving the page doesn't stop it
- [ ] Retry after a failure works
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |

> **Update 2026-11-13:** the voice decision covers the English voices too. The founder's chosen English voices, Ranbir (male) and Riya Rao (female), are also Voice Library voices that need a paid plan; testing uses the free US voices Brian (male) and Matilda (female).
