# F00 — Prototype: first voiced test video

| 2026-11-14 | First voiced video rendered locally: water cycle, Matilda (US female, free plan), 898 ElevenLabs characters (1,173/10,000 this month), 68 s 1080×1920, all 10 checks passed; render 78 s (bundle 28 s), 2 min 10 s end to end. Founder: quality and narration good; animation too plain, wants a more attractive, illustrated, moving style (homepage poster as direction). Next: style sample (free, reuses this narration). |
|---|---|
| **Status** | ✅ Done (2026-11-14: founder watched the MP4; voice and video quality good; feedback: animations need to be more attractive → video style upgrade before F23) |
| **Phase** | A0 · Prototype gate (finish the pipeline test) |
| **Depends on** | — |
| **Design** | — |
| **Data (MongoDB / storage)** | Local files only (no database) |
| **API endpoints** (docs/API.md) | — |

## Goal
Prove the pipeline end to end with real narration before we build the video part of the app.

## What you will see
A local MP4 of 'How the water cycle works' with the Female English voice and synced captions.

## In scope
- Approve the waiting storyboard (local-dev/how-the-water-cycle-works-85b912/v1)
- Generate narration (~950 ElevenLabs characters, cap 1,500)
- Render the MP4 and check sound, captions and timing
- Later (before F23): Hindi + Hinglish test, revision, voice switch, render benchmark

## Not in this feature
- —

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] The MP4 plays with clear narration
- [ ] Captions match the spoken words
- [ ] ElevenLabs usage stays under the 1,500-character cap
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-14 | First voiced video rendered locally: water cycle, Matilda (US female, free plan), 898 ElevenLabs characters (1,173/10,000 this month), 68 s 1080×1920, all 10 checks passed; render 78 s (bundle 28 s), 2 min 10 s end to end. Founder: quality and narration good; animation too plain, wants a more attractive, illustrated, moving style (homepage poster as direction). Next: style sample (free, reuses this narration). |
