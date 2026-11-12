# F23 — Generate the video (narration → timing → render)

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A4 · Generate and review video |
| **Depends on** | F22, F00 |
| **Design** | Stitch: ByteReel — Step 3 Making video |
| **Data (MongoDB / storage)** | `jobs`, `speechArtifacts`, `renders` |
| **API endpoints** (docs/API.md) | D8, C6, E1–E3 |

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
