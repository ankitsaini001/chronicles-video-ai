# F29 — AI caption + hashtags

| 2026-11-24 | Plan approved by the founder (decisions 1–6); building with stand-ins. |
|---|---|
| **Status** | 🔨 Building (plan approved 2026-11-24) |
| **Phase** | A5 · Instagram publishing |
| **Depends on** | F28 |
| **Design** | Stitch: ByteReel — Step 4 Publish (CAPTION block) |
| **Data (MongoDB / storage)** | `projects.captionDraft` (new, decision 2) |
| **API endpoints** (docs/API.md) | H1 |

## Goal
Suggest an Instagram caption and hashtags in the project language; fully editable.

## What you will see
Caption box and '✨ Suggest again' on the Publish screen.

## In scope
- Gemini caption
- Editable
- 2,200-character limit

## Not in this feature
- When (now / schedule), the approval tick and Publish now (F30, F31)

## Decisions (founder, 2026-11-24; plan approved)
1. **First suggestion appears automatically** the first time Step 4 opens with Instagram connected and no saved caption; it is saved. After that only **✨ Suggest again** asks the AI.
2. **The caption is saved on the project on the server** (`captionDraft`: text + when + whether AI-made), so it survives a reload or another device and reopening never spends AI. H1 saves its suggestion; a small save endpoint keeps edits (API.md + DATABASE.md updated; API.md's "not stored" changes).
3. **A suggestion counts toward the project's 20 AI requests**, plus H1's 10/hour. Over the limit → a plain message; typing your own caption always works.
4. **3–5 focused hashtags** (check Meta's current hashtag limit while building); H2's check still allows at most 30.
5. **Caption box only when Instagram is connected** (as in the design).
6. **Built now with stand-ins** (E2E_FAKE_GEMINI, E2E_FAKE_INSTAGRAM) while the founder does the Meta setup; F29 is marked done only after F28.

**What you will see (as approved):** one text box with the caption and its hashtags at the end, a counter "128 / 2,200" (red over the limit), ✨ Suggest again, plain loading and busy messages; above "Publishing comes next" until F30. The AI reads the approved storyboard (title, each scene's narration, project language), writes a short hook-first caption, never invents facts beyond the video.

## Steps
- [ ] 1. Server: H1 (Gemini, 30 s, structured output, 20 AI/project + 10/hour, AI usage log), saves `captionDraft`; caption save endpoint
- [ ] 2. Screen: caption box, counter, Suggest again on Step 4 (phone + desktop)
- [ ] 3. Tests: unit + e2e with stand-in Gemini and Instagram (zero real calls)
- [ ] 4. Docs: API.md, openapi.yaml, DATABASE.md, this file, tracker
- [ ] 5. Code review + fixes
- [ ] 6. Founder test (~2 Gemini requests, no voice, no video of the day)

## How we test it (done when all are ticked)
- [ ] Suggestion fits the video
- [ ] Edits are kept
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
