# F22b — Video style upgrade (v4 hero visuals)

| | |
|---|---|
| **Status** | 🧪 Testing (ready for the founder to watch the renders) |
| **Phase** | A4 · Generate and review video |
| **Depends on** | F22, F00 |
| **Design** | Approved sample `runs/local-dev/how-the-water-cycle-works-85b912/v1/water-cycle-v4-hero.mp4` (branch `exp/video-style-v2`) |
| **Data (MongoDB / storage)** | Plan contract: optional `hero` per narration block (no schema bump). Timeline/captions files: schema version 2 |
| **API endpoints** (docs/API.md) | — (plan types in §11.2: `NarrationBlock.hero`, `HeroName`) |

## Goal
Every video is made in the approved v4 style: one big, gently moving "hero" object per sentence, big
readable diagrams and captions, for any topic, without costing anything extra and without making
the creator wait much longer.

## Decisions
- **2026-11-15:** the founder and a colleague approved the v4 style sample (water cycle). It becomes the
  only style; the old light-theme composition is removed (nothing used it any more).
- The 6 points of the style: one hero object per sentence (not landscapes); never an empty screen and no
  ghost outlines; diagrams, numbers and labels about 1.5–2× bigger inside the Reels safe zone; 3–5 word
  phrase captions with the current word highlighted and key terms in amber; a hook with a picture plus the
  question from frame 1; no mascot, no scenery, and a soft code-generated music bed on by default behind
  one switch. Plus the dark amber theme, camera moves, self-drawing arrows with a travelling light, the
  progress bar, light-wipe transitions and an end card with **only the takeaway** (no "Follow for more").
- **Music bed (PRD decision #28):** replaces "no background music" (PRD #9). Generated in code, free, the
  same file every time. Switch: `BACKGROUND_MUSIC` in `packages/pipeline/src/pipeline/music.ts`. Silent
  fixture renders never get music.
- **Hero per narration block** (not per scene): narration blocks are one or two sentences, so this is
  "one hero per sentence". The planner picks it from the hero catalog; it is **optional and left out when
  absent** (like `icon`), so old plans parse and hash exactly as before: no schema version bump.
- **Fallback, free and deterministic:** the timeline compiler picks heroes from keywords (events on content
  objects first, then spoken words, with hold / look-ahead / no-flicker rules), else from an object label,
  else shows the scene icon large in a glowing medallion.
- **Process step strip:** kept as a **numbered rail** (big numbered circles, self-drawing arrows, travelling
  light) with no small labels or icons. Labels at rail size could not reach 40 px with 4–5 steps, and the
  big current-step card already names the step; a small icon next to the big hero showed it twice.
- **Never twice at once:** a card's icon tile is hidden when it shows the same object as the hero.
- **Render speed and size** (founder, 2026-11-15): at most 2× the old engine's time and under ~8 MB for a
  68 s video. Done by drawing glows as gradient shapes (no blur filters anywhere), a still background,
  JPEG frames and CRF 26. Measurements below.

## Steps
- [x] 1. Hero catalog (46 objects with titles, keywords, families) shared by planner, compiler, renderer and
  storyboard; optional `hero` per narration block in the plan contract; planner response schema, prompt
  (hero set + rule, F15 delimiting unchanged), assembly ("none" dropped), revision view, review page
- [x] 2. Timeline v2: hero track per scene (planner pick → keyword fallback → label → icon medallion);
  captions grouped into 3–5 word phrases with word timings and key-term flags
- [x] 3. Video engine v4 replaces the old composition: backdrop, camera, hero layer, 8 pattern layouts,
  phrase captions, light wipes, progress bar, end card without "Follow for more"; music bed in the render
  stage; review tools (`tools/video/`)
- [x] 4. Hero library: 12 nature objects from the sample (redrawn without filters) + 34 new ones
  (money, technology, science and health, time and places, generic)
- [x] 5. Render speed and file size: measured per change (below)
- [x] 6. Fixtures for every scene type (`sip-vs-fd`, `internet-journey`), renders and contact sheets
- [x] 7. Storyboard screen: the "Visual:" line names the heroes ("Hero: chai cup · Process: …")
- [x] 7b. Hook: the whole opening question (up to 3 words) is on screen within the first frames, and the
  hero sits below it (no overlap)
- [x] 8. Docs: PRD decision #28, ARCHITECTURE §15.6, BRAND §7.1, API §11.2, DATABASE planVersions, F23 note
- [ ] 9. Code review (code-reviewer agent)
- [ ] 10. Founder watches the renders and says OK

## Removed / not in this feature
- **Removed (unused):** the old light-theme composition: `packages/video/src/patterns/*`, `primitives/` (the icon
  artwork moved to `icons/Icon.tsx`, recoloured for the dark stage), `anim.ts`, and the Studio-only
  `PatternGallery` and `DevanagariCheck` compositions. No test or fixture used them.
- **Hindi/Hinglish (hidden for now):** captions keep the Noto Sans Devanagari font in the font stack. When the
  languages come back, render a Hindi fixture and check conjuncts and matras in the v4 captions and titles
  ("STEP 2 OF 4" becomes "चरण 2 / 4").
- **Not changed:** the database (plans are stored as before), the API, the approval rules.

## Layouts per scene type
| Pattern | v4 layout |
|---|---|
| Title / hook | The first words slam in big over the hero from frame 1; then the gold title with an underline and a subtitle pill |
| Labeled diagram | The thing's name as the title, the hero inside a glowing ring, its parts as big cards (2 columns) appearing in sync, the part being said glows. No pointer lines: the hero is a generic picture, so a line could point at the wrong spot |
| Process flow | The current step (node or arrow) in a big card at the top (icon hidden if it repeats the hero), the hero in the middle, a numbered rail with self-drawing arrows and a travelling light |
| Comparison | Two columns, each with its own hero (planner pick for that part of the narration → label keyword → medallion; never the same twice), a VS badge, points with ✓/✗ marks; the column being talked about glows |
| Timeline | Title, the hero for the event being told, a line that draws from milestone to milestone with a travelling light; the current milestone is named big under the line |
| Chart | Shares: a ring that grows around the hero + a big count-up card. Bars or line points: big bars / a self-drawing line with values, a smaller hero above, the current label under the chart. Counters: hero + count-up card |
| Step sequence | "STEP 2 OF 4" and a segmented progress bar, the hero, the current step in a big numbered card (a check when the narration says it is done) |
| Takeaway | Gold title, the hero inside an endless loop of light, checklist rows that tick as they are said. The end card shows only this (no "Follow for more") |

## Hero library (46)
- **Nature and water (from the sample):** chai cup, dinosaur, glacier, rain cloud, cloud, water vapour, sun, groundwater, river, ocean, water drop, globe
- **Money:** rupee coins, wallet, bank, piggy bank, growth chart, calculator, credit card, house
- **Technology:** smartphone, laptop, server, Wi-Fi signal, lock and shield, microchip
- **Science and health:** atom, DNA, heart, brain, plant, lab flask, virus, magnet, light bulb
- **Time and places:** clock, calendar, map pin, mountain, factory, delivery truck
- **Generic:** target, rocket, trophy, question mark, checklist

## How to try it (founder)
Nothing here costs money or calls Gemini/ElevenLabs.
1. Watch the approved water-cycle video re-made with the real engine (your recorded narration):
   `runs/local-dev/how-the-water-cycle-works-85b912/v1/water-cycle-final-v4.mp4`, and its contact sheet
   `runs/local-dev/how-the-water-cycle-works-85b912/v1/review-sheets/water-cycle-final-v4-sheet.png`.
   Compare with `water-cycle-v4-hero.mp4` (the sample you approved).
2. Watch the three fixture videos (silent, made-up timing, marked FIXTURE): every scene type appears once.
   Videos: `runs/fixture-owner/fixture-<name>/v1/output.mp4` for `water-cycle`, `sip-vs-fd`,
   `internet-journey`; contact sheets: `runs/f22b-work/sheets/<name>-sheet.png`.
3. See the whole hero library: `runs/f22b-work/gallery-all/page-1-f40.png` … `page-4-f40.png`.
4. To make them again yourself:
   - `npm run video:rerender -- --run runs/local-dev/how-the-water-cycle-works-85b912/v1 --out <file.mp4> --sheet <file.png>`
   - `npm run pipeline -- render-fixture --file fixtures/sip-vs-fd.plan.json --force`
   - `npm run video:heroes -- --out <folder>`
   - These npm scripts keep every temporary file inside the project (`runs/.tmp`), never in `/tmp`.

## How we test it (done when all are ticked)
- [x] Unit tests: hero contract and validation, fallback matching, backward compatibility (old plan renders), planner wiring, hero track, captions, storyboard line
- [x] `npm test`, typecheck, `next build`
- [x] Re-render of the approved run and fixture renders; every contact sheet checked (no empty frames, overlaps, cut-offs or duplicates; readable at phone size)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder watched the renders and said OK

## Render time and file size (measured 2026-11-15, this machine, 8 threads)
The water-cycle run (68.2 s, 2045 frames, recorded narration). This machine is shared: render times
change with other people's load, so the load average is noted. Remotion's default concurrency (4).

| Version | Render | MP4 size | Notes |
|---|---|---|---|
| Old engine (light theme) | 78 s | 2.9 MB | measured before this feature (same run) |
| v4 sample (`exp/video-style-v2`) | ~241 s | 17.9 MB | blur filters everywhere; music synthesis 11.8 s on top |
| v4 engine, first port | **104.4 s** | 9.83 MB | idle machine; no filters, music loop 1.5 s, CRF 23, moving background glow |
| v4 engine, final (still glow, CRF 26) | **139.4 s** (earlier runs: 127.9 s, 130.0 s) | **6.62 MB** | final code; busy machine (load average 7.3 before the render and up to 17 during it, from desktop browsers and other work; 3.8–7.9 for the earlier runs). The partial test below shows the same per-frame cost as the first port, so about 105 s when idle |

Per change, frames 600–1199 (20 s) of the same run:

| Change | Render | Size | Kept? |
|---|---|---|---|
| First port (CRF 23, moving glow) | 30.6 s | 2.98 MB | — |
| Still background glow | 28.9 s | 2.72 MB (−9%) | yes |
| No camera drift | 30.3 s | 2.51 MB (−8%) | no: the drift is part of the approved look |
| No slow push-in | 30.4 s | 2.81 MB | no: no gain |
| CRF 26 (with the still glow) | 30.3 s | 2.04 MB (−25%) | yes: same look as CRF 23 in full-size stills |
| Concurrency 6 / 8 | 27.4 s / 30.4 s | same | no: 6 is ~10% faster here, but the founder's dev server shares this machine; the Sandbox benchmark decides |
| x264 preset `faster` / `veryfast` (medium: 32.6 s, 2.04 MB) | 42.1 s / 38.7 s | 2.03 / 1.71 MB | no: inconclusive, other users' load rose from 4 to 16 between these runs; `medium` meets the target |

Fixture renders with the final code (silent, synthetic timing, same settings, `render-fixture`; all MP4 checks pass):

| Fixture | Length | Render | MP4 size | Load average before |
|---|---|---|---|---|
| `water-cycle` | 85.2 s (2555 frames) | 189.9 s | 6.75 MB | 16 |
| `sip-vs-fd` | 70.7 s (2122 frames) | 109.1 s | 5.31 MB | 2 |
| `internet-journey` | 73.1 s (2194 frames) | 133.9 s | 5.41 MB | 13 |

## Progress log
| Date | What happened |
|---|---|
| 2026-11-15 | Built: hero catalog + optional `hero` per narration block (planner, prompt, validation, revision, review page); timeline v2 with a hero track and 3–5 word captions with word timings; the v4 engine with 8 layouts replacing the old composition; the 46-object hero library (34 new objects drawn by three helper agents in parallel, reviewed in the hero gallery); the music bed; review tools; two new fixtures; the storyboard "Visual:" line names the heroes. Render speed and size tuned and measured (table above). Contact-sheet review rounds fixed: comparison and part-card text too small, a chart opening on an empty baseline, a labeled diagram whose hero wandered off the diagram's object, a hook whose question was not all visible in the first second and touched the hero, weak-cue flicker in the fallback. 776 tests pass; typecheck and `next build` pass. Ready for code review and the founder's check. |
