# F13 — Voice preview samples

| | |
|---|---|
| **Status** | 🔄 In progress |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F12 |
| **Design** | Stitch: ByteReel — Step 1 Idea (▶ next to Female voice / Male voice) |
| **Data (MongoDB / storage)** | — (6 static MP3 files in `apps/web/public/voices/`) |
| **API endpoints** (docs/API.md) | B4 |

## Goal
▶ buttons play a short pre-recorded sample of the Female/Male voice in the chosen language.

## What you will see
Working ▶ buttons on the Idea screen.

## In scope
- Generate **6** short MP3 samples ONCE (budgeted ElevenLabs characters, about 450 in total): Indian English, Hindi and Hinglish, female and male. Hinglish uses the Hindi voices (PRD decision #18) but says a Hinglish sentence (founder, 2026-11-13).
- Store them in `apps/web/public/voices/{preset}.mp3`
- Only 'Female voice' / 'Male voice' labels, no voice names
- B4 `GET /api/v1/voices`

## Sample sentences (founder, 2026-11-13)
| Language | Shown text (`sampleText`) |
|---|---|
| English | Hello! Today, let's understand how a rainbow is formed. |
| Hindi | नमस्ते! आज हम समझेंगे कि इंद्रधनुष कैसे बनता है। |
| Hinglish | Hello doston! Aaj hum samjhenge ki rainbow kaise banta hai. |

## Not in this feature
- Admin switching a voice off (`enabled: false`): I12. Until then every preset is `enabled: true`.

## Steps
_Filled in as we build._

## How we test it (done when all are ticked)
- [ ] Each ▶ plays the right language and gender
- [ ] No ElevenLabs call happens when you click ▶
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Started. Founder decided: 6 samples (Hinglish says its own sentence with the Hindi voices), the three sentences above, about 450 ElevenLabs characters, one time. |
