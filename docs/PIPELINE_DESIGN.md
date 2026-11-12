# ByteReel — Pipeline Technical Design & Prototype Plan

| | |
|---|---|
| **Version** | 1.0 · 2026-11-12 |
| **Status** | Ready to guide prototype implementation. No pipeline code or live generation has been run yet. |
| **Product baseline** | [`PRD.md`](../PRD.md) (v1.0 FINAL) |
| **Alignment** | Mirrors the Namaste AI S2 pipeline design. ByteReel additions are marked **[ByteReel]**. |

---

## 1. Purpose and Decision

Prove that the product can generate a **useful 60–90-second educational explainer** with minimal motion graphics, Indian-accent narration, readable captions and precise synchronization **before** building the full application.

Build a **local TypeScript pipeline** with **real Gemini and ElevenLabs adapters** and a **Remotion renderer**. Use a command-line runner and **static storyboard review artifacts** (HTML + JSON) at first. The prototype is a developer-operated proof of the production pipeline. It is **not** the final four-step dashboard.

Keep contracts and rendering components **reusable in the Next.js application**. Defer account UI, MongoDB persistence, hosted orchestration, R2 integration and Instagram publishing until the core output has passed review. Their required boundaries are specified below, so the local implementation does not assume global shared data.

- **First milestone:** one complete, reviewable video (English).
- **Prototype exit gate:** three topics, both narrator presets evaluated, a local scene revision, a narrator switch, and failure recovery, plus **[ByteReel]** one Hindi and one Hinglish video.
- **Neither a mocked provider response nor a silent animation demo counts as proof of live generation quality.**

---

## 2. Prototype Scope

### Included
- Topic and optional reference notes.
- **Languages:** English first; **[ByteReel]** Hindi and Hinglish after the English vertical slice passes.
- Gemini-generated structured storyboard and narration.
- Reviewable storyboard **HTML + JSON**, with **explicit approval of its hash**.
- Configurable narrator presets: **male and female** per language (Indian English in the first slice).
- ElevenLabs narration and returned alignment.
- Deterministic timeline compilation and caption grouping.
- Reusable explanatory animation components (the PRD's 8 motion patterns) and a minimal fixed visual style.
- Vertical **1080 × 1920 MP4 at 30 fps, 60–90 seconds inclusive**.
- Local artifacts, stage checkpoints, resume after failure.
- One conversational revision interface (CLI instruction file).

### Deferred to the application phase
- Account UI and Better Auth, MongoDB persistence, Inngest orchestration, R2 storage, hosted rendering (Vercel Sandbox), Instagram connection and publishing.
- Billing, backups, shared workspaces, public signup and brand controls remain **outside V1 entirely**.

**Not needed for this prototype:** arbitrary generated React/JavaScript execution, a photorealistic video API, voice cloning, background music, or an extra AI image provider.

---

## 3. Architecture

```
            Topic and reference notes
                       │
                       ▼
                 Gemini planner
                       │
                       ▼
         Schema and semantic validation
                       │
                       ▼
               Storyboard review  (plan-review.html)
                       │
                       ▼
             Approved immutable plan ───────────────┐
                       │                            │
                       ▼                            │
       ElevenLabs narration and alignment           │
                       │                            │
                       ▼                            │
        Audio and alignment validation              │
                       │                            │
                       ▼                            ▼
              Timeline and caption compiler ◄───────┘
                       │
                       ▼
               Remotion composition
                       │
                       ▼
                 MP4 validation
                       │
                       ▼
        Human video review and evaluation
                       │
                       ▼
   Approved output for later export or publishing
```

**Division of responsibility:**
- The **planner** decides *what* to explain and *which supported visual elements* communicate it.
- The **compiler** determines *exact times* from real audio.
- **Remotion** draws approved components at those times.
- **Rendering must not call AI providers or introduce randomness.** The same inputs always produce the same video.

### Initial implementation choices

| Concern | Initial choice | Boundary |
|---|---|---|
| Language | TypeScript on a supported Node.js LTS runtime | Pin actual runtime/package versions during setup |
| Planner | Gemini, configured initially as `gemini-3.8-flash` (`GEMINI_MODEL`) | Server-side provider adapter; validate every response |
| Narrator | ElevenLabs, initially `eleven_multilingual_v2` (`ELEVENLABS_MODEL`) | Separate configured voice ID for each preset |
| Validation | Runtime schemas, with **Zod** as the proposed implementation | Provider JSON success is **not** application validity |
| Rendering | React components + Remotion renderer | Local Chromium/runtime first; hosted rendering benchmarked later |
| Artifact persistence | Filesystem artifact store | Replace with R2 (private, owner-scoped) |
| Run state | Local manifest with atomic writes | Replace with MongoDB (owner-scoped records) |
| Scheduling | Sequential local orchestrator | Replace orchestration with Inngest |
| Media inspection | Probe decoded media using available renderer/media tooling | Verify actual output, not assumptions |

These model IDs are the current baseline, not a promise of account availability. **Preflight fails clearly if a model is unavailable**; any model substitution is recorded with its checks.

---

## 4. Repository Organization

Proposed layout (not yet implemented):

```
src/
  contracts/     # Plan, approval, audio, alignment, timeline, manifest (Zod + types)
  providers/     # Planner (Gemini) and speech (ElevenLabs) adapters
  planning/      # Prompts, component catalog, plan/revision validation
  timing/        # Text normalization, alignment mapping, caption grouping
  video/         # Remotion composition, scenes, primitives, typography
  pipeline/      # Stage orchestration, checkpoints, invalidation
  storage/       # ArtifactStore interface and local implementation
  validation/    # Media and layout checks
  cli/           # Development commands
fixtures/        # Non-sensitive plans/alignment for deterministic tests
examples/        # Three evaluation topics and source notes (+ Hindi/Hinglish)
tests/           # Contract, compiler, dependency, integration checks
runs/            # Ignored generated artifacts; never contains API keys
```

Keep the pipeline **independent of Next.js request objects**. Later, an authenticated endpoint passes an **owner-scoped job reference** into the same stage functions.

---

## 5. Contracts and Versioning

### Plan contract

| Field | Meaning |
|---|---|
| `schemaVersion` | Contract version |
| `projectId`, `ownerId`, `versionId`, `parentVersionId` | Ownership and immutable lineage, **assigned by application code** |
| `topic`, `audience`, `learningObjective` | Content intent |
| `language` | `en` in the first slice; **[ByteReel]** also `hi`, `hinglish` |
| `voicePreset` | `indian-english-male` / `indian-english-female`; **[ByteReel]** `hindi-male` / `hindi-female`, `hinglish-male` / `hinglish-female` |
| `sources` | User-provided notes with stable references; **no invented citations** |
| `scenes` | Ordered scenes with stable IDs, narration, visual objects and semantic cues |
| `warnings` | Unsupported or uncertain content requiring review |

**Approval:** application code computes the **canonical plan hash** (stable key order, normalized whitespace). Approval stores that hash, the approving actor and the timestamp **separately** from the plan. Any meaningful plan mutation invalidates approval.

**The model cannot** assign ownership, approve its own plan, choose arbitrary filesystem paths, or configure provider credentials.

### Scene contract

Each scene specifies a **supported component type** (one of the 8 PRD motion patterns) and **typed parameters**. A scene contains **narration blocks**, **visual objects** and **events**.

- Narration blocks have **stable IDs** and approved text.
- Pronunciation/display forms may differ from the approved text, but must keep an **explicit mapping** (used for numbers, acronyms and **[ByteReel]** Hinglish: Devanagari for speech, Roman script for captions).
- Events anchor to a **phrase inside a narration block**. They never use a raw timestamp.

Example fragment (illustrative, not a full plan):

```json
{
  "id": "scene-water-heating",
  "type": "process-flow",
  "narration": [
    {
      "id": "line-heat",
      "text": "When water absorbs heat, its particles move faster.",
      "speech": null,
      "display": null
    }
  ],
  "objects": [
    { "id": "water", "kind": "water-particles", "label": "Water" },
    { "id": "heat",  "kind": "heat-source",     "label": "Heat" }
  ],
  "events": [
    { "id": "ev-heat-on",    "anchor": { "narrationId": "line-heat", "phrase": "absorbs heat" }, "action": "highlight", "target": "heat" },
    { "id": "ev-speed-up",   "anchor": { "narrationId": "line-heat", "phrase": "move faster" },  "action": "speed-up",  "target": "water" }
  ]
}
```

- `type` ∈ `title-hook`, `labeled-diagram`, `process-flow`, `comparison`, `timeline`, `chart`, `step-sequence`, `takeaway`.
- `kind` and `action` come from a **fixed component catalog**. Unknown values fail validation.
- **Timing is derived data. The AI never invents final speech timestamps.**
- Caption display corrections are stored **independently of alignment**, so visual-only revisions don't erase them.

### Semantic validation (beyond the schema)
- First scene `title-hook`, last scene `takeaway`.
- Every event anchor phrase exists in its narration block; every target references an object in the same scene.
- Text lengths fit layout limits; object counts are within pattern limits.
- Estimated speech duration is plausible for 60–90 s.
- **[ByteReel]** Hindi display text is in Devanagari; Hinglish display text is in Roman script, with a speech mapping where needed.

---

## 6. Speech Strategy and Synchronization

### Start with scene-level speech synthesis
Generate **each scene as one speech request** containing its narration blocks in a known order. This bounds alignment work and enables scene-level reuse. Keep the same voice, model, settings and pronunciation conventions throughout the video.

**Tradeoff:** separate requests may sound discontinuous at scene boundaries. Listen specifically for changes in pace, energy and intonation. If the joins are consistently distracting, test **whole-script synthesis as an explicit architecture experiment**. Do not change strategies silently. Whole-script synthesis improves continuity but means more regeneration after edits.

### Alignment algorithm
1. Build the exact speech input and a mapping from approved narration blocks to input character spans.
2. Save the provider's audio and both the original and normalized alignment, where returned.
3. Validate: equal array lengths, finite non-negative times, ordered starts, end ≥ start, bounds against the decoded audio duration.
4. Map the provider's text normalization back to the approved text. For number/acronym expansions, keep **many-to-many token mappings** instead of assuming identical character offsets.
5. Resolve narration cues into timed word/phrase intervals.
6. Derive caption phrases and scene events from those intervals.
7. **Stop with a recoverable alignment error if the mapping is uncertain.** In this prototype, retry is the initial recovery. An untested forced-alignment fallback is not required.

**Mandatory test cases:** repeated words, punctuation, Unicode apostrophes, acronyms, rupee amounts (₹), decimals, expanded numbers. **[ByteReel]** Also Devanagari text, mixed Devanagari/Roman (Hinglish), and Hindi numbers. If normalization cannot be reconciled, **do not stretch guessed timings across the scene.**

### Scene and frame accounting
- Use the **actual audio duration**, not the timestamp of the final visible caption character, as the basis for scene length.
- At 30 fps, convert event starts using `floor` and ends using `ceil`, then validate each interval.
- Allocate each scene `ceil((audioDuration + approvedTrailingHold) × fps)` frames. Place each later scene at the previous scene's exact end, so rounding errors don't add up.
- Play each scene's audio from its compiled scene start. Preserve audio samples; don't repeatedly decode or re-encode intermediate speech unless necessary.
- Use **simple cuts** initially. Reveals within a scene provide motion without complicated overlapping audio or transitions.
- Permit only small designed holds: **0–500 ms per scene**, plus up to **1 s for the final takeaway**.
- The final total must be **1,800–2,700 frames inclusive** (60–90 s). If substantive wording needs to change to meet the range, **return a revised plan for approval**. Never add filler.

Human evaluation checks whether cues **feel** right, not only whether the arithmetic is correct. Target tolerance: about **200 ms** for sampled phrase starts and intended visual events.

---

## 7. Captions and Minimal Visual System

- High-contrast captions, **maximum two lines**. Break on natural phrase boundaries using **measured text width** and the actual audio timing. Avoid separating a number from its unit, and avoid leaving a lone word on the next line when another grouping fits.
- Start with captions rendered as **phrases** (no word-by-word effects, no caption-style selector).
- A light background, dark text and **two restrained accent colors**. **Package fonts locally** for a deterministic layout. **[ByteReel]** Include a Devanagari-capable font (e.g. Noto Sans Devanagari) and verify Hindi conjuncts and matras render correctly.
- Define reusable primitives (text, label, arrow, icon, shape, counter, particles) and the 8 pattern components on top of them.
- Keep text and key visuals inside Instagram Reels **safe zones**.

---

## 8. Stage Sequence, Run State and Artifacts

### Stage sequence

| Stage | Input | Output | Approval / retry rule |
|---|---|---|---|
| Preflight | Config and runtime | Capability report | No live generation with missing credentials/voices |
| Plan | Topic, notes, component catalog | Validated draft + review HTML | One bounded schema-repair attempt |
| Approve | Reviewed plan hash | Approval record | Explicit creator/developer review |
| Speech | Approved scenes + voice configuration | Audio + alignment per scene | Retry transient failures only |
| Compile | Audio, alignment, approved plan | Timeline + captions | Deterministic; fail on invalid mapping |
| Render | Compiled timeline + assets | MP4 + sample frames | Retry runtime failure **without repeating speech calls** |
| Validate | Encoded media + render report | Machine QA report | Invalid output cannot be marked ready |
| Review | Video + QA report | Human scorecard | Final readiness requires human review |

**Local manifest states:** `draft`, `awaiting-approval`, `running`, `needs-input`, `failed`, `cancelled`, `ready-for-review`, `approved`. Record the state of each stage and each scene. **Never treat "file exists" as "stage succeeded".**

### Artifact layout

```
runs/<owner>/<project>/<version>/
  manifest.json
  plan.json
  plan-review.html
  approval.json
  audio/<scene-id>.mp3
  alignment/<scene-id>.json
  timeline.json
  captions.json
  preview-frames/
  output.mp4
  qa.json
  evaluation.md
```

- Write to temporary paths and **atomically rename** completed artifacts. Hash completed artifacts and validate them on resume. Use **one local writer per run**. Record stage diagnostics and timing, **never secrets or authorization headers**.
- **Reuse a speech artifact only if** the narration input, pronunciation mapping, voice ID, model and relevant settings all match. Reuse renders only if the assets/composition dependencies match. **Never reuse across owners** in the application phase.
- **Transient provider failures** get a bounded backoff policy: initially **two retries**, honoring `Retry-After` when supplied. Invalid credentials, unsupported models and content rejections **stop immediately**. A timed-out speech request may still have been charged; retry limits reduce duplication but can't guarantee none.
- **Cancellation** stops future stages. If a provider request already in progress completes, it's recorded as an artifact of the cancelled job without advancing the run. Work can be regenerated from the saved plan, creating a new version if the output changes. No backup system is introduced.

---

## 9. Revision Behavior

| Requested change | Effect | Re-run |
|---|---|---|
| Larger labels in one scene (visual-only) | New plan version; all audio reused | Compile + render |
| Change narration wording in one scene | New plan version; re-approval | Speech for **that scene only** + compile + render |
| Caption display correction | Caption override saved separately | Compile captions + render (no speech) |
| Switch narrator (male ↔ female) | New version | Speech for **all scenes** + compile + render |
| Add / remove / reorder scenes | New plan version; re-approval | Speech for new/changed scenes only + compile + render |
| Whole-video change ("make it shorter") | New plan version; re-approval | Speech for changed scenes + compile + render |
| Change topic | Treated as a new project/plan | Everything |

Revisions are submitted as **instruction files** in the prototype. Gemini returns a full revised plan, and code diffs it by scene and narration IDs to decide what to reuse.

---

## 10. Developer Workflow and Configuration

Proposed commands (not yet executable):

```
npm run pipeline -- preflight
npm run pipeline -- plan --topic-file examples/water-cycle.md --voice indian-english-female
npm run pipeline -- approve --run <run-id> --plan-hash <reviewed-hash>
npm run pipeline -- generate --run <run-id>
npm run pipeline -- resume --run <run-id>
npm run pipeline -- revise --run <run-id> --instruction-file <file>
npm run pipeline -- evaluate --run <run-id>
```

**Preflight** checks the Node/render tooling, configured model/voice identifiers, available disk space and local output access. Network authorization checks must be **explicit** (a separate flag), so preflight never accidentally triggers paid generation.

**Required for live AI tests:**

```
GEMINI_API_KEY
GEMINI_MODEL
ELEVENLABS_API_KEY
ELEVENLABS_MODEL
ELEVENLABS_VOICE_ID_INDIAN_MALE
ELEVENLABS_VOICE_ID_INDIAN_FEMALE
# [ByteReel] needed from the Hindi/Hinglish stage onward:
ELEVENLABS_VOICE_ID_HINDI_MALE
ELEVENLABS_VOICE_ID_HINDI_FEMALE
# Hinglish presets (hinglish-male / hinglish-female) use the Hindi voice IDs; there are no separate Hinglish voices.
```

Store values in an **ignored local environment file** (later, server environment settings). A committed `.env.example` contains placeholders only. MongoDB, R2 and Inngest credentials are **not** prerequisites for the first local MP4.

**Fixture mode** permits schema, layout, caption and renderer work **without credentials**. Fixtures are clearly labeled and never reported as live results: either a recorded alignment/audio fixture, or a clearly marked silent timing fixture for plumbing tests.

---

## 11. Evaluation Plan

### Evaluation topics

| # | Type | Topic | Language | Narrator |
|---|---|---|---|---|
| 1 | Process | How the water cycle works | Indian English | Female, then switch to Male |
| 2 | Comparison | Savings account vs fixed deposit | Indian English | Male |
| 3 | Abstract concept | What is opportunity cost? | Indian English | Female |
| 4 | **[ByteReel]** Language check | Topic 2 or 3 re-planned | Hindi | Male or Female |
| 5 | **[ByteReel]** Language check | Topic 3 re-planned | Hinglish | Female |

### Human review
Score each criterion **1–5**: explanation accuracy, visual relevance, motion timing, pronunciation (Indian English / **[ByteReel]** Hindi / Hinglish), voice continuity, caption readability, and overall willingness to publish.

**Pass** when each critical criterion is **at least 4**, with **no** factual error, omitted speech, unreadable label or misleading diagram. These are prototype gates, not a claim that quality has already been reached.

Listen on headphones **and** a phone speaker; view at phone size. Check names, acronyms, units and pauses. Measure total elapsed time, stage durations, retry counts and available provider usage. **Check costs in the provider dashboards instead of building metering.**

### Failure tests
- Invalid planner JSON, unsupported visual type, missing phrase anchor.
- Number normalization, repeated phrase, punctuation-only interval.
- Missing alignment, corrupt audio, truncated narration.
- Provider timeout/rate limit and invalid credentials.
- Render failure after speech completion; resume from saved artifacts.
- Narrator unavailable; **no silent replacement**.
- Plan edited after approval; **reject the stale approval**.
- Concurrent local run attempt; **refuse a duplicate writer**.
- Output outside the duration range; **return for plan adjustment instead of adding filler**.
- **[ByteReel]** Devanagari caption overflow / broken conjuncts; Hinglish speech↔display mapping mismatch.

---

## 12. Implementation Sequence

| Milestone | Work | Deliverable |
|---|---|---|
| **P0 — Foundation** | Runtime setup, schemas, config validation, manifests, artifact adapter | A deterministic fixture run with clear validation errors |
| **P1 — Visual skeleton** | Core components (8 patterns), captions, timeline compiler, local render | A clearly labeled fixture video |
| **P2 — Live vertical slice** | Gemini planner, review HTML, approval, ElevenLabs speech + alignment, end-to-end generate (English) | First real reviewable video |
| **P3 — Quality and revision** | Three English topics, both narrators, scene revision, narrator switch, caption corrections; **[ByteReel]** Hindi + Hinglish runs | Scored videos + revision evidence |
| **P4 — Recovery and report** | Resume/failure tests, stage timing, quality review | Prototype findings and architecture decisions |

**P0/P1 can proceed without provider credentials.** P2 requires configured API access and voice IDs. There's no reason to request every future production credential before the local pipeline exists.

**Do not start building the full dashboard just because P1 renders successfully.** Move to application implementation after reviewing the real P2/P3 outputs and fixing critical failures.

---

## 13. Transition to the Full Application

After the prototype gate:
1. Keep the plan/timeline contracts, provider adapters, validation and visual components.
2. Replace local manifest storage with **owner-scoped MongoDB records**, and filesystem assets with **private R2 storage**.
3. Wrap pipeline stages in **Inngest**, with durable job identities and retry policies.
4. Benchmark Remotion on **Vercel Sandbox**, saving final outputs to R2 before the sandbox shuts down.
5. Build the four-step **Next.js UI** and individual **Better Auth** accounts around the established contracts.
6. Add per-user **Meta authorization and publishing**, with immutable approvals and reconciliation when a publish outcome is unknown.

Keep a parallel setup checklist for the **Meta developer app**: callback URLs, eligible test accounts and permissions. It must not block local video work or be presented as an implemented integration.

The next **system architecture document** (`docs/ARCHITECTURE.md`) should specify database indexes, ownership enforcement, authenticated routes, job dispatch and idempotency, credential storage, private asset access URLs, the hosted render lifecycle, and Instagram scheduling races, using **measured prototype findings** instead of invented throughput numbers.

---

## 14. Prototype Completion Criteria

- Three real 60–90-second explainers produced and reviewed (English).
- Both Indian English voices evaluated; one full narrator-switch regeneration completed.
- At least one targeted scene revision completed with correct artifact reuse.
- Caption and animation synchronization validated against actual narration.
- A render failure recovered **without repeating speech calls**.
- Machine checks and human scorecards recorded.
- Model/voice IDs, latency, limits and observed provider usage recorded.
- **[ByteReel]** One Hindi and one Hinglish video pass the human review gate; decision recorded on whether Hinglish needs the speech↔display mapping.
- A clear recommendation: proceed, improve the component library, or change a pipeline choice.
