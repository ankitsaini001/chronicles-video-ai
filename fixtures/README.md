# Fixtures (test data, not live results)

Everything in this folder is **hand-written fixture data** for deterministic tests and plumbing.
Nothing here came from Gemini or ElevenLabs, and a fixture run must never be reported as a live result.
Fixture plans use `ownerId: "fixture-owner"` and project IDs starting with `fixture-`.

| File | Expected result |
|---|---|
| `water-cycle.plan.json` | Valid English plan, 6 scenes, about 82 s estimated |
| `invalid-unknown-pattern.plan.json` | Schema error: scene type `infographic` is not one of the 8 patterns |
| `invalid-missing-anchor.plan.json` | Anchor phrase `boils instantly` is not in its narration block |
| `invalid-bad-target.plan.json` | Event target `lightning` is not an object in the scene |
| `invalid-wrong-first-last.plan.json` | First scene is not `title-hook` and last scene is not `takeaway` |
| `invalid-hinglish-devanagari.plan.json` | Hinglish caption (`display`) is written in Devanagari instead of Roman script |

Each invalid fixture is a copy of the valid plan with exactly one defect.

**Synthetic timing (P1).** `npm run pipeline -- render-fixture` invents a deterministic, *silent* per-character
alignment for a fixture plan (2.8 words/s; `packages/pipeline/src/timing/synthetic-alignment.ts`) and stores it as
`alignment/<scene-id>.synthetic.json` in the run folder. It is never real speech and never a live result.
