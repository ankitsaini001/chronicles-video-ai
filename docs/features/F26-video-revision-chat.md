# F26 — Revision chat on the video

| | |
|---|---|
| **Status** | 🔨 Building (plan approved 2026-11-17) |
| **Phase** | A4 · Generate and review video |
| **Depends on** | F25 |
| **Design** | — (reuses the F18 "Ask for changes" panel) |
| **Data (MongoDB / storage)** | `revisions` (`stage: video`), `jobs` (`revise`), `speechArtifacts` (reuse); no new collection |
| **API endpoints** (docs/API.md) | D5 (stage: video), D6 (stage filter), C6, E2, D8 |

## Goal
Ask for changes after watching; creates a new storyboard version to approve again.

## What you will see
The 'Ask for changes' tab on the review screen.

## In scope
- Revision → new version → 'Approve & make new video'
- Only changed scenes get new narration

## Not in this feature
- Approving straight from the video page (approval stays on the storyboard, where the changes are visible)
- Changing the language (refused with a reply suggesting a new project, as in F18)

## Decisions (founder, 2026-11-17; plan approved)
1. **"Ask for changes" tab** on the video page (`/projects/[id]/video`, next to Captions), reusing the F18 panel: **Whole video** or one scene, a 3–500 character request, Send (D5 `stage: video`). The history shows only the video-stage changes (D6 `stage=video`). Each change uses 1 of the project's 20 AI requests (same rule as F18).
2. **While the change runs:** the progress line ("Updating your storyboard…" / "Updating scene N…"); the current video stays playable and downloadable; caption fixes and other changes wait (one job at a time).
3. **When it succeeds:** the app goes to the storyboard page (changed scenes tagged "Changed"), with a note on the cost of the new video: which scenes get new narration and about how many voice characters, and that the other scenes reuse their recording. The approve button reads **"Approve & make new video"** when the project already has a video; it counts 1 of the 3 videos today (a `generate` job, as in F23). **Back to video** shows the older video, which is kept (`currentRenderId` unchanged until the new video is ready).
4. **An unclear request** ("make it better") ends with a reply question, no new version, and the creator stays on the video page (F18's `rejected` / `needs_input` rule).
5. **The new video** is the next "Video version N"; older versions stay.
6. **No real AI or voice calls by agents:** tests use stand-in Gemini and voice on `bytereel_test`.

## Steps
_Filled in while building._

## How to try it (founder)
_Filled in when it is ready._

## Known limits
_Filled in while building._

## How we test it (done when all are ticked)
- [ ] Change appears in the new video
- [ ] Unchanged scenes reuse their narration (no extra cost)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-17 | Plan approved by the founder (decisions 1–6). |
