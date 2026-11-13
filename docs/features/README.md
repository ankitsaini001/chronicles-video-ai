# ByteReel — Feature Tracker

This folder is our build plan. **One file = one feature.** If we ever lose track, open this page, find the feature marked 🔄, and read its *Progress log*.

## Rules (agreed with the founder, 2026-11-12)
1. **One feature at a time.** Only one feature is 🔄 In progress. We never start the next feature early.
2. **Every feature follows the same flow:**
   1. The small steps are listed in the feature file
   2. Build all steps in one go (each step its own commit), explaining them in plain words in the report. Stop mid-feature only if the founder must act (accounts, keys), a decision is needed, or something unexpected happens (founder's choice, 2026-11-12)
   3. Test: automated tests + the checks in "How we test it"
   4. Code review (code-reviewer agent)
   5. **Founder tests it and says OK**
   6. Mark ✅ Done here and in the feature file. Only then move to the next feature
3. **Keep it simple.** No extra features, no shortcuts that hide where things are.
4. **Real services, set up together.** MongoDB Atlas, Cloudflare R2 and the Meta app are created in the founder's own accounts, step by step, so the founder always knows where the data lives.
5. Update the feature's *Progress log* after every work session.
6. **Git:** all work happens on the `dev` branch. When a feature is ✅ Done, it is committed and pushed to `dev`. At the end of each phase (A1, A2, …), after the founder's OK, `dev` is merged into `main`. `main` only ever holds approved, working code.

## Status legend
⬜ Not started · 🔄 In progress · 🧪 Testing · ✅ Done · ⏸ Parked

## Source documents
[PRD](../../PRD.md) · [Pipeline design](../PIPELINE_DESIGN.md) · [Architecture](../ARCHITECTURE.md) · [API](../API.md) · [Brand](../BRAND.md) · Designs: [docs/design/stitch/](../design/stitch/) and the Stitch project

## Features

### A0 · Prototype gate (finish the pipeline test)

| # | Feature | Depends on | Status |
|---|---|---|---|
| F00 | [Prototype: first voiced test video](F00-prototype-first-voiced-video.md) | — | ⏸ Parked (founder will do it later; must be done before F23) |

### A1 · Foundation (project setup)

| # | Feature | Depends on | Status |
|---|---|---|---|
| F01 | [Repo setup: npm workspaces + move prototype code](F01-repo-workspaces.md) | — | ✅ Done |
| F02 | [Web app skeleton (Next.js + Ember Gold styles)](F02-web-app-skeleton.md) | F01 | ✅ Done |
| F03 | [Home page (landing)](F03-home-page.md) | F02 | ✅ Done |

### A2 · Accounts and database

| # | Feature | Depends on | Status |
|---|---|---|---|
| F04 | [Database design document (doc only)](F04-database-design-doc.md) | — | ✅ Done |
| F05 | [MongoDB Atlas: create the account and database (together)](F05-mongodb-atlas-setup.md) | F04 | ✅ Done |
| F06 | [Connect the app to MongoDB (test record)](F06-mongodb-connect.md) | F05 | ✅ Done |
| F07 | [Allow-list (invite list)](F07-allow-list.md) | F06 | ✅ Done |
| F08 | [Sign up](F08-sign-up.md) | F07 | ✅ Done |
| F09 | [Log in and log out](F09-log-in-out.md) | F08 | ✅ Done |
| F10 | [Access pending page](F10-access-pending.md) | F08 | ✅ Done |
| F11 | [App shell + empty My videos](F11-app-shell-empty-dashboard.md) | F09 | ✅ Done |

### A3 · Idea → Storyboard

| # | Feature | Depends on | Status |
|---|---|---|---|
| F12 | [Step 1 Idea: create a project (no AI yet)](F12-idea-create-project.md) | F11 | 🔨 In progress |
| F13 | [Voice preview samples](F13-voice-preview.md) | F12 | ⬜ Not started |
| F14 | [Brainstorm with AI](F14-brainstorm.md) | F12 | ⬜ Not started |
| F15 | [Generate the storyboard with AI](F15-generate-storyboard.md) | F12 | ⬜ Not started |
| F16 | [Step 2: storyboard screen (read-only)](F16-storyboard-view.md) | F15 | ⬜ Not started |
| F17 | [Edit narration + versions + undo](F17-narration-edit-undo.md) | F16 | ⬜ Not started |
| F18 | [Revision chat on the storyboard](F18-storyboard-revision-chat.md) | F17 | ⬜ Not started |
| F19 | [Switch voice on the storyboard](F19-voice-switch.md) | F16 | ⬜ Not started |
| F20 | [Approve storyboard (approval #1)](F20-approve-storyboard.md) | F18 | ⬜ Not started |
| F21 | [My videos: project cards and tabs](F21-dashboard-project-list.md) | F15 | ⬜ Not started |

### A4 · Generate and review video

| # | Feature | Depends on | Status |
|---|---|---|---|
| F22 | [Cloudflare R2 storage setup (together)](F22-r2-storage.md) | F20 | ⬜ Not started |
| F23 | [Generate the video (narration → timing → render)](F23-generate-video.md) | F22, F00 | ⬜ Not started |
| F24 | [Step 3: watch and download the video](F24-review-video-download.md) | F23 | ⬜ Not started |
| F25 | [Caption fixes](F25-caption-fixes.md) | F24 | ⬜ Not started |
| F26 | [Revision chat on the video](F26-video-revision-chat.md) | F25 | ⬜ Not started |
| F27 | [Daily limits](F27-daily-limits.md) | F23 | ⬜ Not started |

### A5 · Instagram publishing

| # | Feature | Depends on | Status |
|---|---|---|---|
| F28 | [Connect / disconnect Instagram](F28-instagram-connect.md) | F24 | ⬜ Not started |
| F29 | [AI caption + hashtags](F29-ai-caption.md) | F28 | ⬜ Not started |
| F30 | [Publish now (approval #2) + Published screen](F30-publish-now.md) | F29 | ⬜ Not started |
| F31 | [Schedule a post](F31-schedule-post.md) | F30 | ⬜ Not started |
| F32 | [Instagram token refresh + notifications bell](F32-token-refresh-notifications.md) | F31 | ⬜ Not started |

### A6 · Settings, admin and launch

| # | Feature | Depends on | Status |
|---|---|---|---|
| F33 | [Settings page](F33-settings.md) | F32 | ⬜ Not started |
| F34 | [Admin: allow-list and users](F34-admin-allowlist-users.md) | F33 | ⬜ Not started |
| F35 | [Admin: reset-password link + reset page](F35-admin-reset-password.md) | F34 | ⬜ Not started |
| F36 | [Admin: jobs, spend and limits](F36-admin-jobs-spend.md) | F35 | ⬜ Not started |
| F37 | [Meta callbacks + Privacy and Terms pages](F37-meta-callbacks-legal.md) | F28 | ⬜ Not started |
| F38 | [Deploy to production + invite beta users](F38-deploy-production.md) | F37 | ⬜ Not started |

**Next up:** F12 is in progress (Step 1 Idea: create a project). Phases A1 and A2 done (F01–F11).

## Future ideas (not planned yet, nothing built)
Discussed with the founder on 2026-11-13. To be turned into features when the time comes.
- **Waitlist instead of a closed invite list:** people who aren't invited can request access from the Access pending page; the founder approves them (command first, admin page later).
- **Email verification + self-service "Forgot password":** needs an email sending service and the domain (decided before F28/F38). Recommended before opening sign-up to everyone.
- **Public launch sign-up:** email verification + per-account limits + spend ceilings + a bot check (captcha), then drop the approval step. Also (F09 review): move the login lock to a counter keyed by hashed email so unknown emails lock too, and remove the A1 exception (API.md §3.1 Enumeration).
- **First admin account:** a one-time command (e.g. `npm run db -- make-admin <email>`) after the founder signs up; decide before F34.
