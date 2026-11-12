# F02 — Web app skeleton (Next.js + Ember Gold styles)

| | |
|---|---|
| **Status** | 🔄 In progress |
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
- Basic components: primary button, secondary button, card, input, chip (own Tailwind components, no shadcn)
- A style sheet page showing all components and fonts side by side

## Setup notes from the F01 code review (handle while creating apps/web)
- Add `"apps/*"` to the root `package.json` workspaces and decide how `npm run typecheck` covers `apps/web` (root include or its own `tsc`).
- `@bytereel/pipeline` exports raw `.ts` files with extensionless imports: Next.js needs `transpilePackages: ["@bytereel/pipeline"]` and a web tsconfig with `moduleResolution: "bundler"`. Plain `node` can't run the package; keep workers on tsx or add a build step later.
- Don't let the web app import render code: `pipeline/generate-run.ts` lazily imports `./render` (Remotion bundler/renderer). Keep render exports out of what the web imports, or list Remotion in `serverExternalPackages`.
- Pin ONE React version across all workspaces (Remotion breaks with two Reacts). Declare each package's own dependencies (React as a peerDependency of `@bytereel/video`).

## Not in this feature
- Environment variable check (moved to F06, the first feature that needs a secret)
- shadcn/ui component kit (not needed for our simple components; can be added later)
- Database
- Login
- Any real page content

## Steps
- [x] 1. Create the Next.js app in apps/web, register the workspace, one React version
- [x] 2. Add Tailwind + Ember Gold colour tokens
- [x] 3. Add the 4 fonts (self-hosted)
- [x] 4. Build the 5 basic components + style sheet page
- [ ] 5. Typecheck/tests cover the web app; prototype tests still pass
- [ ] 6. Founder opens localhost:3000

## How we test it (done when all are ticked)
- [ ] `npm run dev` opens the page
- [ ] Colours and fonts match the Stitch designs
- [ ] Buttons/inputs look like the designs
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-12 | Started. Founder agreed: env check moves to F06; Tailwind only (no shadcn). |
| 2026-11-12 | Step 1: Next.js **16.4.3** (released 2026-10-23; newest 16.4.6 was 3 days old) in `apps/web` (`@bytereel/web`), written by hand (no create-next-app sample files): package.json, tsconfig.json (bundler resolution), next.config.ts, app/layout.tsx, app/page.tsx. Root workspaces = `apps/*`, `packages/*`; root `npm run dev` starts the website. **One React:** react/react-dom 19.2.9 everywhere (single copy in node_modules). `.gitignore`: `.next/`, `next-env.d.ts`. `next dev` added `.next/dev/types/**/*.ts` to the web tsconfig include and generated `apps/web/AGENTS.md` (note for AI tools: read `node_modules/next/dist/docs/` for this version) — kept. Check: page serves HTTP 200 with title "ByteReel"; prototype tests 186/186; typecheck clean. `transpilePackages` not added yet: the web app does not import `@bytereel/pipeline` until F12+. |
| 2026-11-12 | Step 2: Tailwind **4.3.3** + `@tailwindcss/postcss` 4.3.3 (4.3.4/4.3.5 were <2 weeks old), set up as in the bundled Next.js docs (`postcss.config.mjs`, `app/globals.css` with `@import "tailwindcss"`, imported in layout). Ember Gold tokens from BRAND.md §2/§4 in `@theme` (bg, surface, surface-2, screen, amber, amber-deep, amber-light, gold-cream, text, muted, line, on-amber, logo-circle, 4 status pairs, shadow-card, shadow-glow) + utilities `text-gradient-gold`, `bg-button`, `bg-atmosphere`; base styles: dark background, gold-cream focus ring (§9), reduced-motion. Placeholder page shows swatches, status badges and button fill; screenshot checked. Prototype tests 186/186. |
| 2026-11-12 | Step 3: fonts via `next/font/google` (self-hosted, as in the bundled Next.js docs) in `app/fonts.ts`: Exo 2 700/800, Ubuntu 400/500/700, Noto Sans Devanagari 500/600 (devanagari subset), JetBrains Mono 500; CSS variables on `<html>`. Tailwind `font-sans` (Ubuntu, default body 15px/1.55), `font-display` (Exo 2, used by h1–h3 with −0.01em + balanced wrap), `font-mono` (JetBrains Mono); Devanagari is the fallback in every stack so Hindi always uses Noto. Check: screenshot shows all 4 fonts, Hindi conjuncts/nukta correct (चक्र, आवाज़); stylesheet loads 40 woff2 files from `/_next/static/media`, 0 references to Google. |
| 2026-11-12 | Step 4: `apps/web/components/ui/` — `Button` (primary with ↗ circle + glow, small primary, secondary; renders a `<button>` or a Next `<Link>` when `href` is given; full-width centres the label like the Stitch auth screens), `Card`, `Input` (label, helper, error with aria-describedby/aria-invalid; `id` required), `Chip` (selectable, aria-pressed, optional ▶ icon), `cn` helper. All hook-free, so they work in server and client components (password show/hide comes with F08). Developer-only style sheet at `/styleguide` (404 in production builds); home page back to a simple placeholder. Checked by screenshot; web `tsc` clean; prototype tests 186/186. |
