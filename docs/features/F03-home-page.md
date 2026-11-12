# F03 — Home page (landing)

| | |
|---|---|
| **Status** | ✅ Done |
| **Phase** | A1 · Foundation (project setup) |
| **Depends on** | F02 |
| **Design** | Stitch: ByteReel — Home Landing Page (`docs/design/stitch/home-landing-v1.html`), chosen by the founder on 2026-11-12; was Home v2 |
| **Data (MongoDB / storage)** | — |
| **API endpoints** (docs/API.md) | — |

## Goal
Build the public home page from the 'ByteReel — Home Landing Page' design (founder's choice), with honest copy.

## What you will see
The full home page: hero, How it works, Examples, Languages, Why ByteReel, FAQ, footer.

## In scope
- Home page from the Stitch HTML (docs/design/stitch/home-landing-v1.html)
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
- [x] Build sections one by one
- [x] Check mobile
- [x] Founder review

## How we test it (done when all are ticked)
- [x] Page matches the design on desktop
- [x] Page works on a phone-width screen
- [x] No voice names, prices or invented stats
- [ ] Links go to the right routes
- [x] Code review passed (code-reviewer agent)
- [x] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-12 | Built in one go (founder's per-feature cadence). Sections from the approved `docs/design/stitch/home.html`, copy word for word (checked by a word-level diff; only differences: CSS-uppercase labels and "Sign in" → "Log in"). Components: `components/Logo.tsx` (Exo 2 700), `components/home/{SiteHeader,Hero,sections,SiteFooter}.tsx`; globals: tile gradient/shadow, gold tile text, float animation (motion-safe), smooth scroll. Sample-reel artwork: the 4 SVG illustrations from the Stitch project, self-hosted in `apps/web/public/examples/` (the design's PNG versions were only 200×200; SVGs checked for scripts: none). Deliberate: voice labels on language cards are non-interactive until F13 (samples); links to /login, /signup, /privacy, /terms, /contact 404 until those pages exist. Fixed during build: headline wrapped as "ready- / to-post" (kept the phrase together, 1240px container like the design) and the Explainer tile overlapped the phone label (tiles now positioned around the phone). Checked with screenshots of a production build: desktop 1440 matches the design; phone 390 (via a 390px frame — desktop Chrome can't open a window that narrow) stacks cleanly with no overflow. Note: the founder's running `npm run dev` served a stale stylesheet after the last hero edit — restart the dev server if styles look old. |
| 2026-11-12 | Code review: nothing blocking. Fixed, each in its own commit: headline wraps below 360px instead of being cut off; `data-scroll-behavior="smooth"` so page changes don't scroll-animate (Next 16); title template `%s · ByteReel`; phone mockup read as one image by screen readers; footer links 44px tap targets; header links use `/#…` so they work from other pages; voice labels look non-clickable (same muted style, no amber ▶); bold Hindi weight 700 loaded; examples use one `lang` field, icon names typed. Re-checked: typecheck, production build, screenshots at 320 / 1440. Founder decided: build a Contact page with a mailto link to a dummy address for now. |
| 2026-11-12 | Added `/contact` (founder's decision): heading, short text and an "Email us" mailto button. The address lives in one place, `apps/web/lib/site.ts` (`CONTACT_EMAIL = "contact@example.com"`, a reserved dummy domain); replacing it with the real address is listed in F38. Checked: typecheck, production build, page title "Contact · ByteReel", mailto link, screenshots at 1440 and 390. |
| 2026-11-12 | Founder asked to switch to the first Stitch home design ("Home Landing Page") and its 4 showcase images. Saved the design to `docs/design/stitch/home-landing-v1.html`. Rebuilt hero (detailed phone, 6 tiles), How it works, Showcase, Languages, Why ByteReel, FAQ, final CTA, header, footer. Images: the design's JPEGs at full size (768×1376), cropped to remove AI-added page chrome (fake "Home Landing Page" header, website nav, view counts, "© ByteReel Financial Technologies") and padded to 9:16. Copy deliberately changed from the design (claims V1 can't back up): "Real reels created by educators & coaches" → "What your reels can look like"; fake creators/view counts → "Sample reel · Female/Male voice"; "Join 1,200+ educators" removed; voice names and "Most popular" removed (Female/Male only); YouTube/LinkedIn, regional-language alpha, weekly credits and pricing removed from the FAQ; nav "Features"/"Pricing" → "FAQ"; "Sign In" → "Log in"; "Word-sync" → "Synced captions"; "Free in beta" → "Free in private beta". Code review: fixed headline overflow at 360px, tiles covering phone text, emoji losing colour, hover effects on non-playable sample cards, label readability over images, logo tagline size. Open for the founder: the UPI image shows real bank/wallet logos and a phone labelled "ByteReel App"; the Hindi and Hinglish sample images contain English text (and USD amounts). |
| 2026-11-12 | Founder: blur the bank logos for now (done; image will be replaced by real reels later); endorsement spelled "TechByte Chronicles"; product name may change, so all visible names now come from `apps/web/lib/site.ts`. Sample images renamed `*-v2.jpg` because Next.js kept serving cached old versions under the same name. Founder said OK → ✅. |
