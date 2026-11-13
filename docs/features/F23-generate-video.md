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

> **Update 2026-11-13:** the voice decision covers the English voices too. The founder's chosen English voices, Ranbir (male) and Riya Rao (female), are also Voice Library voices that need a paid plan; testing uses the free US voices Eric and Matilda.
