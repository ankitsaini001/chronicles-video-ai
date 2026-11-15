# Fixtures (test data, not live results)

Everything in this folder is **hand-written fixture data** for deterministic tests and plumbing.
Nothing here came from Gemini or ElevenLabs, and a fixture run must never be reported as a live result.
Fixture plans use `ownerId: "fixture-owner"` and project IDs starting with `fixture-`.

| File | Expected result |
|---|---|
| `water-cycle.plan.json` | Valid English plan, 6 scenes, about 82 s estimated (hook, process flow, labeled diagram, pie chart, takeaway); no heroes picked: shows the keyword fallback |
| `sip-vs-fd.plan.json` | Valid English plan, 5 scenes, about 68 s (hook, comparison with ✓/✗ points, bar chart, step sequence, takeaway); some narration blocks have a planner-picked `hero`, others use the fallback (F22b) |
| `internet-journey.plan.json` | Valid English plan, 7 scenes, about 70 s (hook, timeline, labeled diagram, process flow, line chart, counter, takeaway); the counter scene names no hero, so it shows the scene icon in a medallion (F22b) |
| `invalid-unknown-pattern.plan.json` | Schema error: scene type `infographic` is not one of the 8 patterns |
| `invalid-missing-anchor.plan.json` | Anchor phrase `boils instantly` is not in its narration block |
| `invalid-bad-target.plan.json` | Event target `lightning` is not an object in the scene |
| `invalid-wrong-first-last.plan.json` | First scene is not `title-hook` and last scene is not `takeaway` |
| `invalid-hinglish-devanagari.plan.json` | Hinglish caption (`display`) is written in Devanagari instead of Roman script |

Each invalid fixture is a copy of the water-cycle plan with exactly one defect. Together the three valid plans use all 8 scene types, so rendering them (`npm run pipeline -- render-fixture --file fixtures/<name>.plan.json`) shows every v4 layout (F22b).

**Synthetic timing (P1).** `npm run pipeline -- render-fixture` invents a deterministic, *silent* per-character
alignment for a fixture plan (2.8 words/s; `packages/pipeline/src/timing/synthetic-alignment.ts`) and stores it as
`alignment/<scene-id>.synthetic.json` in the run folder. It is never real speech and never a live result.
