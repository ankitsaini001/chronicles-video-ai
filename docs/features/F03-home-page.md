# F03 — Home page (landing)

| | |
|---|---|
| **Status** | 🔄 In progress |
| **Phase** | A1 · Foundation (project setup) |
| **Depends on** | F02 |
| **Design** | Stitch: ByteReel — Home v2 |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | — |

## Goal
Build the public home page exactly like the approved 'ByteReel — Home v2' design.

## What you will see
The full home page: hero, How it works, Examples, Languages, Why ByteReel, FAQ, footer.

## In scope
- Home page from the Stitch HTML (docs/design/stitch/home.html)
- 'Sign in' and 'Create your first reel' go to /login and /signup (pages come later)
- Mobile layout works

## Notes from the F02 code review
- Make a small `Logo` component: amber play triangle in a `logo-circle` dot + "Byte" + gold-gradient "Reel", **Exo 2 700** (BRAND §6; the F02 placeholder uses 800).
- Glossy 3D tiles: add `@utility bg-tile` (uses `--gradient-tile`) and a `--shadow-tile` token (BRAND §4) when building the hero.
- Wrap Hindi text in `<span lang="hi">` so screen readers read it correctly.
- Use "Log in" (not "Sign in") for the nav button, to match the auth screens (design audit note).

## Not in this feature
- Real sample videos (placeholder images until we have real reels)

## Steps
- [ ] Build sections one by one
- [ ] Check mobile
- [ ] Founder review

## How we test it (done when all are ticked)
- [ ] Page matches the design on desktop
- [ ] Page works on a phone-width screen
- [ ] No voice names, prices or invented stats
- [ ] Links go to the right routes
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
