# F02 — Web app skeleton (Next.js + Ember Gold styles)

| | |
|---|---|
| **Status** | ⬜ Not started |
| **Phase** | A1 · Foundation (project setup) |
| **Depends on** | F01 |
| **Design** | docs/BRAND.md |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | — |

## Goal
Create the empty Next.js app with our brand colours and fonts, so every later screen starts from the same base.

## What you will see
A plain page at http://localhost:3000 with the dark Ember Gold background and the ByteReel logo.

## In scope
- Next.js + TypeScript in `apps/web`
- Tailwind with Ember Gold colour tokens from docs/BRAND.md
- Fonts: Exo 2, Ubuntu, Noto Sans Devanagari, JetBrains Mono
- Basic components: primary button, secondary button, card, input, chip
- Environment variable check on start-up (clear error if a key is missing)

## Not in this feature
- Database
- Login
- Any real page content

## Steps
- [ ] Create the Next.js app in apps/web
- [ ] Add Tailwind + brand tokens
- [ ] Add fonts
- [ ] Build the 5 basic components
- [ ] Add env check
- [ ] Founder opens localhost:3000

## How we test it (done when all are ticked)
- [ ] `npm run dev` opens the page
- [ ] Colours and fonts match the Stitch designs
- [ ] Buttons/inputs look like the designs
- [ ] Missing env key shows a clear message
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| | |
