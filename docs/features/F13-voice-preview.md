# F13 — Voice preview samples

| | |
|---|---|
| **Status** | 🧪 Testing (English now, Hindi/Hinglish later: founder, 2026-11-13; code review passed; waiting for the founder's test) |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F12 |
| **Design** | Stitch: ByteReel — Step 1 Idea (▶ next to Female voice / Male voice) |
| **Data (MongoDB / storage)** | — (static MP3 files in `apps/web/public/voices/`: 2 English now, 4 Hindi/Hinglish later) |
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
- [x] **1. Shared voice list** (`0d92cfd`): `packages/db/src/voices.ts` → `VOICE_PRESET_LIST` (6 presets: language, gender, label, sample URL, sentence; no voice names or IDs). One list for the Idea screen, B4 and the recorder. A test keeps it equal to the pipeline's presets.
- [x] **2. One-time recorder** `npm run voices:samples` (`d66ad7a`, `tools/cli/voice-samples.ts`): same ElevenLabs model, voice settings and seed as real videos, 64 kbps MP3 (small). Skips files that already exist (`--force` to redo), shows the characters first and refuses above 600, checks every setting before the first call, ONE call per file (no retries), stops at the first failure. Never prints keys or voice IDs.
- [x] **3. Record the samples** — English done (`30ed871`): `indian-english-female.mp3` (29.8 KB, 3.8 s) and `indian-english-male.mp3` (38.6 KB, 4.9 s). Hindi female was refused with ElevenLabs 402 "Free users cannot use library voices via the API"; the recorder stopped at once. Founder chose **English now, Hindi later**: the 4 Hindi/Hinglish files are recorded after the voice-plan decision (a MUST before F23).
- [x] **4. B4 `GET /api/v1/voices`** (`648a637`): signed-in creators, optional `?language=en|hi|hinglish` (anything else → 400), shared 300/min read limit, `enabled: true` for all until I12.
- [x] **5. ▶ buttons on the Idea screen** (`9e14ded`): a round ▶ right after Female voice and Male voice plays the sample for the chosen language from the static MP3. One plays at a time; pressing it again stops (■); changing the language stops it. While playing, the sentence is shown under the voices (Hindi in `lang="hi"`, Hinglish in `lang="hi-Latn"`). The Voice choice is now a group of real radio buttons (a ▶ button may not sit inside a chip or a radiogroup); it looks and works the same (←/→ choose). With Hindi chosen, the labels read "महिला आवाज़ (Female)" / "पुरुष आवाज़ (Male)" (API.md labels).
- [x] **6. End-to-end check** (`6eed97b`, `f06ae5b`): `tools/e2e/f13-voices.ts` (B4 over HTTP, the MP3s, the ▶ buttons, no ElevenLabs in any page script); the F12 check follows the new Voice markup. Test database only.
- [x] **7. ▶ only where a sample exists** (`cc654d9`): the server checks which MP3s are in `public/voices/` (not empty; looked at again at most once a minute) and the Idea screen shows ▶ only for those; B4 gives `sampleUrl: null` for the others. Recording the Hindi files later turns their ▶ on with no code change. The files are included with the server code, so the check also works on Vercel.

### Hindi voices: English now, Hindi later (founder, 2026-11-13)
The two Hindi voice IDs in `.env` are ElevenLabs **"professional" library voices**; the free plan's API refuses them (402), and the free premade voices are all American/British/Australian (founder checked). So for now only the English ▶ buttons show; with Hindi or Hinglish chosen the voices are there without ▶.
**MUST before F23** (also in F23 and the tracker's *Open decisions*): decide the Hindi/Hinglish voice plan — a paid ElevenLabs plan (also check the free plan's commercial-use/attribution rules) or another text-to-speech service for Hindi; then run `npm run voices:samples` for the 4 missing files (about 202 characters).
Also: ElevenLabs labels both "Indian English" voices with a *British* accent. Please listen to the two samples and decide if they're good enough.

### Characters spent
110 of the about 450 approved (2 English samples × 55). The refused Hindi call was not charged (account read afterwards: 110 / 10,000 used). The 4 remaining samples need about 202 more (48 + 48 + 53 + 53), 312 in total.

### Decisions in this feature (please check)
- **Hinglish pronunciation:** the pipeline already has a rule (Hinglish words that need help are sent in Devanagari, the screen keeps Roman script). The Hinglish sample follows it: it is sent as "Hello दोस्तों! आज हम समझेंगे कि rainbow कैसे बनता है।" and shown as "Hello doston! Aaj hum samjhenge ki rainbow kaise banta hai."
- **The list lives in `packages/db`** (named `VOICE_PRESET_LIST`, because `VOICE_PRESETS` is already the plain list of ids in the pipeline). The web app doesn't use the pipeline package.
- **The Idea screen doesn't call B4**: it reads the same list directly (no extra request). B4 exists and returns the same data.
- **Samples are 64 kbps** (real videos use 128 kbps): a 4-second preview is about 30–40 KB.

### How to try it (founder)
1. `npm run dev`, log in, press **Create your first reel**.
2. English chosen: press ▶ next to Female voice, then next to Male voice (the first stops). Press ■ to stop. Switch the language while playing: it stops.
3. Choose हिंदी Hindi or Hinglish: the voices show without ▶ (no samples yet).
4. Phone: same, the sound starts on the tap. Please also listen for the accent of the two English voices.

## How we test it (done when all are ticked)
- [ ] Each ▶ plays the right language and gender (English now; Hindi/Hinglish show no ▶ until their samples are recorded before F23)
- [x] No ElevenLabs call happens when you click ▶ (only the static MP3 is loaded; e2e: no page script mentions ElevenLabs)
- [x] Code review passed (code-reviewer agent; no must-fix, all 8 suggestions applied)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Started. Founder decided: 6 samples (Hinglish says its own sentence with the Hindi voices), the three sentences above, about 450 ElevenLabs characters, one time. |
| 2026-11-13 | Built steps 1, 2, 4, 5, 6. Recorded 2 of 6 samples (English, 110 characters); Hindi refused by ElevenLabs (402: library voices need a paid plan), recorder stopped as designed. 526 unit tests, typecheck and `next build` pass; e2e F13 (all pass, 4 Hindi/Hinglish files skipped) and F12 (68/68) on `bytereel_test` (dropped afterwards). Waiting for the founder's Hindi voice decision, then the code review. |
| 2026-11-13 | Founder chose **English now, Hindi later** (free premade voices are all American/British/Australian). Spent so far: **110 characters** (Hindi refused with 402 "Free users cannot use library voices via the API", not charged). ▶ now shows only for presets whose MP3 exists (server file check); B4 `sampleUrl: null` otherwise; API.md/openapi updated; MUST added to F23 and the tracker. 530 unit tests, typecheck and `next build` pass; e2e F13 and F12 (68/68) pass on `bytereel_test` (dropped afterwards). Status 🧪, waiting for the code review and the founder's test. |
| 2026-11-13 | Code review: no must-fix. Applied all 8 suggestions. Recorder (`bacb1ae`): checks that ffprobe runs and that voice IDs look right (refused by variable name) before any paid call; a recording whose check fails is kept as `{preset}.mp3.unverified` instead of deleted; after any failure it still shows the account usage, and says "may have been charged" for a timeout or unreadable answer; voice IDs are blanked out of provider errors; a 0-byte file counts as missing; `.part` is always cleaned up; `*.part` / `*.unverified` ignored by git. Player (`4915fc8`): ignores a late error from an older sample, lets go of the file when you leave the page; the "couldn't play" status line is always in the page so screen readers announce it. No ElevenLabs calls (characters spent still 110). 539 unit tests, typecheck and `next build` pass; e2e F13 and F12 (68/68) pass on `bytereel_test` (dropped afterwards). Waiting for the founder's test. |
| 2026-11-13 | Founder noticed the English samples weren't the voices they chose. Reason: on 12 Nov (prototype) the founder's English voices, Ranbir (male) and Riya Rao (female), Indian-accent Voice Library voices, were refused on the free ElevenLabs plan, so `.env` was switched to the free British premade voices Daniel/Alice (originals kept as comments). Founder prefers US English for testing: `.env` now uses the free premade US voices **Eric** (male) and **Matilda** (female); Ranbir/Riya Rao stay as comments for when there's a paid plan. Re-recorded the 2 English samples (about 110 characters; about 220 in total so far). The voice decision before F23 now covers all four chosen voices (Ranbir, Riya Rao, Viraj, Monika Sogam are all library voices). |
