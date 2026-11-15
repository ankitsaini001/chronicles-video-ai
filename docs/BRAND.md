# ByteReel Brand Guidelines — "Ember Gold"

| | |
|---|---|
| **Version** | 1.0 · 2026-11-12 |
| **Status** | ✅ Approved by the founder |
| **Reference** | [`docs/brand/ember-gold-reference.html`](brand/ember-gold-reference.html) (approved hero + brand sheet) |
| **Product** | ByteReel, by TechByte Chronicles: turns any topic into a ready-to-post explainer Reel |

---

## 1. Personality

**Warm, futuristic, professional.** A dark, premium canvas lit by a warm amber glow, like screen light in a dark studio. Color is vibrant but **used sparingly**: amber for actions, gold gradients for a few key words, everything else calm.

- **Voice:** friendly, confident, simple. Short sentences, active verbs ("Create your first reel", "Publish", "Try again").
- **Audience:** Indian educators, coaches and creators. Supports English, Hindi (हिंदी) and Hinglish.
- **Never:** cluttered, neon-overloaded, festive-by-default, or corporate-cold.

## 2. Color

### Core palette (dark theme, default)
| Token | Hex | Use |
|---|---|---|
| `bg` Warm black | `#0B0806` | Page background |
| `surface` | `#15100B` | Cards, sections, panels |
| `surface-2` | `#1A120A` | Raised elements, chips, phone frame, inputs |
| `amber` (primary) | `#F5A524` | Primary buttons, links, icons, active states, focus |
| `amber-deep` | `#E8901A` | End of the button gradient, pressed/hover states |
| `gold-cream` | `#FFE2A8` | Start of the headline gradient, highlights |
| `text` | `#F7EFE6` | Main text |
| `text-muted` | `#B5A795` | Descriptions, secondary text, placeholders |
| `line` | `#F5A524` at 15% (`#F5A52426`) | Borders, dividers |
| `on-amber` | `#1A1005` | Text and icons on amber buttons |
| `logo-circle` | `#1A1A2E` | Logo mark background |

### Status colors
| State | Text | Background |
|---|---|---|
| Ready / success | `#4ADE80` | `#0F2E1E` |
| Generating / in progress | `#F5A524` | `#2A1D08` |
| Needs review / warning | `#FFD27A` | `#2E2410` |
| Failed / error | `#FB7185` | `#33141B` |

### Gradients and glow
| Name | Value | Use |
|---|---|---|
| Headline gradient | `linear-gradient(180deg, #FFE2A8 0%, #F5B04A 100%)` | **Only 2–5 key words** per headline (e.g. "ready-to-post Reel"), and the "Reel" in the logo |
| Button gradient | `linear-gradient(180deg, #F7B44A, #E8901A)` | Primary buttons |
| Tile gradient | `linear-gradient(150deg, #4A2C10 0%, #1E1208 60%, #120A04 100%)` | Glossy 3D tiles |
| Amber glow | `radial-gradient(circle, #F5A52466, transparent 65%)` | Behind the hero visual; soft glow on the primary button (`0 10px 30px #F5A52466`) |
| Page atmosphere | `radial-gradient(45% 60% at 72% 45%, #F5A52422, transparent 70%)` | Subtle warm light on dark backgrounds |

### Color rules
- **Amber = action.** If it's amber, you can click it. Don't use amber for decoration-only text.
- **One glowing element per screen**: the main call to action.
- No pure white backgrounds and no pure black (`#000`); use the tokens.
- Text contrast must pass WCAG AA (main text on `bg` is ~16:1; muted is ~8:1).

### Light mode ("Ember Day", for the app later)
`bg #FFFBF5`, `surface #FFFFFF`, `text #1C140B`, `muted #6B5D4C`, `amber #E8901A` (buttons keep the same gradient), headline gradient `#F5A524 → #C2560A`, tiles stay dark. The **marketing site is dark only**; light mode is optional for the app.

## 3. Typography

| Role | Font | Weights | Notes |
|---|---|---|---|
| **Display / headings** | **Exo 2** | 700, 800 | Futuristic, rounded and bold. Letter-spacing −0.01em. `text-wrap: balance` |
| **Body / UI** | **Ubuntu** | 400, 500, 700 | Friendly and readable; buttons use 700 |
| **Hindi (Devanagari)** | **Noto Sans Devanagari** | 500, 600 | Used wherever Hindi text appears (Exo 2 / Ubuntu have no Devanagari) |
| **Labels / data** | **JetBrains Mono** | 500 | Small uppercase labels, step numbers (01, 02), durations |

### Type scale (desktop → mobile)
| Token | Size | Line height | Font |
|---|---|---|---|
| `display` | 60px → 36px | 1.05 | Exo 2 800 |
| `h1` | 44px → 30px | 1.1 | Exo 2 800 |
| `h2` | 32px → 24px | 1.15 | Exo 2 700 |
| `h3` | 22px → 19px | 1.25 | Exo 2 700 |
| `tagline` | 19px | 1.3 | Exo 2 700, muted, with amber periods ("Explain. Animate. Post.") |
| `body-lg` | 16px | 1.6 | Ubuntu 400 |
| `body` | 15px | 1.55 | Ubuntu 400 |
| `small` | 13px | 1.5 | Ubuntu 400/500 |
| `label` | 11–12px, uppercase, +0.08em | 1.4 | JetBrains Mono 500 |

Body text max width: ~65 characters.

## 4. Shape, spacing and depth
- **Buttons:** fully rounded pills (`999px`).
- **Cards, tiles, inputs, panels:** `16px` radius (small chips `999px`; small icons `8px`).
- **Spacing scale:** 4, 8, 12, 16, 24, 32, 48, 64, 96 px. Section padding 64–96px desktop, 48px mobile. Side gutter ≥ 16px.
- **Borders:** 1px `line` (amber at 15%).
- **Shadows:** cards `0 20px 50px #00000066`; glossy tiles `inset 0 2px 0 #FFFFFF2A, inset 0 -6px 12px #00000066, 0 12px 26px #00000088, 0 0 22px #F5A52433`.

## 5. Components

| Component | Style |
|---|---|
| **Primary button** | Pill, button gradient, `on-amber` text, Ubuntu 700 15–16px, padding 9px 9px 9px 26px, **arrow circle** on the right (40px circle, `#00000026`, "↗"), amber glow. Hover: lift 2px |
| **Secondary button** | Pill, transparent, 1px `line` border, `text` color |
| **Small primary** (e.g. Sign in) | Pill, button gradient, 10px 20px, soft glow |
| **Chip / eyebrow** | Pill, `surface-2`, 1px `line`, amber-light text (`#F5B65A`), optional emoji |
| **NEW badge** | Tiny pill, amber background, `on-amber` text, 10px bold |
| **Feature point** | 28px rounded square with a mono number (01/02/03) in amber + muted text |
| **Card** | `surface`, 1px `line`, 16px radius |
| **Glossy 3D tile** | Tile gradient + tile shadow, text in a gold gradient (`#FFF0CC → #F5A524`), slightly rotated (−12° to +9°), gentle float animation (6s) |
| **Phone mockup** | 9:18 frame, `surface-2`, 28px radius; screen `#120C07` showing a reel (title, steps, caption) |
| **Status badge** | Pill with status colors (§2) |
| **4-step stepper** | Idea → Storyboard → Video → Publish; done = ✓ + `text`; active = amber pill; upcoming = muted outline |
| **Inputs** | `surface-2`, 1px `line`, 16px radius, `text`; focus ring 2px `gold-cream` |

## 6. Logo
- **Mark:** a play triangle in **amber** inside a dark circle (`#1A1A2E`) with a faint amber glow.
- **Wordmark:** "Byte" in `text` + "**Reel**" in the headline gradient, Exo 2 700.
- Optional endorsement: "by TechByte Chronicles" in `small` muted text.
- Keep clear space ≥ the mark's height; never stretch, recolor or add effects beyond the glow.

## 7. Imagery and motion
- **Hero visual:** a phone showing a real ByteReel explainer, surrounded by floating glossy tiles (e.g. *Explainer, AI, हिंदी, Reels, Voice, 60s*) with an amber halo. No stock photos of people in V1.
- **Icons:** simple line icons, 1.5–2px stroke, amber or muted.
- **Motion:** subtle. Tiles float, buttons lift 2px on hover, sections fade in from a visible state. Respect `prefers-reduced-motion`.
- **Not used:** promo/announcement bars, festive string lights (removed by the founder), heavy particle effects.

### 7.1 Video imagery and motion (video style v4 "hero visuals", approved 2026-11-15, F22b)
Every video uses this one style (code: `packages/video/src`, hero library `packages/video/src/heroes`).
- **Stage:** the dark Ember Gold background (`#0B0806` → `#050302`) with a still amber glow, a soft vignette and a few drifting light motes. No scenery, no landscapes, no mascot.
- **One hero object per sentence:** one big illustrated object (about 520–600 px of the 1080 px width) in the middle of the frame, gently floating; a new object pops in while the old one shrinks away, objects of one family morph (cloud → rain cloud). The planner picks it per narration block from a fixed library of 46 objects (nature and water, money, technology, science and health, time and places, generic); when it does not, a free keyword fallback picks one, else the scene's icon is shown large in a glowing medallion. The screen is never empty and never shows ghost or placeholder outlines.
- **Object look:** rich dark shapes with an amber/gold rim light and a soft glow. Glows are gradient shapes, never blur filters (render speed).
- **Never twice at once:** a small icon in a card or rail is hidden when it shows the same object as the hero.
- **Big, readable diagrams:** titles 56–88 px in the gold gradient, cards and labels 40–66 px (long card labels step down to 32 px and never spill out of their card), numbers up to 140 px; everything inside the Reels safe zone (top 290 px and bottom 420 px kept clear; in the lower half everything ends left of x 940, the right-hand buttons, even at the camera's widest zoom).
- **Layouts per pattern:** hook (when the narration opens with a natural short unit, up to 3 words such as "Did you know…", it slams in over the picture from frame 1, otherwise the gold title is there from frame 1; then the title and a subtitle pill), labeled diagram (the thing in a glowing ring, its parts as big cards), process flow (current step in a big card, numbered step rail with self-drawing arrows and a travelling light), comparison (two columns, each with its hero, a VS badge, ✓/✗ points), timeline (a line that draws from milestone to milestone, the current one named big), chart (a ring around the hero for shares, big bars or a line for values, a count-up card), step sequence ("STEP 2 OF 4", segmented progress, the current step in a big numbered card), takeaway (gold title, the hero inside an endless loop of light, checklist rows that tick).
- **Captions:** phrases of 3–5 words in Inter ExtraBold 66 px, the word being spoken in an amber pill, key terms (numbers and words from the on-screen labels) in amber, over a soft dark band.
- **Motion:** camera punch-in when a new hero arrives, slow push-in and a slight handheld drift, light-wipe transitions between scenes, a thin progress bar at the top. The end card shows only the takeaway: **no "Follow for more"**.
- **Sound:** the narration leads; a soft code-generated music bed sits about 20 dB under it (higher in pauses), with a whoosh at scene changes and soft chimes on checks and values. One switch turns it off (`BACKGROUND_MUSIC`).

## 8. Content patterns (home page)
- **Nav:** logo · How it works · Examples · Hindi voices `NEW` · **Sign in** (small primary).
- **While Hindi is switched off** (`ENABLED_LANGUAGES`, `packages/db/src/languages.ts`; since 2026-11-14) the home page never advertises Hindi: no "Hindi voices NEW" nav item, the हिंदी hero tile reads "Notes", the Hindi sample card is hidden (3 sample cards: one column on phones, 3 columns from 768 px, 960 px wide on desktop), the "Voice & languages" section is hidden, and the copy says "a natural voice" / FAQ "English." Everything comes back when Hindi is switched on.
- **Hero:** chip "🎬 Idea in. Reel out." → tagline "Explain. Animate. Post." → headline "Turn any topic into a **ready-to-post Reel**" → sub-copy → 3 feature points → primary CTA "Create your first reel ↗".
- **Voices are shown only as "Female voice" / "Male voice"** (Hindi UI: "महिला आवाज़" / "पुरुष आवाज़"). **Never show voice artist or narrator names, provider names (e.g. ElevenLabs), voice IDs, accents or audio-quality labels** anywhere in the product or marketing. Which voice is used is a backend configuration.
- Copy rules: name what users recognize, use active verbs, keep errors specific with a fix ("Our AI is very busy right now. Your idea is saved; please try again in a few minutes.").

## 9. Accessibility
- AA contrast for all text; never put muted text on amber.
- Visible focus ring (2px `gold-cream`, 3px offset) on every interactive element.
- Minimum touch target 44×44px; mobile-first layouts.
- Hindi text always uses Noto Sans Devanagari and is checked for correct conjuncts and matras.

## 10. Renaming the product

"ByteReel" is a working name and may change. To keep a rename cheap:

- **Web app (everything users see):** the name lives only in `apps/web/lib/site.ts` (`SITE.name`, `SITE.wordmark`, `SITE.endorsement`). Never type the product name into a component, page title or copy; use `SITE.name`. Changing that file renames every page, title and the logo wordmark (verified on 2026-11-12 by building with a test name: 0 leftovers on `/` and `/contact`).
- **Checklist for a real rename** (outside the web app):
  1. `apps/web/lib/site.ts` (name, wordmark split, endorsement).
  2. Domain, Vercel project, email sender/contact address (F38).
  3. Meta app name and Instagram Login screens; Meta App Review if already submitted (F28/F38).
  4. AI prompt text in `packages/pipeline/src/planning/prompts.ts` (says "storyboard planner for ByteReel"; not shown to users).
  5. CLI banner text in `tools/cli/*.ts` (developer-only).
  6. **Do not change** the Inngest app id `reel-app` (`apps/web/inngest/client.ts`). It is brand-neutral on purpose: changing it makes Inngest Cloud see a new app and can strand running jobs (F15).
  7. **Do not change** the R2 bucket names `reel-app-dev` / `reel-app-prod` (F22). Brand-neutral on purpose: a bucket can't be renamed, only copied to a new one.
  8. Optional, internal only: npm package names `@bytereel/*`, temp-folder prefixes, repo name. Safe to leave.
  9. Docs (`PRD.md`, `docs/*.md`) and the Stitch designs: find-and-replace when convenient.
