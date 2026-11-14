# F21 — My videos: project cards and tabs

| | |
|---|---|
| **Status** | 🧪 Testing |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F15 |
| **Design** | Stitch: ByteReel — My videos |
| **Data (MongoDB / storage)** | `projects` (archive fields); index `projects.ownerId_updatedAt_id` |
| **API endpoints** (docs/API.md) | C1, C4, C5 |

## Goal
Show all your projects as cards with status, filtered by tabs.

## What you will see
The 'ByteReel — My videos' screen.

## In scope
- Cards: thumbnail, title, language, voice, status, updated time
- Tabs Drafts/Ready/Scheduled/Published
- ⋯ menu: Rename, Archive
- Only YOUR projects are visible
- **Revisit with the founder (from F11, 2026-11-13):** the founder found the first-visit My videos page too empty. No sidebar (only 2 destinations; phones need the width). Idea to decide here: on the empty page, a "How it works" strip (Idea → Storyboard → Video → Post) and three small cards (Today: videos/projects, This month: voice characters, Instagram status) from `getMe()` / B1; hidden once videos exist

## Not in this feature
- No "Archived" tab, no un-archive, no disabled "Soon" UI (founder, 2026-11-14)
- Real thumbnails (F23+), post status on cards (F30), job cancel (E3)

## Decisions (with the founder's brief, 2026-11-14)
- **Tabs:** API.md C1 already defines them, so we use those: Drafts = draft, planning, plan_failed, storyboard_ready, generating, generate_failed · Ready = video_ready, publish_failed · Scheduled = scheduled, publishing · Published = published. (The brief's fallback put publish_failed under Scheduled; API.md wins because it exists.)
- **Archive while a job runs is refused** (409 "We're still working on this video…") instead of cancelling the job: no job can be cancelled yet (E3), and a finishing storyboard job would bring the project back. The card hides ⋯ while a job runs. **Rename too**, because a finishing storyboard job replaces the title with the plan's topic.
- **Archived projects** keep opening by direct link for their owner, on the step they were on, read-only, with an "Archived" note. Other users still get 404.
- **First-visit page** shows while you have no project in My videos (none at all, or every one archived), so an all-archived account gets the welcome page instead of four empty tabs.
- **Cards** get two extra fields from C1: `stateVersion` (so Rename/Archive never overwrite another tab's change) and `storyboardApproved` (to say "Approved").
- **Placeholder thumbnail:** a warm tint per language with the title's first letter, until real thumbnails arrive.

## Steps
- [x] 1. C1 list (own projects, not archived, newest first, tabs, cursor pages), C4 rename, C5 archive, rename/archive in `allowedActions`, F21 index
- [x] 2. Project cards: thumbnail placeholder, title, language, voice, status, updated time, link to the right step, ⋯ menu (Rename, Archive with a confirm step), Load more
- [x] 3. My videos page: + New video, tabs with cards, friendly line for an empty tab; first-visit page (How it works, Today / This month / Instagram cards, Create your first video)
- [x] 4. Archived projects open by direct link, read-only
- [x] 5. Unit tests and e2e check on `bytereel_test` (no AI)
- [x] 6. Docs: API.md, openapi.yaml, DATABASE.md
- [ ] 7. Founder: create the index on the real database: `npm run db -- indexes --feature F21 --apply`

## How we test it (done when all are ticked)
- [x] Projects show with the right status (unit tests + e2e)
- [x] Another user's projects never appear (e2e: list, cursor, rename, archive, pages)
- [x] Rename/Archive work (e2e + checked in the browser)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-14 | Built steps 1–6. 674 unit tests pass, typecheck and `next build` pass, F21 e2e check: all checks pass on `bytereel_test` (dropped afterwards). Checked in the browser: phone width 375 px has no sideways scroll; rename, archive (keyboard too) work. Status 🧪 Testing: waiting for code review and the founder's test | |
