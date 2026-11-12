# F02 — Web app skeleton (Next.js + Ember Gold styles)

| | |
|---|---|
| **Status** | ✅ Done |
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
- [x] 5. Typecheck/tests cover the web app; prototype tests still pass
- [x] 6. Founder opens localhost:3000

## How we test it (done when all are ticked)
- [x] `npm run dev` opens the page
- [x] Colours and fonts match the Stitch designs
- [x] Buttons/inputs look like the designs
- [x] Code review passed (code-reviewer agent)
- [x] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-12 | Started. Founder agreed: env check moves to F06; Tailwind only (no shadcn). |
| 2026-11-12 | Step 1: Next.js **16.4.3** (released 2026-10-23; newest 16.4.6 was 3 days old) in `apps/web` (`@bytereel/web`), written by hand (no create-next-app sample files): package.json, tsconfig.json (bundler resolution), next.config.ts, app/layout.tsx, app/page.tsx. Root workspaces = `apps/*`, `packages/*`; root `npm run dev` starts the website. **One React:** react/react-dom 19.2.9 everywhere (single copy in node_modules). `.gitignore`: `.next/`, `next-env.d.ts`. `next dev` added `.next/dev/types/**/*.ts` to the web tsconfig include and generated `apps/web/AGENTS.md` (note for AI tools: read `node_modules/next/dist/docs/` for this version) — kept. Check: page serves HTTP 200 with title "ByteReel"; prototype tests 186/186; typecheck clean. `transpilePackages` not added yet: the web app does not import `@bytereel/pipeline` until F12+. |
| 2026-11-12 | Step 2: Tailwind **4.3.3** + `@tailwindcss/postcss` 4.3.3 (4.3.4/4.3.5 were <2 weeks old), set up as in the bundled Next.js docs (`postcss.config.mjs`, `app/globals.css` with `@import "tailwindcss"`, imported in layout). Ember Gold tokens from BRAND.md §2/§4 in `@theme` (bg, surface, surface-2, screen, amber, amber-deep, amber-light, gold-cream, text, muted, line, on-amber, logo-circle, 4 status pairs, shadow-card, shadow-glow) + utilities `text-gradient-gold`, `bg-button`, `bg-atmosphere`; base styles: dark background, gold-cream focus ring (§9), reduced-motion. Placeholder page shows swatches, status badges and button fill; screenshot checked. Prototype tests 186/186. |
| 2026-11-12 | Step 3: fonts via `next/font/google` (self-hosted, as in the bundled Next.js docs) in `app/fonts.ts`: Exo 2 700/800, Ubuntu 400/500/700, Noto Sans Devanagari 500/600 (devanagari subset), JetBrains Mono 500; CSS variables on `<html>`. Tailwind `font-sans` (Ubuntu, default body 15px/1.55), `font-display` (Exo 2, used by h1–h3 with −0.01em + balanced wrap), `font-mono` (JetBrains Mono); Devanagari is the fallback in every stack so Hindi always uses Noto. Check: screenshot shows all 4 fonts, Hindi conjuncts/nukta correct (चक्र, आवाज़); stylesheet loads 40 woff2 files from `/_next/static/media`, 0 references to Google. |
| 2026-11-12 | Step 4: `apps/web/components/ui/` — `Button` (primary with ↗ circle + glow, small primary, secondary; renders a `<button>` or a Next `<Link>` when `href` is given; full-width centres the label like the Stitch auth screens), `Card`, `Input` (label, helper, error with aria-describedby/aria-invalid; `id` required), `Chip` (selectable, aria-pressed, optional ▶ icon), `cn` helper. All hook-free, so they work in server and client components (password show/hide comes with F08). Developer-only style sheet at `/styleguide` (404 in production builds); home page back to a simple placeholder. Checked by screenshot; web `tsc` clean; prototype tests 186/186. |
| 2026-11-12 | Founder chose **one review per feature** (all steps in one go, report once). Step 5: root `npm run typecheck` = root `tsc` + `npm run typecheck -w @bytereel/web` (web has its own `tsc --noEmit`). Proved it catches web errors with a temporary broken file (exit 1), then removed it. Production build `next build` passes (incl. Next's TypeScript step with TS 7); `next start`: `/` 200, `/styleguide` 404 (developer-only works). Vitest still only runs `tests/` (web has no tests yet). Tests 186/186. |
| 2026-11-12 | **Code review: passed, no blocking issues.** Fixed: (1) removed `aria-disabled` styling from Button (a link can't be truly disabled; disabled actions use `<button>`, `disabled` on the link variant is a type error); (2) placeholder colour `text-muted` (AA contrast, was ~4.4:1); (3) Input helper no longer vanishes when `error=""`; (4) Input merges the caller's `aria-describedby`; (5) web tsconfig now as strict as the root (noUncheckedIndexedAccess, exactOptionalPropertyTypes, noUnused*, verbatimModuleSyntax, …); plus `cursor-pointer` on Button/Chip, `typescript` 7.0.2 declared in apps/web, Input comments (wrapper className, intentional 0-offset focus ring), `lang="hi"` on the style sheet's Hindi. Notes for later moved to F03 (Logo component 700 weight, tile gradient/shadow, lang="hi", "Log in" wording) and F12 (radiogroup chips). Re-check: typecheck clean, next build passes, style sheet screenshot OK, tests 186/186. |
| 2026-11-12 | Founder reviewed and moved on ("start F03"). **F02 ✅ Done.** Pushed to `dev`. |
