# ByteReel pipeline prototype

ByteReel turns a topic into a 60–90 second educational explainer reel (see [`PRD.md`](PRD.md)).
This repo currently holds the **local TypeScript pipeline** described in
[`docs/PIPELINE_DESIGN.md`](docs/PIPELINE_DESIGN.md). It is plain TypeScript, independent of Next.js.

**Current milestone: P2b — live speech + generate (code done; first live video blocked by the voice plan).**
P0 (foundation), P1 (visual skeleton, fixture video) and P2a (Gemini planning + approval) are done.
P2b adds ElevenLabs speech per scene, alignment validation/mapping, a speech cache, `generate`/`resume` and rendering
with narration. The first live speech request was refused: the four configured voices are ElevenLabs Voice Library
("professional") voices, which the free plan cannot use through the API (see "P2b status" below).

## Setup

Requires Node.js 24+.

```bash
npm install
npx remotion browser ensure   # one-time: Remotion's own headless Chromium (~100 MB in node_modules/.remotion)
cp .env.example .env          # optional for P0/P1; fill in real values for live runs (P2)
```

## Commands

```bash
npm run pipeline -- preflight                                    # runtime, disk, output folder, config presence (no network)
npm run pipeline -- preflight --network                          # + read-only provider checks: Gemini model get/list, ElevenLabs models + voices
npm run pipeline -- plan --topic-file examples/water-cycle.md --voice indian-english-female   # LIVE Gemini planner -> plan.json + plan-review.html
npm run pipeline -- approve --run <owner/project/version> --plan-hash <sha256:...>           # approve exactly the reviewed plan
npm run pipeline -- generate --run <owner/project/version> --scene <scene-id> --max-characters 1500  # LIVE probe: speech for one scene only
npm run pipeline -- generate --run <owner/project/version> --max-characters 1500   # LIVE: speech -> compile -> render with narration -> validate
npm run pipeline -- resume --run <owner/project/version>         # continue after a failure from saved artifacts (no repeated speech calls)
npm run pipeline -- fixture --file fixtures/water-cycle.plan.json # validate a fixture plan and create its run folder
npm run pipeline -- render-fixture --file fixtures/water-cycle.plan.json  # P1: compile -> render -> validate (about 5 min)
npm run pipeline -- render-fixture --file fixtures/water-cycle.plan.json --force  # render again
npm run studio                                                    # Remotion Studio preview in the browser
npm test                                                          # all tests
npm run typecheck                                                 # strict TypeScript check
```

**Studio:** `npm run studio` opens Remotion Studio (it prints a local URL, usually http://localhost:3000).
Compositions: `Explainer` (the water-cycle fixture, compiled in the browser with the same synthetic timing),
`PatternGallery` (all 8 patterns with sample data, 5 s each) and `DevanagariCheck` (Hindi conjuncts and matras).
Set `showSafeZones` to `true` in the props panel to see the Reels safe zones.

Try an invalid fixture to see the error messages, e.g.
`npm run pipeline -- fixture --file fixtures/invalid-missing-anchor.plan.json`.

Exit codes: `0` success, `1` validation/check failure, `2` usage error.

## What P0 includes

| Folder | What it does |
|---|---|
| `src/contracts/` | Zod schemas + types: plan, scene, approval, manifest, scene alignment (ElevenLabs-compatible), timeline, captions. |
| `src/planning/` | Component catalog (allowed kinds/actions/limits per motion pattern), semantic validation, canonical plan hash, approval check. |
| `src/storage/` | `ArtifactStore` interface + local filesystem store: atomic writes, content hashes, one writer per run. |
| `src/pipeline/` | Manifest create/load/save with allowed state transitions only; the fixture run. |
| `src/config/` | Reads env vars (optionally from `.env`), reports what is missing, never prints secrets. Four voice IDs: Hinglish presets use the Hindi voices. |
| `src/cli/` | `preflight` and `fixture` commands. |
| `fixtures/` | Hand-written test plans (one valid, five invalid). Not live results. |
| `examples/` | Topic files for evaluation runs. |
| `tests/` | Vitest tests for all of the above. |

Run artifacts go to `runs/<owner>/<project>/<version>/` (ignored by git):
`manifest.json` (run state, stages, scenes, artifact hashes) and `plan.json`.

### Key rules enforced

- A plan must pass the schema **and** semantic checks: first scene `title-hook`, last scene `takeaway`,
  every event anchor phrase exists (once) in its narration block, every target is an object in the same scene,
  kinds/actions come from the catalog, text and object counts fit the limits, the word count suggests 60–90 s,
  Hindi on-screen text is Devanagari and Hinglish on-screen text is Roman script.
- The plan hash ignores key order and whitespace but changes on any real edit. An approval is valid only
  if its hash matches the current plan.
- Artifacts are written to a temp file and renamed; only one process may write to a run at a time.
- A run version is immutable: re-running the same fixture is a no-op, a changed plan needs a new `versionId`.

## What P1 adds

| Folder | What it does |
|---|---|
| `src/timing/` | Deterministic compiler: alignment validation, alignment → word mapping (Intl.Segmenter, many-to-many atoms for `97%` ↔ "ninety-seven percent"), event resolution, frame accounting, caption phrases (max 2 lines, number + unit kept together, no lone last word), the synthetic timing fixture. |
| `src/video/` | Remotion composition `Explainer` (1080×1920, 30 fps, duration from the timeline), style tokens and safe zones (`theme.ts`), primitives, local icon set, packaged fonts (Inter + Noto Sans Devanagari), the 8 pattern components, captions, fixture badge. |
| `src/pipeline/render*.ts` | Render stage (bundle, render H.264, preview PNGs) and the fixture run: compile → render → validate with manifest stages. |
| `src/validation/` | MP4 probe with Remotion's bundled ffprobe: codec, resolution, fps, decoded frame count, duration vs timeline. Writes `qa.json`. |

A `render-fixture` run adds to the run folder: `alignment/<scene>.synthetic.json`, `timeline.json`, `captions.json`,
`output.mp4`, `preview-frames/*.png` and `qa.json`; `manifest.json` records `timingSource: "synthetic-silent-fixture"`.

**The fixture video is not a live result.** It has no audio and invented timing (2.8 words/s), and every frame
carries a `FIXTURE · SILENT · SYNTHETIC TIMING` badge. Real narration timing arrives with ElevenLabs in P2.

Timing rules (from `docs/PIPELINE_DESIGN.md` §6): scene frames = `ceil((audio + hold) × 30)`, scenes placed end to end,
event start = `floor`, end = `ceil`, holds 0–500 ms per scene (default 400) and up to 1,500 ms for the takeaway
(default 1,200), total 1,800–2,700 frames or the run goes to `needs-input` ("return for plan adjustment"; no filler).
Caption line widths use a deterministic character-class **estimate** (`estimate:char-class-v1`, measured ~3% wider than
the real font); the caption component re-measures in the browser and fails the render if a line would overflow.

## What P2a adds (live planning)

| Where | What it does |
|---|---|
| `src/providers/` | Gemini planner adapter (official `@google/genai`, pinned), provider error policy (≤2 retries for transient errors honoring Retry-After; invalid key, unknown model and safety blocks stop at once), ElevenLabs **read-only** checks (models, voice lookup). |
| `src/planning/planner-output.ts` | The planner-output contract: the plan minus everything code owns (ownership/lineage, schemaVersion, language, voice, sources; no approval or paths). Converted to a JSON schema for structured output. `assemblePlan` drops reserved fields the model returns anyway. |
| `src/planning/prompts.ts`, `planner.ts` | Prompts with the component catalog, icon set, explanation rules and the 60–90 s length rule (~150 wpm). One bounded repair attempt that sends the validation errors back; still invalid → `needs-input`. |
| `src/planning/review-html.ts` | `plan-review.html`: self-contained storyboard page (title, objective, language/voice, estimated duration, scene cards with narration, highlighted + numbered event anchors, objects, events, warnings, approve command). |
| `src/pipeline/plan-run.ts` | `plan`: new run `runs/local-dev/<project>/v1/`, IDs from code, writes `plan.json` + `plan-review.html`, records the plan hash, state `awaiting-approval`. |
| `src/pipeline/approval-gate.ts` | `approve` (rejects a stale hash; writes `approval.json` with actor `local-developer`; state `plan-approved`) and the generation gate (plan.json and approval.json unchanged on disk, approval hash = current plan hash). |

**Run ID** = `<owner>/<project>/<version>`, e.g. `local-dev/how-the-water-cycle-works-3fa9c1/v1` (its folder below `runs/`).

**Gating:** live (non-fixture) runs never generate or render without a valid approval. `render-fixture` refuses live
runs outright (they will use `generate`); fixture runs behave as in P1. New run state `plan-approved` sits between
`awaiting-approval` and `running`.

**Icons:** the keyword table that picks an icon from a label moved to `src/planning/icon-catalog.ts` so the planner
prompt and the renderer share one list (the plan contract is unchanged).

**Live calls:** `preflight --network` never generates anything and never calls text-to-speech. `plan` makes one
Gemini call (plus at most one repair call; each with ≤2 transient retries). Tests use a mock planner and mocked
fetch only. Keys are read from `.env`, sent only to the provider SDK/header, and never printed or stored.

## What P2b adds (live speech + generate)

| Where | What it does |
|---|---|
| `src/providers/speech.ts` | ElevenLabs text-to-speech **with timestamps** (documented REST endpoint `POST /v1/text-to-speech/{voice_id}/with-timestamps`, no SDK dependency). One request per scene, `previous_text`/`next_text` from the neighbouring scenes, explicit voice settings, `mp3_44100_128`, fixed seed. ≤2 retries for transient errors (honoring Retry-After); invalid key, voice not found, quota, unusual activity and library-voice/paid-plan refusals stop at once. **No fallback voice.** |
| `src/timing/provider-alignment.ts` | Validates the original and the normalized alignment (lengths, finite ordered times, end ≥ start, within the decoded MP3 duration). Uses the original if it spells the sent text; otherwise maps the normalized alignment back word by word (many-to-many: `97%` ↔ "ninety-seven percent", repeated words, punctuation, apostrophes). Uncertain → recoverable alignment error (`needs-input`), never stretched timings. |
| `src/validation/audio.ts` | Probes the real MP3 (decoded frames × 1152 / sample rate). Scene length = decoded audio + hold. |
| `src/storage/speech-cache.ts` | Owner-scoped, content-addressed speech cache `runs/<owner>/.speech-cache/<key>.mp3/.json`. Key = speech text + pronunciation mapping + voice ID + model + settings + format + seed + normalization mode (continuity context excluded, so editing one scene re-synthesizes only that scene). Every response is cached the moment it arrives. |
| `src/pipeline/generate-run.ts`, `speech.ts` | `generate`/`resume`: approval gate → speech per scene (reuse run copy → cache → provider) → compile with real durations → Remotion render with one `<Audio>` per scene at its compiled start (decoded once, encoded once to AAC) → MP4 validation (now also: one AAC track, audio length ≈ video length ±0.1 s) → preview frames → `ready-for-review`. Render/validate failures resume without speech calls. |
| object `icon` field | Optional `icon` (from `src/planning/icon-catalog.ts`) on plan objects; the planner must fill it (or `"none"`) and keep labels as readable on-screen text. The renderer prefers `icon`, falling back to label keywords. Labels that look like keyword lists ("sun heat solar") get a non-blocking review warning (CLI + `plan-review.html`). Plans without `icon` keep their exact hash. |

**Character budget.** Every request (retries included) is counted in `manifest.json` → `speechUsage` *before* it is
sent. A request that would take the run past `--max-characters` (default 1.5 × the plan's narration) is never sent.
`generate --scene <id>` synthesizes just that scene as a cheap probe and leaves the run `plan-approved`.
`generate`/`resume` print the account's character usage before and after (`GET /v1/user/subscription`, read-only).
Live runs have no fixture badge; fixture runs keep it. Tests use a mock speech provider and synthetic alignments only.

### P2b status (2026-11-12)

The probe `generate --scene scene-title-hook` on `local-dev/how-the-water-cycle-works-5fb0da/v1` was refused by
ElevenLabs with `402 payment_required: Free users cannot use library voices via the API`. Account usage stayed at
0 / 10,000 characters (nothing billed; the run's own conservative count records 160 characters sent). All four
configured voices are Voice Library voices (category `professional`), so every preset would be refused the same way.
`preflight --network` now fails such voices on a free-plan key. No voice was switched automatically. To continue,
the founder chooses either a paid ElevenLabs plan (costs money) or premade/own voices for the four presets; then run
`generate` again on the same approved run (the plan and its approval are unchanged).
