# F00 — Prototype: first voiced test video

| | |
|---|---|
| **Status** | ⏸ Parked (founder will do it later; must be done before F23) |
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
| | |
