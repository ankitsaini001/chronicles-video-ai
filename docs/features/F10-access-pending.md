# F10 — Access pending page

| 2026-11-13 | Built and checked. `next start` on port 3233 with `bytereel_test`: page answers 200 with the right heading and title, "Request access" is a mailto link to the contact email with the subject and message, "Back to home" links to `/`; sign-up with a not-invited email answers 403 `NOT_ALLOWLISTED`, which the sign-up form sends to this page. `bytereel_test` dropped afterwards; port 3000 not touched. 402 tests pass (4 new), typecheck and `next build` clean. Note: until we have a real address, `SITE.contactEmail` is the placeholder `contact@example.com`. Waiting for the founder's test. |
|---|---|
| **Status** | ✅ Done |
| **Phase** | A2 · Accounts and database |
| **Depends on** | F08 |
| **Design** | Stitch: ByteReel — Access pending |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | — |

## Goal
A friendly page for people whose email isn't invited yet.

## What you will see
The 'ByteReel — Access pending' screen.

## In scope
- Page at /access-pending
- 'Request access' opens an email/form link to the team
- 'Back to home'

## Not in this feature
- —

## Steps
- [x] 1. `/access-pending` from the Stitch design: logo, envelope-with-clock icon, "{SITE.name} is in private beta", short explanation, Privacy · Terms footer (shared `AuthShell`, which gained an optional `icon`)
- [x] 2. "Request access" opens the visitor's email app (mailto: `SITE.contactEmail`) with a filled-in subject and a short message (name, what they teach, Instagram handle). No form or email service in V1; the visitor's email is never put in a URL by us. The team then runs `npm run db -- invite add <email>`
- [x] 3. "Back to home" → `/`; signed-in visitors are sent to My videos
- [x] 4. Tests (`tests/request-access.test.ts`) and a check of the built page on port 3233 (test database only)

## How we test it (done when all are ticked)
- [x] Not-invited sign-up lands here
- [x] Both buttons work
- [x] Code review passed (main session; small page, no auth or data changes)
- [x] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
| 2026-11-13 | Founder tested the not-invited sign-up, Request access and Back to home. Founder: "looks good" → ✅. |
