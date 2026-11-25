# F37 — Meta callbacks + Privacy and Terms pages

| | |
|---|---|
| **Status** | 🔨 Part 1 (Privacy + Terms pages) built 2026-11-25, waiting for the founder's read; part 2 (Meta callbacks) waits for the public domain (F38) |
| **Phase** | A6 · Settings, admin and launch |
| **Depends on** | F28 |
| **Design** | No Stitch; home page header/footer and text styles (like Contact) |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | J1–J3 |

## Goal
Required by Meta App Review: deauthorize + data-deletion callbacks and public legal pages.

## What you will see
Privacy, Terms and data-deletion status pages.

## In scope
- Deauthorize callback
- Data-deletion callback + status page
- Privacy + Terms pages. The privacy policy must state the account-deletion rule in plain words (30 days, then erased; anonymous usage statistics kept; DATABASE.md §6.7)
- Before the public launch: a short review of the privacy policy and the deletion rule by someone who knows Indian privacy law (DPDP Act)

## Not in this feature
- —

## Part 1 decisions (founder, 2026-11-25)
1. Operator named on the pages: **TechByte Chronicles, Pune, Maharashtra, India** (`SITE.operator`).
2. Contact, privacy and grievance email: `SITE.contactEmail` (real address now; also the Contact and Access pending pages).
3. **Gemini free tier:** the policy says honestly that Google may use free-tier content; **before inviting beta users, switch Gemini to the paid tier** and update the policy (F38 checklist).
4. No Stitch round. 5. A DPDP-aware review before the public launch (unchanged).

## Steps
- [x] 1. `/privacy` (11 sections; `#delete-your-data` = Meta's Data Deletion Instructions link until the callback exists; deletion by email until Settings has Delete account) and `/terms` (13 sections), `components/legal/LegalPage.tsx`, `SITE.operator` + real contact email
- [ ] 2. Founder reads both pages (localhost:3000/privacy, /terms)
- [ ] 3. Part 2: deauthorize + data-deletion callbacks + status page (needs the public domain, F38)

## How we test it (done when all are ticked)
- [ ] Meta test tools accept the callbacks
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-25 | Part 1 built: Privacy Policy and Terms pages (founder's name, city and email). |
