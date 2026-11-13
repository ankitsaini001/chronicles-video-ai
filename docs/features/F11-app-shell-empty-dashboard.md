# F11 — App shell + empty My videos

| | |
|---|---|
| **Status** | ✅ Done |
| **Phase** | A2 · Accounts and database |
| **Depends on** | F09 |
| **Design** | Stitch: ByteReel — My videos (empty) |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | A4, B1 |

## Goal
The logged-in frame (top bar) and the first-visit My videos screen.

## What you will see
Top bar (logo, My videos, Settings, 'Videos today: 0 of 3', bell, avatar) and the empty state.

## In scope
- Top bar on every signed-in page
- /dashboard empty state with 'Create your first reel'
- Tabs Drafts / Ready / Scheduled / Published (empty)
- Avatar menu with Log out

## Not in this feature
- Real project cards (F21)
- Notifications (F32)

## Steps
- [x] 1. Shared limits in one place (`USAGE_LIMITS` in `packages/db/src/usage.ts`: 3 videos/day, 5 projects/day, 3,000 voice characters/month), the day/month periods in the user's timezone (midnight Asia/Kolkata = 18:30Z; month end), and the `/api/v1` read limit (300/min per user) (`9ea0dd7`)
- [x] 2. `/api/v1` foundation (`apps/web/lib/api/v1.ts`, `server.ts`): request id (`X-Request-Id`, also in error bodies), Origin check for POST/PUT/PATCH/DELETE, session with `status: active`, per-user rate limit, error envelope, `Cache-Control: no-store`, plain 500 on unexpected errors. B1 `GET /api/v1/me` (`apps/web/lib/account/me.ts`, `app/api/v1/me/route.ts`); never returns the login-protection fields (`c49403f`)
- [x] 3. App shell for every signed-in page: `app/(app)/layout.tsx` (route group, login check), top bar with logo, My videos, Settings (shown as "Soon", not a link, until F33), "Videos today: 0 of 3" (same function as B1), bell ("No notifications yet" panel, no badge, until F32) and the avatar menu (name, email, My videos, Log out). Phones: My videos, Settings and the pill move to a second row (`08b8abf`)
- [x] 4. `/dashboard` empty state from the Stitch design: tabs Drafts / Ready / Scheduled / Published (`?tab=`), "Create your first reel" → a temporary `/projects/new` page inside the shell ("Step 1 Idea arrives in F12"); the temporary F08/F09 page is gone (`383c1de`)
- [x] 5. End-to-end test over HTTP against `next start` on port 3234 with `bytereel_test` (then dropped); script `tools/e2e/f11-shell.ts` (`c0ecfc0`)
- [x] 6. Docs: API.md (§3.1, B1 notes, §10.3), this file and the tracker
- [x] 7. Review fixes: the day starts at the first real moment when clocks jump forward at midnight (`30b400b`); error pages with one "Try again" button for signed-in pages, the rest of the site and the last-resort global one (`ab44787`); menus close when keyboard focus moves outside them (`696926e`); a TODO for the `/api/v1` pipeline (`3ccdbc2`)

## Before the first POST/PATCH endpoint (B2 or C2): add to the shared `/api/v1` pipeline
Recorded from the F11 review (also a TODO in `apps/web/lib/api/v1.ts`). Add these as `ApiEndpoint` options:
- JSON `Content-Type` required for request bodies → `400 INVALID_INPUT`
- 64 KB body cap → `413 PAYLOAD_TOO_LARGE`, counted while reading the body (like the auth handler), also when there is no Content-Length
- Origin check opt-out, only for the Meta callbacks and anonymous J3 (they are checked by signature instead)
- Admin role check for `/api/v1/admin/*` → `403 FORBIDDEN` (`details.reason: "admin_only"`)

## How we test it (done when all are ticked)
- [x] After login you land here (automated: `/login` and sign-up both go to `/dashboard`; the founder repeats it)
- [x] Looks like the design (founder checks on desktop and phone width)
- [x] Log out from the avatar menu works (automated: sign-out → `/dashboard` and B1 answer "logged out"; the founder clicks it)
- [x] Code review passed (code-reviewer agent)
- [x] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Built steps 1–6 in 6 commits. 441 tests pass (39 new), typecheck and `next build` clean. End-to-end: 46/46 checks pass against `bytereel_test` (F08 and F09 scripts re-run too, all pass; database dropped afterwards). Decisions: Settings is visible as "Settings · Soon" (plain text, no link) until F33; the bell opens a small "No notifications yet" panel and never shows a badge until F32; "Create your first reel" goes to a temporary `/projects/new` page inside the shell (replaced in F12); the design's second "+ New video" button is left out on the empty page (one primary button per screen) and comes back with the cards in F21; tabs are links (`?tab=ready` …) so they survive a reload; B1 usage counts are 0 until counting starts (F12 onwards), `instagram` is `not_connected`, `maintenance` is off (no `settings` document yet). No new indexes, no new packages, no new environment variables. Waiting for code review and the founder's test |
| 2026-11-13 | Code review: no must-fix. Applied: (1) error pages: `app/(app)/error.tsx` (inside the app shell), plus `app/error.tsx` (needed because an error in the app shell's own layout, e.g. the database unreachable during the login check, is caught one level up) and a minimal `app/global-error.tsx`; all show "Something went wrong on our side. Please try again." with one "Try again" button. It uses Next.js 16.3+ `retry()`, which reloads the failed part from the server; `reset()` would only redraw it (`ab44787`); (2) in zones where clocks jump forward at midnight (America/Santiago, America/Havana, also Beirut and Cairo) the daily reset was one hour early; it is now the first real moment of the new day (`30b400b`); (3) the account menu and bell panel close when Tab moves focus outside them (`696926e`); (4) recorded what the `/api/v1` pipeline needs before the first POST/PATCH endpoint (section above, and a TODO in `v1.ts`) (`3ccdbc2`). 448 tests pass, typecheck and `next build` clean; e2e 46/46 against `bytereel_test` (dropped afterwards). Waiting for the founder's test |
| 2026-11-13 | Founder test: a small up/down scrollbar showed under the My videos tabs (the sideways-scroll box was 1px too short for the tab underline); removed the scroll box, the four tabs now fit at 320px (`38bb6a2`). Founder found the empty page too empty; agreed to keep it for now and revisit in F21 (no sidebar; idea noted there). Founder: "looks okay" → ✅. Phase A2 complete. |
