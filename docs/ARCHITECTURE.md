# ByteReel — System Design Document (V1 Application)

| | |
|---|---|
| **Version** | 1.1 · 2026-11-12 |
| **Scope** | The full V1 web application (dashboard + backend) around the proven pipeline |
| **Inputs** | [`PRD.md`](../PRD.md) v1.0 FINAL · [`PIPELINE_DESIGN.md`](PIPELINE_DESIGN.md) v1.0 · prototype code in `src/` (P0–P2b) |
| **Status** | ✅ **Approved by the founder.** All design decisions D1–D9 are confirmed (§27.1). Items marked **📏 MEASURE** still need prototype measurements (P3/P4). |

---

## Table of Contents
1. Overview and goals
2. Constraints and principles
3. High-level architecture
4. Components and responsibilities
5. Technology stack
6. Repository structure and migration from the prototype
7. Domain model and state machines
8. Data model (MongoDB collections, fields, indexes)
9. Object storage (Cloudflare R2)
10. Authentication, access control and user isolation
11. Application routes (UI)
12. API design (server actions and route handlers)
13. Background workflows (Inngest)
14. Generation pipeline in the application
15. Rendering subsystem (Remotion on Vercel Sandbox)
16. AI provider integration (Gemini, ElevenLabs)
17. Instagram integration (Meta)
18. Approval enforcement
19. Progress, notifications and real-time status
20. Reliability, idempotency and error handling
21. Security
22. Privacy and compliance
23. Abuse controls, quotas and spend ceilings
24. Observability and administration
25. Performance, capacity and cost
26. Environments, configuration, deployment and testing
27. Assumptions, open decisions and risks
28. Implementation plan

---

## 1. Overview and Goals

ByteReel is a web application where an educational creator turns a topic or notes into a **60–90 s vertical explainer video** (motion graphics + AI narration + synchronized captions), reviews it, and **downloads it or publishes/schedules it to Instagram Reels**.

**The four-step creator flow:** `① Idea → ② Review storyboard → ③ Generate and review video → ④ Publish`

**System goals**
| # | Goal | How the design meets it |
|---|---|---|
| G1 | Dead-simple UX, one primary action per screen | Thin UI over server-side state machines; the server decides what's possible next |
| G2 | Reliable long-running generation | Durable Inngest workflows; every stage is checkpointed in MongoDB + R2; resume without repeating paid calls |
| G3 | Never publish without approval | Immutable versioned plans and renders; hash-bound approvals re-checked at publish time (§18) |
| G4 | Strict per-user privacy | Every record and object is owner-scoped; repository layer requires `ownerId` (§10) |
| G5 | Free / low cost for V1 | Free tiers, internal spend ceilings, speech/render reuse, an allow-listed beta (§23, §25) |
| G6 | Reuse the proven pipeline | Prototype contracts, validation, compiler, providers and Remotion components move into a shared package (§6) |
| G7 | Languages: English, Hindi, Hinglish | Language and voice preset are plan fields; fonts and validation already support Devanagari |

**Out of scope for V1** (per the PRD): billing, branding, teams, series/autopilot, uploads, other platforms, analytics, music.

---

## 2. Constraints and Principles

**Constraints**
- **Solo developer.** Use managed services, one codebase and one language (TypeScript); avoid infrastructure to run by hand.
- **Free tiers first.** Gemini free tier, ElevenLabs free tier (≈10k characters/month, premade voices only via the API), Vercel Hobby, MongoDB Atlas free cluster, Inngest free tier, R2 free tier. Paid upgrades are listed in §25.
- **Private beta.** Allow-listed users only; target **20–50 beta users**.
- **India first.** Default timezone `Asia/Kolkata`; INR later.

**Design principles**
1. **The server owns state.** The UI renders what the server says the project's state allows.
2. **Immutable versions.** Plans, speech artifacts and renders are never edited in place. Changes create new versions.
3. **Derived data is recomputable.** Timelines and captions are derived from the plan and audio, and can be regenerated deterministically.
4. **Pay once.** Never repeat a paid provider call whose inputs haven't changed (content-addressed reuse).
5. **Fail clearly, recover cheaply.** Every failure has a plain-language message, and retry resumes from the last good checkpoint.
6. **Ownership is enforced in code, never trusted from the client or the model.**
7. **Rendering is deterministic.** No AI calls or randomness during render.

---

## 3. High-Level Architecture

```
                         ┌──────────────────────────────────────────────────────────────┐
  Creator's browser      │                    Vercel (Next.js app)                      │
 ┌──────────────────┐    │  ┌───────────────────────┐   ┌────────────────────────────┐  │
 │ Next.js React UI │◄──►│  │ App Router pages (RSC)│   │ Route handlers / Server    │  │
 │ (4-step flow)    │    │  │ + Server Actions      │   │ Actions (auth'd API)       │  │
 └──────────────────┘    │  └───────────┬───────────┘   └─────────────┬──────────────┘  │
          │              │              │      Domain services (packages/core)          │
          │ signed URLs  │              └──────────────┬────────────────┘               │
          │ (video/audio)│                             │ send events                    │
          ▼              │  ┌──────────────────────────▼────────────────────────────┐   │
 ┌──────────────────┐    │  │ /api/inngest  (Inngest functions run as Vercel fns)    │   │
 │ Cloudflare R2    │◄───┼──┤ plan · revise · generate · render · publish · refresh  │   │
 │ (private bucket) │    │  └───┬───────────────┬───────────────┬───────────────┬────┘   │
 └──────────────────┘    └──────┼───────────────┼───────────────┼───────────────┼────────┘
          ▲                     │               │               │               │
          │ upload MP4          ▼               ▼               ▼               ▼
 ┌──────────────────┐   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 │ Vercel Sandbox   │◄──┤ Inngest Cloud│ │ Google Gemini│ │ ElevenLabs   │ │ Meta         │
 │ Remotion render  │   │ (orchestr.)  │ │ (planning)   │ │ (speech+time)│ │ Instagram API│
 └──────────────────┘   └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
                                 │
                         ┌───────▼────────┐
                         │ MongoDB Atlas  │  users/sessions (Better Auth), projects, plan versions,
                         │                │  approvals, jobs, speech, renders, connections, posts …
                         └────────────────┘
```

**Request path (interactive):** browser → Next.js server action / route handler → domain service → MongoDB (and an Inngest event for anything slow) → returns immediately with the new state.

**Work path (slow):** Inngest event → Inngest function (durable steps, each a short Vercel function invocation) → provider calls / Vercel Sandbox render → R2 + MongoDB checkpoints → the project state is updated → the UI picks it up by polling (§19).

---

## 4. Components and Responsibilities

| Component | Responsibility | Never does |
|---|---|---|
| **Web UI** (Next.js React) | Four-step screens, project library, Instagram connect, polling status | Holds business rules; calls providers |
| **Server actions / route handlers** | AuthN/AuthZ, input validation (Zod), calling domain services, emitting Inngest events | Long-running work (> a few seconds) |
| **Domain services** (`packages/core`) | Project lifecycle, versioning, approvals, state transitions, quotas | Know about HTTP or React |
| **Pipeline library** (`packages/pipeline`, from the prototype) | Plan contracts, validation, hashing, planner, speech, alignment mapping, timeline/caption compiler | Know about users or HTTP |
| **Video package** (`packages/video`) | Remotion composition, 8 patterns, primitives, fonts, captions | Call any network service |
| **Inngest functions** | Durable orchestration, retries, concurrency limits, scheduling | Hold state outside MongoDB/R2 |
| **Render worker** (Vercel Sandbox) | Bundle + render the deterministic timeline to MP4, upload to R2 | Call AI providers |
| **Repositories** (`packages/db`) | Typed MongoDB access, **every query owner-scoped** | Return another owner's data |
| **Storage service** (`packages/storage`) | R2 keys, uploads, presigned URLs | Accept client-provided paths |
| **Instagram service** | OAuth, token encryption/refresh, publishing, reconciliation | Publish without a valid approval |

---

## 5. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict), Node.js 24 LTS | Same as the prototype |
| Web framework | **Next.js** (App Router, React Server Components, Server Actions) | Pinned at setup |
| UI | **Tailwind CSS + shadcn/ui** | Simple, accessible components; mobile-first |
| Client data | **TanStack Query** | Polling and status refresh |
| Validation | **Zod** | Shared with the pipeline contracts |
| Auth | **Better Auth** + MongoDB adapter | Email + password sign-up/login form (§10) |
| Database | **MongoDB Atlas** (official Node driver) | Free cluster for beta |
| Object storage | **Cloudflare R2** (S3-compatible API via AWS SDK v3) | Private bucket, presigned URLs |
| Orchestration | **Inngest** (TypeScript SDK) | Durable steps, retries, cron, concurrency keys |
| Hosting | **Vercel** | Web app + Inngest endpoint |
| Rendering | **Remotion** in **Vercel Sandbox** | 📏 benchmark in P3/P4; fallback in §15.5 |
| Planner | **Google Gemini** via `@google/genai` | Model from config; currently `gemini-3.6-flash` |
| Speech | **ElevenLabs** REST, `eleven_multilingual_v2`, with timestamps | Premade voices on the free plan |
| Instagram | **Meta Instagram API with Instagram Login** | Professional accounts; no Facebook Page needed |
| Error tracking | **Sentry** (free tier) | Frontend + server + Inngest |
| Testing | **Vitest**, mongodb-memory-server, **Playwright** | Unit, integration, E2E |
| CI | **GitHub Actions** | typecheck, lint, test on every push |

---

## 6. Repository Structure and Migration from the Prototype

A single repo using **npm workspaces**; no extra monorepo tooling.

```
/
├─ apps/
│  └─ web/                      # Next.js app (UI, server actions, route handlers, /api/inngest)
│     ├─ app/                   # routes (§11)
│     ├─ components/            # UI components (shadcn/ui)
│     ├─ server/                # server actions, auth helpers, request → service glue
│     └─ inngest/               # Inngest client + function registrations
├─ packages/
│  ├─ pipeline/                 # ← moved from prototype src/: contracts, planning, timing, providers, validation
│  ├─ video/                    # ← moved from prototype src/video: Remotion composition, patterns, fonts
│  ├─ core/                     # domain services: projects, versions, approvals, quotas, state machines
│  ├─ db/                       # MongoDB client, repositories (owner-scoped), index definitions, migrations
│  ├─ storage/                  # R2 ArtifactStore implementation, key builder, presigned URLs
│  └─ instagram/                # Meta OAuth, token crypto, publishing client, reconciliation
├─ render-worker/               # entry script run inside Vercel Sandbox (bundle + render + upload)
├─ tools/                       # the prototype CLI (kept for dev: fixtures, preflight, local render)
├─ docs/                        # PRD, PIPELINE_DESIGN, ARCHITECTURE (this file)
└─ fixtures/, examples/, tests/
```

**Migration rules**
1. Move the prototype code into `packages/pipeline` and `packages/video` **without behavior changes**; all 185 tests keep passing.
2. Replace `LocalArtifactStore` with an `R2ArtifactStore` that implements the same `ArtifactStore` interface. The local store stays for tests and the CLI.
3. Replace the local `manifest.json` run state with MongoDB `jobs` records (§8.9). The manifest states map 1:1.
4. Stage functions keep their signatures; they receive an **owner-scoped job reference** instead of a filesystem run path (as required by PIPELINE_DESIGN §4).

---

## 7. Domain Model and State Machines

### 7.1 Core entities

```
User 1───* Project 1───* PlanVersion 1───0..1 StoryboardApproval
                 │              │
                 │              └──* Revision (request that produced a version)
                 │
                 ├──* Job (plan / revise / generate / publish …)
                 ├──* Render (1 per generated version) ──* SpeechArtifact (per scene, reusable)
                 ├──* CaptionOverride (per render lineage)
                 └──* Post (Instagram) ──* PublishAttempt
User 1───0..1 InstagramConnection
```

**V1 cardinalities** (PRD): one owner per project, **one video per project** (the latest approved render is "the video"), one Instagram connection per user.

### 7.2 Project state machine

```
           create
  ┌──────► draft ──(submit idea)──► planning ──ok──► storyboard_ready ◄──┐
  │                                    │  fail                │          │ revision ok
  │                                    ▼                      │ revise ──┘
  │                                 plan_failed ─(retry)──► planning
  │                                                           │ approve storyboard (plan hash)
  │                                                           ▼
  │                                                       generating ──fail──► generate_failed ─(retry/resume)─► generating
  │                                                           │ ok              (needs_input → back to storyboard)
  │                                                           ▼
  │                       ┌──────────────── video_ready ◄─────┘
  │                       │  revise video / caption edit → new version → storyboard_ready or generating
  │                       │  publish now / schedule (publish approval)
  │                       ▼
  │                 publishing / scheduled ──► published
  │                       └──► publish_failed (retry)
  └─ archived (soft delete) ◄── any state except publishing
```

`needs_input` (from the pipeline) means "return for plan adjustment" (e.g. the duration is outside 60–90 s or the alignment is uncertain). The UI shows it as a clear message on the storyboard step.

### 7.3 Job state machine (maps to the prototype manifest)
`queued → running → (succeeded | failed | needs_input | cancelled)`, with per-stage status: `pending | running | succeeded | skipped | failed`.

### 7.4 Post state machine
```
draft ──approve+schedule──► scheduled ──time──► publishing ──► published
  │                            │  edit/re-render/disconnect → approval_invalidated (needs re-approval)
  └──approve+publish now──────►│                 │ container ERROR / expired → publish_failed (retry)
                               │ cancel ──► cancelled          │ timeout → outcome_unknown → reconcile → published | publish_failed
```

---

## 8. Data Model (MongoDB)

Conventions: `_id` is an ObjectId unless stated; all timestamps are UTC `Date`; every owner-scoped document has `ownerId`; documents carry `schemaVersion`. **Versioned documents are insert-only.**

### 8.1 Better Auth collections
`user`, `session`, `account` (holds the password hash for the email/password credential), `verification` (used for admin-issued password-reset tokens): managed by Better Auth (MongoDB adapter). Extra fields on `user`: `name`, `timezone` (default `Asia/Kolkata`), `defaultLanguage`, `defaultVoiceGender`, `role` (`creator` | `admin`), `status` (`active` | `suspended`), `failedLoginCount`, `lockedUntil?`.

### 8.2 `allowlist`
| Field | Type | Notes |
|---|---|---|
| `email` | string (lowercased) | **unique** |
| `invitedBy`, `createdAt`, `note` | | |
Sign-up is rejected unless the email is here (§10.2).

### 8.3 `projects`
| Field | Type | Notes |
|---|---|---|
| `_id`, `ownerId` | ObjectId | |
| `title` | string | From the plan title; editable |
| `language` | `en` \| `hi` \| `hinglish` | Chosen on the Idea step |
| `voiceGender` | `female` \| `male` | Maps to a voice preset |
| `input` | `{ type: topic\|notes\|brainstorm, text, brainstormChoice? }` | Notes ≤ 5,000 chars |
| `state` | enum (§7.2) | |
| `currentPlanVersionId` | ObjectId? | Latest plan version |
| `approvedPlanVersionId` | ObjectId? | Version with a valid storyboard approval |
| `currentRenderId` | ObjectId? | Latest successful render |
| `activeJobId` | ObjectId? | At most one active pipeline job per project |
| `stateVersion` | int | Optimistic concurrency (§20.4) |
| `lastError` | `{ code, message, at }`? | User-facing |
| `createdAt`, `updatedAt`, `archivedAt?` | | |

**Indexes:** `{ ownerId: 1, updatedAt: -1 }` (library), `{ ownerId: 1, state: 1 }`, `{ activeJobId: 1 }` (sparse).

### 8.4 `planVersions` (immutable)
| Field | Type | Notes |
|---|---|---|
| `_id`, `ownerId`, `projectId` | | |
| `versionNumber` | int | 1, 2, 3… per project |
| `parentVersionId` | ObjectId? | Lineage |
| `source` | `ai_plan` \| `ai_revision` \| `user_edit` \| `caption_edit` | |
| `plan` | object | Full plan contract (PIPELINE_DESIGN §5) |
| `planHash` | string | Canonical hash (`sha256:…`) |
| `validation` | `{ valid, issues[], warnings[] }` | |
| `stats` | `{ scenes, words, estimatedSeconds }` | |
| `plannerUsage` | `{ model, promptTokens, outputTokens, thinkingTokens, attempts }` | |
| `createdAt` | | |

**Indexes:** `{ projectId: 1, versionNumber: -1 }` **unique** on `(projectId, versionNumber)`, `{ ownerId: 1, projectId: 1 }`.

### 8.5 `revisions`
| Field | Notes |
|---|---|
| `ownerId`, `projectId`, `stage` (`storyboard` \| `video`), `scope` (`project` \| `scene`), `sceneId?` | |
| `message` | ≤ 500 chars |
| `basePlanVersionId`, `resultPlanVersionId?` | |
| `status` | `pending` \| `succeeded` \| `failed` \| `rejected` (unsafe/unclear) |
| `diff` | `{ changedSceneIds[], addedSceneIds[], removedSceneIds[], narrationChanged: bool }` |
**Index:** `{ projectId: 1, createdAt: -1 }`.

### 8.6 `storyboardApprovals` (immutable)
| Field | Notes |
|---|---|
| `ownerId`, `projectId`, `planVersionId`, `planHash` | Hash binds the approval to the exact plan |
| `approvedBy` (userId), `approvedAt` | |
**Index:** unique `(planVersionId)`.

### 8.7 `speechArtifacts` (content-addressed, owner-scoped)
| Field | Notes |
|---|---|
| `ownerId` | **Reuse never crosses owners** |
| `cacheKey` | sha256(narration input + pronunciation mapping + voiceId + model + settings + format + seed) |
| `sceneId`, `firstProjectId` | Provenance |
| `voiceId`, `model`, `settings` | |
| `audioKey`, `alignmentKey`, `normalizedAlignmentKey` | R2 keys |
| `durationMs`, `characters` | |
| `status` | `pending` \| `ready` \| `failed` |
| `createdAt` | |
**Index:** unique `(ownerId, cacheKey)`.

### 8.8 `renders`
| Field | Notes |
|---|---|
| `ownerId`, `projectId`, `planVersionId`, `planHash` | |
| `renderNumber` | Per project |
| `speech` | `[{ sceneId, speechArtifactId }]` |
| `captionOverrideSetId?` | |
| `timelineKey`, `captionsKey`, `mp4Key`, `thumbnailKey`, `previewFrameKeys[]` | R2 keys |
| `renderInputHash` | Hash of timeline + assets + composition version: identical input → reuse the render |
| `qa` | Machine checks (resolution, fps, duration, audio track, frames) |
| `status` | `pending` \| `rendering` \| `validating` \| `ready` \| `failed` |
| `metrics` | `{ renderMs, sandboxMs, bytes, durationMs, frames }` |
**Indexes:** unique `(projectId, renderNumber)`; `{ ownerId: 1, projectId: 1 }`; `{ ownerId: 1, renderInputHash: 1 }`.

### 8.9 `jobs` (replaces the prototype `manifest.json`)
| Field | Notes |
|---|---|
| `ownerId`, `projectId`, `type` (`plan` \| `revise` \| `generate` \| `caption` \| `publish`) | |
| `inputRef` | `{ planVersionId?, revisionId?, postId? }` |
| `state` | §7.3 |
| `stages` | `[{ name, status, startedAt, endedAt, attempts, error? }]` |
| `progress` | `{ stage, percent, message }` (shown in the UI) |
| `idempotencyKey` | unique; prevents duplicate jobs from double-clicks |
| `inngestRunId` | For tracing |
| `cancelRequestedAt?` | |
**Indexes:** unique `idempotencyKey`; `{ projectId: 1, createdAt: -1 }`; `{ state: 1, updatedAt: 1 }` (stuck-job sweeper).

### 8.10 `captionOverrides`
`ownerId`, `projectId`, `basePlanVersionId`, `overrides: [{ sceneId, phraseIndex, text }]`. Preserved across visual-only revisions (PIPELINE_DESIGN §5).

### 8.11 `instagramConnections`
| Field | Notes |
|---|---|
| `ownerId` | **unique** (one per user in V1) |
| `igUserId`, `username`, `accountType`, `profilePictureUrl?` | |
| `accessToken` | **Encrypted** `{ ciphertext, iv, tag, keyVersion }` (§21.4) |
| `tokenExpiresAt`, `lastRefreshedAt` | |
| `scopes[]` | |
| `status` | `active` \| `expired` \| `revoked` \| `error` |
**Indexes:** unique `ownerId`; `{ status: 1, tokenExpiresAt: 1 }` (refresh job).

### 8.12 `posts`
| Field | Notes |
|---|---|
| `ownerId`, `projectId`, `renderId`, `connectionId` | |
| `caption` | Instagram caption + hashtags (≤ 2,200 chars) |
| `mode` | `now` \| `scheduled` |
| `scheduledAt?` | UTC; displayed in the user's timezone |
| `approval` | `{ renderId, mp4Sha256, connectionId, igUserId, captionHash, approvedBy, approvedAt }` |
| `state` | §7.4 |
| `igContainerId?`, `igMediaId?`, `permalink?` | |
| `attempts`, `lastError?` | |
| `publishKey` | unique idempotency key for the publish operation |
**Indexes:** unique `publishKey`; `{ ownerId: 1, createdAt: -1 }`; `{ state: 1, scheduledAt: 1 }`; partial unique on `(projectId)` where `state ∈ {scheduled, publishing}` (one live post per project).

### 8.13 `publishAttempts`
`postId`, `ownerId`, `step` (`create_container` \| `poll` \| `publish` \| `reconcile`), `request` (redacted), `response` (redacted), `outcome`, `at`. Audit trail for every publish attempt (PRD §7).

### 8.14 `providerUsage`
`ownerId`, `projectId`, `jobId`, `provider` (`gemini` \| `elevenlabs` \| `vercel-sandbox` \| `meta`), `operation`, `model`, `units` (`{ promptTokens, outputTokens, characters, renderSeconds }`), `estCostInr`, `at`.
**Indexes:** `{ at: -1 }`, `{ ownerId: 1, at: -1 }`, `{ provider: 1, at: -1 }`. Feeds quotas and spend ceilings (§23).

### 8.15 `auditLogs`
`actorId`, `action` (e.g. `storyboard.approved`, `post.published`, `instagram.connected`, `account.deleted`), `subject` `{ type, id }`, `data` (redacted), `at`. TTL: none in V1.

### 8.16 `settings` (singleton, admin)
Global spend ceilings, per-user limits, allowed models and voices, a maintenance flag. Cached for 60 s in memory.

---

## 9. Object Storage (Cloudflare R2)

- **One private bucket** per environment (`bytereel-dev`, `bytereel-prod`). No public bucket access.
- **Key layout** (built only by `storage` code from IDs, never from client or model input):
```
users/{ownerId}/projects/{projectId}/plans/{planVersionId}/plan.json
users/{ownerId}/projects/{projectId}/plans/{planVersionId}/review.html
users/{ownerId}/speech/{cacheKey}/audio.mp3
users/{ownerId}/speech/{cacheKey}/alignment.json
users/{ownerId}/speech/{cacheKey}/alignment.normalized.json
users/{ownerId}/projects/{projectId}/renders/{renderId}/timeline.json
users/{ownerId}/projects/{projectId}/renders/{renderId}/captions.json
users/{ownerId}/projects/{projectId}/renders/{renderId}/output.mp4
users/{ownerId}/projects/{projectId}/renders/{renderId}/thumbnail.jpg
users/{ownerId}/projects/{projectId}/renders/{renderId}/frames/{n}.png
users/{ownerId}/projects/{projectId}/renders/{renderId}/qa.json
```
- **Access:** the browser plays and downloads via **presigned GET URLs** (TTL 15 min), issued only after an ownership check. Downloads use `Content-Disposition: attachment; filename="<title>.mp4"`.
- **Instagram fetch:** Meta needs a **public URL** for `video_url`. We issue a presigned GET with a TTL of **2 hours** (enough for container processing), used only for that container (decision D5). Verify during integration that Meta accepts presigned R2 URLs with query strings; if it doesn't, use a short-lived Next.js proxy route `/api/media/{token}` that streams from R2.
- **Integrity:** the SHA-256 of each artifact is stored in MongoDB, and the render worker verifies inputs before rendering.
- **Lifecycle:** keep everything in V1. Later: delete preview frames after 30 days, and delete unreferenced speech after 90 days.
- **Account deletion:** delete the `users/{ownerId}/` prefix (§22).

---

## 10. Authentication, Access Control and User Isolation

### 10.1 Sign-up and login (email + password form)
- **Better Auth email/password** with the MongoDB adapter, httpOnly secure session cookies (SameSite=Lax), 30-day sessions with rolling refresh.
- **Sign-up form:** name, email, password, confirm password. **Login form:** email, password.
- **Password rules:** minimum 8 characters (max 128); hashed by Better Auth (scrypt); never logged or returned.
- **No email sending in V1** (decision D3), which means:
  - **no email verification:** the private-beta allow-list (§10.2) controls who can sign up instead;
  - **no self-service "forgot password":** the login page says *"Forgot your password? Contact the ByteReel team."* An admin creates a **one-time reset link** (valid 1 hour) in the admin page and shares it with the user directly (§24.3).
- **Brute-force protection:** login and sign-up are rate-limited per IP and per email (e.g. 5 attempts per 15 min). After 10 failed logins, the account is locked for 15 min.
- **No account enumeration:** login failures always show *"Email or password is incorrect"*.
- **Logout** on every page (user menu). Changing the password revokes the user's other sessions.

### 10.2 Private beta allow-list
- Better Auth `databaseHooks.user.create.before` rejects sign-up unless the email is in `allowlist`.
- A rejected email sees a friendly *"ByteReel is in private beta — request access"* message on the sign-up form.
- Admins add emails through the admin page (§24.3).

### 10.3 Authorization
- **Roles:** `creator` (default) and `admin`.
- **Ownership rule:** every repository method takes `ownerId` as a required parameter and includes it in every filter. There is **no** "find by id" without the owner. Enforced by:
  1. a typed repository API (`projects.get(ownerId, projectId)`),
  2. a lint rule / code-review checklist item forbidding raw collection access outside `packages/db`,
  3. integration tests asserting user A can't read or modify user B's data (every route).
- **Server actions** call `requireUser()` first; IDs from the client are treated as untrusted and always re-checked with the owner.
- **Inngest functions** receive `{ ownerId, projectId, jobId }` in the event, and re-load and verify ownership before acting.
- **Presigned URLs** are generated only after an ownership check, and expire quickly.

### 10.4 Model boundaries
The planner model **cannot** set ownership, approve plans, choose storage paths or affect credentials. Those fields are stripped and assigned by code (already implemented in `planner-output.ts`).

---

## 11. Application Routes (UI)

| Route | Screen | Primary action |
|---|---|---|
| `/` | Landing (beta) | **Sign up** / **Log in** |
| `/signup` | Sign-up form: name, email, password, confirm password | **Create account** |
| `/login` | Login form: email, password; "Forgot your password? Contact the ByteReel team." | **Log in** |
| `/reset-password?token=…` | Opened from an admin-issued reset link: new password + confirm | **Set new password** |
| `/access-pending` | Email not on the allow-list | Request access (mailto/form) |
| `/dashboard` | Project library: cards with thumbnail, title, state badge, updated time; tabs *Drafts / Ready / Scheduled / Published* | **+ New video** |
| `/projects/new` | **① Idea:** topic or notes box, *Brainstorm with AI*, language chip, voice chip (Female/Male with ▶ preview) | **Create storyboard** |
| `/projects/[id]/storyboard` | **② Review storyboard:** scene cards (narration editable, visual plan, pattern badge, warnings), estimated duration, revision chat, version history + undo | **Approve & generate video** |
| `/projects/[id]/video` | **③ Generate & review:** progress steps → player, caption correction, revision chat | **Continue to publish** (+ Download) |
| `/projects/[id]/publish` | **④ Publish:** exact video + destination account, editable caption/hashtags, *Publish now* / *Schedule* | **Publish now** / **Schedule** |
| `/settings` | Instagram connection (connect/disconnect), defaults (language, voice, timezone), change password, delete account | **Connect Instagram** |
| `/admin` | Admin only: allow-list, users, jobs, failures, spend (§24.3) | — |

**UI rules (PRD §3):** a 4-step stepper on every project page; one primary button; the server state decides which step is active and what's enabled; every failure shows a plain message + **Retry**; mobile-first layouts; storyboard narration editing is inline (creates a `user_edit` plan version on save).

**Voice preview:** static, pre-generated MP3 samples per preset in `public/voices/` (generated once, so no per-click ElevenLabs cost).

---

## 12. API Design

Mutations are **Server Actions** (typed, CSRF-protected by Next.js); reads are RSC data fetching plus a few JSON **route handlers** for polling, OAuth callbacks and webhooks. Every endpoint: auth → Zod input validation → owner check → service call → typed result `{ ok: true, data } | { ok: false, error: { code, message } }`.

### 12.0 Authentication
Better Auth mounts its handler at `/api/auth/*` (sign-up, sign-in, sign-out, session, change password, reset password with a token). The UI calls it through the Better Auth client. Our extra rules: the allow-list hook on sign-up, rate limits and the lockout (§10.1), and the admin-only action `createPasswordResetLink({ userId })` (§24.3).

### 12.1 Projects and planning
| Operation | Type | Input | Effect |
|---|---|---|---|
| `brainstormIdeas` | action | `{ subject, language }` | Synchronous Gemini call (short), returns 5–8 ideas; rate-limited |
| `createProject` | action | `{ inputType, text, language, voiceGender }` | Creates a project (`draft→planning`), a job, an Inngest `plan.requested` event |
| `getProject` | RSC / `GET /api/projects/[id]` | — | Project + current plan version + job progress |
| `listProjects` | RSC | `{ tab, cursor }` | Paginated library |
| `editNarration` | action | `{ projectId, planVersionId, sceneId, narrationId, text }` | New `user_edit` plan version (validated); approval required again |
| `requestRevision` | action | `{ projectId, stage, scope, sceneId?, message }` | Revision record + `revision.requested` event |
| `undoToVersion` | action | `{ projectId, planVersionId }` | Sets `currentPlanVersionId` to an earlier version (no data deleted) |
| `retryJob` | action | `{ projectId, jobId }` | Re-emits the event for a failed job (resume) |
| `cancelJob` | action | `{ projectId, jobId }` | Sets `cancelRequestedAt`; functions check it between steps |
| `archiveProject` | action | `{ projectId }` | Soft delete (blocked while publishing) |

### 12.2 Approval and generation
| Operation | Type | Input | Effect |
|---|---|---|---|
| `approveStoryboard` | action | `{ projectId, planVersionId, planHash }` | Verifies the hash equals the stored version hash **and** it's the current version; writes `storyboardApprovals`; emits `video.generate.requested` with idempotency key `gen:{planVersionId}` |
| `editCaption` | action | `{ projectId, renderId, sceneId, phraseIndex, text }` | Saves an override; emits `video.recaption.requested` (re-render, no speech) |
| `getMediaUrl` | `GET /api/projects/[id]/media?kind=mp4\|thumb` | — | Ownership check → presigned URL redirect |

### 12.3 Instagram and publishing
| Operation | Type | Input | Effect |
|---|---|---|---|
| `startInstagramConnect` | `GET /api/instagram/connect` | — | Creates an OAuth `state` (signed, bound to the session), redirects to Meta |
| OAuth callback | `GET /api/instagram/callback` | `code, state` | Verify state → exchange code → long-lived token → fetch profile → store encrypted |
| `disconnectInstagram` | action | — | Deletes the token, marks the connection revoked, invalidates scheduled posts' approvals |
| `generateCaption` | action | `{ projectId, renderId }` | Gemini caption + hashtags (short call) |
| `publishNow` | action | `{ projectId, renderId, connectionId, caption, mp4Sha256 }` | Creates a post with an approval snapshot; emits `post.publish.requested` |
| `schedulePost` | action | `{ …same, scheduledAt }` | Validates `scheduledAt ≥ now + 10 min` and within 75 days; creates a `scheduled` post; emits `post.publish.requested` with a `ts` |
| `cancelScheduledPost` | action | `{ postId }` | `scheduled → cancelled` (conditional update) |
| Meta deauthorize callback | `POST /api/instagram/deauthorize` | signed request | Marks the connection revoked |
| Meta data-deletion callback | `POST /api/instagram/data-deletion` | signed request | Deletes Meta-derived data, returns a confirmation code + status URL (required by Meta) |

### 12.4 Error codes (user-facing messages mapped in the UI)
`UNAUTHENTICATED`, `NOT_FOUND` (also used for other owners' resources), `INVALID_INPUT`, `STALE_VERSION`, `APPROVAL_REQUIRED`, `APPROVAL_STALE`, `QUOTA_EXCEEDED`, `SPEND_CEILING`, `JOB_ALREADY_RUNNING`, `PROVIDER_BUSY`, `PROVIDER_REJECTED`, `NEEDS_INPUT`, `INSTAGRAM_NOT_CONNECTED`, `INSTAGRAM_TOKEN_EXPIRED`, `INSTAGRAM_ACCOUNT_INELIGIBLE`, `PUBLISH_LIMIT_REACHED`, `INTERNAL`.

---

## 13. Background Workflows (Inngest)

### 13.1 Functions

| Function | Trigger | Concurrency / limits | Steps (each checkpointed) |
|---|---|---|---|
| `plan-video` | `plan.requested` | key `ownerId`, limit 2; global limit 5 | load project → quota check → Gemini plan (+1 repair) → validate → insert `planVersion` → project `storyboard_ready` |
| `revise-plan` | `revision.requested` | key `projectId`, limit 1 | load base version → Gemini revise → validate → diff → insert version → state |
| `generate-video` | `video.generate.requested` | key `ownerId` limit 1; global limit **📏 2** | verify approval → spend check → **speech per scene** (`step.run` per scene, cache-aware) → validate audio + alignment → compile timeline/captions → upload → **render** (invoke `render-video`) → validate MP4 → project `video_ready` |
| `render-video` | invoked | global limit **📏 1–2** (Sandbox cost) | create Sandbox → run render-worker → wait for completion (poll with `step.sleep`) → verify the R2 outputs → teardown |
| `recaption-video` | `video.recaption.requested` | key `projectId`, limit 1 | apply overrides → recompile captions → render → validate |
| `publish-post` | `post.publish.requested` (optional `ts` for scheduling) | key `connectionId` limit 1 | `step.sleepUntil(scheduledAt)` → **re-check approval** (§18) → check the publishing limit → create container → poll status (`step.sleep` 15 s, up to 10 min) → publish → save permalink |
| `reconcile-publish` | `post.publish.unknown` | key `postId` | list recent media → match by container/caption/time → `published` or safe retry |
| `refresh-instagram-tokens` | cron daily 03:00 IST | — | refresh tokens expiring in < 10 days (and older than 24 h) |
| `sweep-stuck-jobs` | cron every 15 min | — | jobs `running` with no update for > 30 min → mark failed with a retry option |
| `spend-rollup` | cron hourly | — | aggregate `providerUsage` → ceilings cache |

### 13.2 Rules
- **Every step is idempotent** (keyed by job + stage + scene). Inngest's retries replay completed steps from memo.
- **Retries:** transient provider errors use a ≤2 retry policy honoring `Retry-After` (as in the prototype). Inngest function-level retries are 3 for infrastructure errors. Non-retriable errors use Inngest's `NonRetriableError`.
- **Cancellation:** `cancelOn` matches `job.cancelled` with the same `jobId`; steps also check `cancelRequestedAt`.
- **Vercel function duration:** each step must finish within the plan's function limit. Long waits use `step.sleep` / `step.waitForEvent`, never in-process waiting. Rendering happens **in the Sandbox**, not in the function.
- **Events carry IDs only** (no plan bodies, no secrets).

---

## 14. Generation Pipeline in the Application

The stages are exactly those of PIPELINE_DESIGN §8; the application adds persistence and ownership.

```
approveStoryboard ─► generate-video
   1. verify approval: storyboardApprovals.planHash == planVersions.planHash (current)
   2. spend + quota check (§23)
   3. for each scene (sequential, to respect provider limits):
        cacheKey = hash(narration, mapping, voiceId, model, settings, format, seed)
        speechArtifacts.find(ownerId, cacheKey) → reuse, or
        ElevenLabs TTS with timestamps → R2 (audio + both alignments) → speechArtifacts(ready)
        validate audio duration and alignment arrays; map normalization (numbers/acronyms)
        uncertain mapping → job needs_input ("check scene N wording")
   4. compile timeline + captions (deterministic) → R2; frames must be 1,800–2,700
        else needs_input "return for plan adjustment"
   5. renderInputHash → existing ready render for this owner? reuse : invoke render-video
   6. validate MP4 (1080×1920, 30 fps, H.264, AAC track, duration ±1 frame, decoded frame count)
   7. renders.status=ready → project.currentRenderId, state video_ready
```

**Revision effects** follow PIPELINE_DESIGN §9 (visual-only → no speech; one scene's narration → that scene's speech only; voice switch → all scenes; caption edit → captions + render only).

**Brainstorm and Instagram caption** are short Gemini calls made synchronously from server actions (with a timeout of 30 s). If they're slow or busy, the UI shows "busy, try again"; they never block the main flow.

---

## 15. Rendering Subsystem (Remotion on Vercel Sandbox)

### 15.1 Why separate
Rendering 60–90 s of 1080×1920 video takes minutes of CPU (≈4–5 min locally in the prototype). It can't run inside a normal serverless function, so it runs in an isolated, short-lived **Vercel Sandbox** microVM.

### 15.2 Lifecycle
1. `render-video` creates a Sandbox (Node 24 runtime, timeout ≈ 15 min, vCPUs **📏** chosen from the benchmark).
2. Provisioning: a pre-built **render-worker bundle** (Remotion bundle + fonts + composition, built in CI and stored in R2 or a snapshot) is downloaded. No `npm install` at render time if avoidable. **📏** measure cold-start time.
3. The worker receives a **render job token** (short-lived, scoped to the inputs) plus presigned GET URLs for `timeline.json`, `captions.json` and scene audio, and presigned PUT URLs for the outputs. **No long-lived credentials go into the Sandbox.**
4. The worker verifies input hashes → renders the MP4 + thumbnail + preview frames → uploads via the presigned PUTs → writes a completion record (stdout JSON).
5. The function reads the result, verifies the R2 objects (size, hash) and **tears down the Sandbox** in a `finally` step.

### 15.3 Determinism and validation
The composition version (git SHA of `packages/video`) is part of `renderInputHash`. MP4 validation runs after upload (in a Sandbox or a lightweight probe) using the prototype's `validation/mp4.ts`.

### 15.4 Failure handling
Sandbox creation failure / timeout → retry once → `generate_failed` with **Retry**. Speech artifacts are kept, so the retry costs only render time.

### 15.5 Benchmark and fallback (📏 P3/P4)
Measure cold start, render time and cost per 60/90 s video at 2/4/8 vCPUs. If too slow or costly: **fallback A** is Remotion Lambda (AWS); **fallback B** is a small always-on VPS render worker pulling jobs (cheapest at low volume). The `Renderer` interface keeps this swappable.

---

## 16. AI Provider Integration

### 16.1 Gemini (planner)
- Adapter from the prototype (`@google/genai`, streaming, structured JSON output).
- **Model config:** one model, `GEMINI_MODEL` (currently `gemini-3.6-flash`). **No automatic model fallback** (decision D4). When Gemini stays busy after the allowed retries, the job fails with `PROVIDER_BUSY` and the creator sees: *"Our AI is very busy right now. Your idea is saved; please try again in a few minutes."* with a **Try again** button. Changing the model is an admin config change, recorded on each plan version (`plannerUsage.model`).
- Schema compatibility: no `minItems`/`maxItems` in the response schema (verified incompatibility); limits are enforced by our validation + one repair.
- Timeouts: 180 s per request; at most 3 requests per plan job (initial + up to 2 transient retries) plus 1 repair.
- **Data use:** on the free tier, Google may use content to improve its products. **Before real beta users, switch to the paid tier** (§22).

### 16.2 ElevenLabs (speech)
- Adapter from the prototype (REST, `eleven_multilingual_v2`, with timestamps, `previous_text`/`next_text`, fixed seed, `mp3_44100_128`).
- **Voices are a backend detail:** creators only ever see "Female voice" / "Male voice". Voice names, voice IDs and provider names are never sent to the frontend or shown in the UI (the creator API returns only `preset`, `gender`, a generic `label` and a pre-recorded sample).
- **Voices:** 4 configured presets (English F/M, Hindi F/M; Hinglish uses Hindi). On the free plan, only **premade** voices work via the API (currently Alice/Daniel for English). Indian-accent library voices need a paid plan (§25).
- **Budget:** a per-job character cap (1.5× narration) and per-user/global monthly ceilings (§23). Characters are counted **before** sending.
- Error policy: transient → ≤2 retries; `402`/quota/voice errors → non-retriable with a clear message; **no silent voice substitution**.

### 16.3 Prompt-injection posture
User notes and topics are passed as **data** inside clearly delimited sections. The model's output is strictly schema-validated, and it has no tools and no side effects. The worst case is a bad plan, which the creator reviews before anything is generated.

---

## 17. Instagram Integration (Meta)

### 17.1 Setup
- **Meta developer app** with the **Instagram API with Instagram Login** product.
- Permissions: `instagram_business_basic`, `instagram_business_content_publish`.
- Redirect URI: `https://<domain>/api/instagram/callback`; deauthorize and data-deletion callback URLs configured.
- **App Review** with a screencast of the connect + publish flow is needed before non-tester users can connect. Until then, testers are added in the app dashboard.

### 17.2 Connect flow
```
User → /api/instagram/connect → (state = signed{sessionId, nonce, exp})
     → www.instagram.com/oauth/authorize?client_id&redirect_uri&scope&response_type=code&state
Meta → /api/instagram/callback?code&state
     → verify state → POST api.instagram.com/oauth/access_token (short-lived token, user_id)
     → GET graph.instagram.com/access_token?grant_type=ig_exchange_token (long-lived, ~60 days)
     → GET graph.instagram.com/me?fields=user_id,username,account_type,profile_picture_url
     → account_type must be BUSINESS or MEDIA_CREATOR, else INSTAGRAM_ACCOUNT_INELIGIBLE
     → encrypt + store token → redirect to /settings or back to the publish step
```
*(Exact endpoints and versions are verified against Meta's current docs during implementation.)*

### 17.3 Publishing flow (`publish-post`)
1. **Approval re-check** (§18), then the connection is `active` and the token isn't expired.
2. **Limit check:** `GET /{ig-user-id}/content_publishing_limit`. If exhausted → `PUBLISH_LIMIT_REACHED`, post delayed with a notice (never dropped).
3. **Create container:** `POST /{ig-user-id}/media` with `media_type=REELS`, `video_url=<presigned R2 URL>`, `caption`, `share_to_feed=true` → `igContainerId` (saved **before** moving on).
4. **Poll:** `GET /{container-id}?fields=status_code` every 15 s (via `step.sleep`) until `FINISHED` (max ~10 min). `ERROR`/`EXPIRED` → `publish_failed` with a reason.
5. **Publish:** `POST /{ig-user-id}/media_publish?creation_id=<container>` → `igMediaId`; then fetch `permalink`.
6. Record `publishAttempts` for every call; the project becomes `published`.

### 17.4 Unknown outcomes and duplicates
If `media_publish` times out or the network fails, the outcome is **unknown**: we must not blindly retry (that risks a double post). → `outcome_unknown` → `reconcile-publish` lists recent media (`/{ig-user-id}/media?fields=id,caption,timestamp`) and matches by time window + caption hash. Found → `published`; not found after 2 checks → safe to retry the publish with the same container (if it's not expired).

### 17.5 Scheduling races
| Race | Handling |
|---|---|
| Video re-rendered or caption changed after scheduling | The approval snapshot no longer matches → `approval_invalidated`; the creator is notified to re-approve; the job won't publish |
| Instagram disconnected/reconnected to another account | `igUserId` mismatch → invalidated |
| User cancels while the job sleeps | `cancelOn` + state check → no publish |
| Double-click "Publish now" | Unique `publishKey` → one post |
| Token expires before the slot | Refresh cron; if it fails → post `publish_failed` (reason: reconnect) + banner |
| Two scheduled posts for the same project | Partial unique index (one live post per project) |

### 17.6 Token refresh
Long-lived tokens (~60 days) are refreshed by cron when < 10 days remain (and the token is > 24 h old) via `graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`. If refresh fails, the connection becomes `expired` and the user sees a reconnect banner.

---

## 18. Approval Enforcement

| Approval | Bound to | Created by | Checked at | Invalidated by |
|---|---|---|---|---|
| **Storyboard** | `planVersionId` + `planHash` | `approveStoryboard` (the creator only) | start of `generate-video` | Any new plan version (edit, revision, undo) |
| **Publish** | `renderId` + `mp4Sha256` + `connectionId` + `igUserId` + `captionHash` | `publishNow` / `schedulePost` (the creator only) | **immediately before** container creation **and** before `media_publish` | Re-render, caption change, disconnect/reconnect, account change |

**Implementation guarantees**
- Approvals are separate immutable documents/snapshots; the model and background jobs can never create them.
- Publish state transitions use **conditional updates** (`updateOne({ _id, state: 'scheduled', 'approval.renderId': X }, …)`), so a concurrent edit can't slip through.
- The UI shows exactly what will be published (video thumbnail, duration, caption, destination `@username`) next to the approve button.

---

## 19. Progress, Notifications and Real-Time Status

- **Progress model:** `jobs.progress = { stage, percent, message }`, updated by Inngest steps (e.g. "Recording narration · scene 3 of 5").
- **Delivery:** simple client polling via TanStack Query: every **2 s** while a job is active, then stop (decision D2). Push updates (Server-Sent Events / Inngest Realtime) are a later improvement.
- **Leaving the page:** jobs continue; the library shows the state badge; returning restores the step.
- **Notifications in V1:** in-app only: a banner and toast on the next visit ("Your video is ready", "Post published", "Instagram needs reconnecting"). **No email notifications** (decision D3).

---

## 20. Reliability, Idempotency and Error Handling

### 20.1 Idempotency
| Operation | Key |
|---|---|
| Create plan job | `plan:{projectId}:{inputHash}` |
| Generate | `gen:{planVersionId}` |
| Speech per scene | `speechArtifacts (ownerId, cacheKey)` unique |
| Render | `renderInputHash` (reuse) + `render:{jobId}` |
| Publish | `posts.publishKey = pub:{projectId}:{renderId}:{connectionId}:{scheduledAt or 'now'}` |
| Inngest events | event `id` = the idempotency key (Inngest dedupes) |

### 20.2 Retry matrix
| Failure | Retry | User sees |
|---|---|---|
| Gemini 503/504/timeout | ≤2 (Retry-After) then fail; **no model switch** | "Our AI is very busy right now. Your idea is saved; please try again in a few minutes." + Try again |
| Gemini 400 / safety | none | Safety: "We can't make a video about this topic"; 400: internal alert |
| Invalid plan after repair | none | "Couldn't build a good storyboard, try rephrasing" |
| ElevenLabs transient | ≤2 | "Voice service busy" + Retry |
| ElevenLabs 401/402/quota/voice | none | "Voice service unavailable", admin alert |
| Alignment uncertain | none | needs_input: "Please adjust the wording in scene N" |
| Duration out of range | none | needs_input: "Make it shorter/longer" suggestion |
| Sandbox/render failure | 1 | "Rendering failed" + Retry (speech reused) |
| MP4 validation failure | 1 re-render | Same |
| Instagram container ERROR | none | Reason from Meta + Retry |
| Instagram unknown outcome | reconcile | "Checking whether your post went live…" |

### 20.3 Stuck jobs
`sweep-stuck-jobs` marks jobs with no progress for 30 min as failed (retryable), and clears `projects.activeJobId`.

### 20.4 Concurrency
- One active pipeline job per project (`activeJobId`, set with a conditional update).
- Project updates use `stateVersion` optimistic concurrency. A stale tab gets `STALE_VERSION` → "This project changed in another tab, refresh".

### 20.5 Backups
**Not in V1** (decision D6; the PRD also excludes a backup system). The MongoDB Atlas free tier has no automated backups. This is accepted for the private beta, and backups are planned for a later version (e.g. the Atlas paid tier or a scheduled `mongodump` to R2).

---

## 21. Security

### 21.1 Threat model highlights
Cross-user data access, Instagram token theft, publishing without consent, provider-key leakage, quota abuse, prompt injection, XSS in user/model text.

### 21.2 Controls
| Area | Control |
|---|---|
| AuthN | Better Auth email/password; scrypt-hashed passwords; httpOnly + Secure + SameSite=Lax cookies; login rate limits + temporary lockout; generic login errors; admin-issued one-time reset links (1 h) |
| AuthZ | Owner-scoped repositories; `NOT_FOUND` for other owners' resources; tests per route |
| CSRF | Server Actions (origin checks) + signed OAuth `state` |
| Input | Zod on every action and route; length limits (topic 300, notes 5,000, revision 500, caption 2,200) |
| Output/XSS | React escaping; **no `dangerouslySetInnerHTML`** for model/user text; the review HTML is generated server-side with escaping (already in the prototype) |
| Secrets | Vercel environment variables only; never sent to the client; redaction in logs (prototype masking reused) |
| Instagram tokens | AES-256-GCM encryption at rest (§21.4); never logged; scopes minimal |
| Sandbox | Only presigned, input-scoped URLs; no provider or DB credentials inside |
| Rate limiting | Per user + per IP on brainstorm, create, revise, approve, publish (Mongo-backed token bucket) |
| Headers | CSP (self + R2 + Instagram CDN for avatars), HSTS, X-Frame-Options DENY, Referrer-Policy strict-origin |
| Dependencies | Pinned versions, `npm audit` in CI, Dependabot |
| Admin | `role=admin` checked server-side; admin actions audit-logged |

### 21.3 Webhook/callback verification
Meta deauthorize and data-deletion callbacks verify the `signed_request` HMAC with the app secret.

### 21.4 Token encryption
`TOKEN_ENCRYPTION_KEYS` (JSON map `{ version: base64Key }`) and `TOKEN_ENCRYPTION_ACTIVE_VERSION`. Each record stores `keyVersion`, which allows key rotation (decrypt with the old key, re-encrypt with the new one).

---

## 22. Privacy and Compliance

- **India DPDP Act:** privacy policy + terms before the beta; clear purpose (generating and publishing the user's videos); consent at sign-up; **account deletion** removes MongoDB records, the R2 prefix and Instagram tokens (and audit logs are anonymized).
- **Provider data use:** while on **Gemini's free tier**, only test content may be used. **Switch to Gemini's paid tier before real beta users' content** (so it isn't used for training). The ElevenLabs commercial plan is required before publishing real users' videos (the free plan is non-commercial/attribution).
- **Meta Platform Terms:** data-deletion callback, a deauthorize handler, only the needed scopes, Meta data never used for other purposes.
- **Retention (V1):** keep user content until deletion; provider usage logs 12 months.
- **Content safety:** Gemini safety settings + refusal handling; the creator approval step; a terms clause that the creator is responsible for published content.

---

## 23. Abuse Controls, Quotas and Spend Ceilings

No credits are shown to users in V1 (PRD). Internal limits are configured in `settings`:

| Limit | Default (confirmed: 3 videos/day; others tuned during the beta) |
|---|---|
| **Videos generated (renders) per user per day** | **3** (decision D8) |
| Projects created per user per day | 5 |
| Plan + revision requests per project | 20 |
| ElevenLabs characters per user per month | 3,000 |
| **Global ElevenLabs characters per month** | 90% of the plan quota |
| Global Gemini requests per day | Below the free-tier daily limit |
| Global Sandbox render minutes per day | 📏 from the benchmark |

When a limit is hit, the user sees a friendly message ("You've reached today's limit, try again tomorrow"), and global ceilings pause new generations (existing videos stay accessible). Every provider call writes `providerUsage` **before** the call (reserved) and is finalized after.

---

## 24. Observability and Administration

### 24.1 Logging
Structured JSON logs (`level, msg, ownerId (hashed), projectId, jobId, stage, durationMs, provider, outcome`), with secrets redacted. Vercel log drains are optional later.

### 24.2 Metrics (from MongoDB, shown in the admin view)
Time from idea to storyboard, storyboard→video time, render time, success/failure rate per stage, revisions per project, ElevenLabs characters per video, Gemini tokens per plan, estimated cost per video, publish success rate. These map to the PRD §4 beta measures.

### 24.3 Admin page (`/admin`)
Allow-list management; user list (projects, usage, suspend); **create a one-time password-reset link** for a user (shown once, valid 1 h, shared with the user directly; audit-logged); job list with filters (failed, stuck) and **retry**; provider usage and spend vs ceilings; settings editor (limits, models, voices, maintenance mode).

### 24.4 Alerts
Sentry for exceptions. Notify the admin (Sentry alert / email from Sentry) when the failure rate spikes, spend reaches 80% of a ceiling, a provider auth error occurs, or a publish fails.

### 24.5 Tracing
`jobId` and `inngestRunId` link UI → job → Inngest run → provider calls, and the Inngest dashboard shows step-level timing and retries.

---

## 25. Performance, Capacity and Cost

### 25.1 Targets (PRD)
Storyboard < 30 s (observed: 34–36 s with Gemini 3.6 Flash including thinking, so **tune the prompt and thinking** 📏); idea→video < 5 min (render-bound 📏); page loads < 2 s on 4G.

### 25.2 Beta capacity
50 users × ~3 videos/week ≈ 150 videos/week ≈ 22/day. With render concurrency 1–2 and ~4–6 min per render, ~25 renders/hour is possible, which is well above need.

### 25.3 Free-tier limits and upgrade triggers
| Service | Free tier reality | Upgrade when |
|---|---|---|
| Gemini | Rate-limited; content may be used for training; overload on newer models | **Before real users** → paid tier |
| ElevenLabs | ~10k chars/month (~10 videos); premade voices only via API; non-commercial | **Before real users** → Starter/Creator (Indian voices + commercial rights + more characters) |
| Vercel Hobby | Non-commercial; function and Sandbox limits | Commercial launch → Pro |
| MongoDB Atlas free | 512 MB, no backups | > 300 MB or production → paid tier |
| Inngest free | Run/step limits per month | Check usage monthly |
| Cloudflare R2 | 10 GB storage free, free egress | > 10 GB (~4,000 videos) |
| Meta API | Free | — |

### 25.4 Cost per video (to fill from P3/P4 measurements 📏)
Gemini tokens (~11–14k per plan) + ElevenLabs (~1,000 characters) + Sandbox render minutes + storage. The `providerUsage` collection produces the real number for the pricing decision (PRD §14, V2 billing).

---

## 26. Environments, Configuration, Deployment and Testing

### 26.1 Environments
| Env | Purpose | Data |
|---|---|---|
| **local** | Development; fixture mode works without keys | Local MongoDB (Docker) or an Atlas dev DB; the local or a dev R2 bucket; Inngest Dev Server |
| **preview** | Vercel preview per branch | Dev Atlas DB, dev bucket, Inngest branch environment |
| **production** | Beta users | Prod Atlas DB, prod bucket, Inngest prod |

### 26.2 Environment variables
```
# App / auth
NEXT_PUBLIC_APP_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL
# Database / storage
MONGODB_URI, MONGODB_DB, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
# Orchestration / rendering
INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY, VERCEL_SANDBOX_* (token/team/project as required), RENDER_BUNDLE_URL
# AI providers (from the prototype)
GEMINI_API_KEY, GEMINI_MODEL, ELEVENLABS_API_KEY, ELEVENLABS_MODEL,
ELEVENLABS_VOICE_ID_INDIAN_MALE, ELEVENLABS_VOICE_ID_INDIAN_FEMALE,
ELEVENLABS_VOICE_ID_HINDI_MALE, ELEVENLABS_VOICE_ID_HINDI_FEMALE
# Instagram
META_APP_ID, META_APP_SECRET, INSTAGRAM_REDIRECT_URI,
TOKEN_ENCRYPTION_KEYS, TOKEN_ENCRYPTION_ACTIVE_VERSION
# Observability
SENTRY_DSN
```
Validated at startup with Zod (extending the prototype's config loader); missing values fail fast with a clear message.

### 26.3 Deployment
- GitHub → Vercel (preview on PRs, production on `main`).
- **DB indexes and migrations:** `packages/db/migrations` run by a deploy-time script (idempotent `createIndexes`, versioned data migrations).
- The **render bundle** is built in CI on changes to `packages/video` and uploaded to R2 with a versioned key; `RENDER_BUNDLE_URL` points at the current version.
- The Inngest app syncs automatically on deploy (`/api/inngest`).

### 26.4 Testing strategy
| Level | What | Tools |
|---|---|---|
| Unit | Pipeline (existing 185 tests), services, state machines, approval rules, crypto | Vitest |
| Integration | Repositories with owner isolation, server actions, Inngest functions with mocked providers | Vitest + mongodb-memory-server + Inngest test engine |
| Contract | Provider adapters against recorded responses (no live calls in CI) | Vitest fixtures |
| E2E | Sign in (test auth), idea → storyboard → approve → video (fixture renderer) → publish (mocked Meta) | Playwright |
| Manual QA | Real flows on preview, mobile widths, failure scenarios | `manual-qa` agent + checklist |
| Live smoke | One live plan + one scene of speech, before releases, within the character budget | CLI preflight `--network` + a probe |

**Security tests (required):** user A cannot read, modify, approve, publish or get media URLs for user B's project; an approval goes stale after any change; there's no double publish under concurrent requests.

---

## 27. Assumptions, Open Decisions and Risks

### 27.1 Confirmed design decisions (founder, 2026-11-12)
| # | Decision | Where |
|---|---|---|
| D1 | **Email + password sign-up/login form** (Better Auth); no social login | §10.1, §11 |
| D2 | **Simple polling** (every 2 s) for progress | §19 |
| D3 | **No email** in V1: no email notifications, no email verification, no self-service password reset (admin-issued reset links instead) | §10.1, §19, §24.3 |
| D4 | **No automatic Gemini model fallback**: show a clear "AI is busy, try again" message instead | §16.1, §20.2 |
| D5 | **Presigned R2 URLs** for Instagram `video_url` (a proxy route only if Meta rejects them) | §9 |
| D6 | **No database backups in V1**; planned for a later version | §20.5 |
| D7 | Voice previews use **pre-recorded sample clips** | §11 |
| D8 | **3 videos per user per day** (other limits tuned in the beta) | §23 |
| D9 | **One repository** with npm workspaces | §6 |

**Still to verify during implementation:** that Meta accepts presigned R2 URLs (D5), and the exact current Meta and Vercel Sandbox API details.

### 27.2 Pending measurements (📏 from prototype P3/P4)
Render time and cost on Vercel Sandbox; cold-start time; storyboard latency after prompt tuning; real characters per video; Hindi/Hinglish quality with the available voices.

### 27.3 Risks
| Risk | Mitigation |
|---|---|
| Gemini free-tier overload (seen: 3.8/3.7 Flash) | Retries + a clear "try again" message; admin can change the model; the paid tier before launch |
| Users forget passwords (no email reset in V1) | Admin-issued one-time reset links; email reset in a later version |
| ElevenLabs free plan can't use Indian voices via the API | Premade voices for testing; **paid plan before launch** |
| Vercel Sandbox render too slow/costly | Benchmark; Lambda or VPS fallback behind the `Renderer` interface |
| Meta App Review delay | Start early; testers meanwhile; download always works |
| Vercel Hobby is non-commercial | Pro at commercial launch |
| Solo-developer bandwidth | Reuse the prototype; strict V1 scope; phased plan (§28) |

---

## 28. Implementation Plan

Each phase ends with something working end-to-end and goes through **code-reviewer** + **manual-qa** before the next one.

| Phase | Deliverable | Depends on |
|---|---|---|
| **A0. Finish prototype gate** | P3/P4 per PIPELINE_DESIGN: first voiced video, 3 topics, revision, voice switch, Hindi/Hinglish, recovery; render benchmark | Founder approval of the storyboard; ElevenLabs budget |
| **A1. Monorepo + foundation** | npm workspaces; move the prototype into `packages/pipeline` + `packages/video` (tests green); Next.js app shell; Tailwind/shadcn; env validation; Sentry | — |
| **A2. Auth + data layer** | Better Auth email/password sign-up + login forms, allow-list, rate limits/lockout, admin reset links; MongoDB repositories (owner-scoped) + indexes + migrations; R2 storage service; dashboard shell | A1 |
| **A3. Idea → storyboard** | Idea screen, brainstorm, `plan-video` Inngest function, storyboard screen, narration edit, revisions, versions/undo, storyboard approval | A2 |
| **A4. Generate & review video** | `generate-video`, speech cache in Mongo/R2, `render-video` on Vercel Sandbox, progress polling, player, download, caption correction, video revisions | A3 + A0 benchmark |
| **A5. Instagram** | Meta app, connect flow, token encryption + refresh, publish now, schedule, cancel, reconciliation, callbacks; submit App Review | A4 |
| **A6. Beta hardening** | Quotas + spend ceilings, admin page, rate limits, security headers, privacy/terms, account deletion, E2E tests, paid-tier switches, deploy to production, invite beta users | A5 |
