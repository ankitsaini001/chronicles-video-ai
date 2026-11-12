# F12 — Step 1 Idea: create a project (no AI yet)

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F11 |
| **Design** | Stitch: ByteReel — Step 1 Idea |
| **Data (MongoDB / storage)** | `projects` |
| **API endpoints** (docs/API.md) | C2 (without starting the AI job yet) |

## Goal
The Idea screen saves a new project with the topic, language and voice.

## What you will see
The 'ByteReel — Step 1 Idea' screen (without the Brainstorm panel yet).

## In scope
- Topic/notes box (max 5,000 characters)
- Language: English / हिंदी Hindi / Hinglish
- Voice: Female / Male
- 'Create storyboard' saves the project in MongoDB

## Not in this feature
- AI storyboard (F15)
- Brainstorm (F14)
- Voice preview (F13)

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Project appears in Atlas `projects` with your user id
- [ ] 5,000-character limit works
- [ ] Defaults are English + Female
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
