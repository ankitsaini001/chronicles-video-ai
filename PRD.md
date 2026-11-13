# ByteReel — Product Requirements Document (V1)

| | |
|---|---|
| **Product** | **ByteReel** *(by TechByte Chronicles)* |
| **Version** | V1 (MVP), **v1.0 FINAL** |
| **Owner** | Solo founder-developer |
| **Status** | ✅ **Final.** Approved for build; aligned with the Namaste AI Season 2 (Akshay Saini) PRD and stack |
| **Last updated** | 2026-11-12 |

> **How to change this PRD:** it is now the baseline for building. Any change in scope, flow or stack must be added to the Decisions Log (§21) with a date, so we always know what changed and why.
>
> **Summary of alignment:** follows the course PRD's structure, decisions, implementation defaults, goals/non-goals and tech stack (Next.js, Better Auth, MongoDB Atlas, Cloudflare R2, Vercel, Inngest, Remotion + Vercel Sandbox). **Our intentional difference:** V1 supports **English (launch default), Hindi and Hinglish**.

---

## 1. Product Summary

ByteReel is a web application that turns an idea or teaching notes into a **60–90-second educational video** with AI narration, explanatory motion graphics and synchronized captions. A creator reviews a combined script and storyboard, approves generation, previews the result, and then downloads, publishes or schedules the video for Instagram.

The product hides production complexity behind four steps:

**Idea → Review storyboard → Generate and review video → Publish**

The creator **approves the story before rendering** and **approves the finished video before publishing**. Writing, scene planning, voice generation, timing, animation, captioning and export are coordinated automatically.

The initial experience prioritizes **clear explanations and easy corrections**. A technically valid video that contains misleading visuals, unreadable text or poorly synchronized narration does **not** meet the product promise.

---

## 2. Decisions and Assumptions

### 2.1 Agreed product decisions

| Area | V1 decision |
|---|---|
| Content | Educational explainer videos |
| Duration | AI targets 60–90 seconds; no mandatory duration selector |
| Workflow | Four steps, with script and storyboard reviewed together |
| Planning | Enter an idea, paste notes, or brainstorm with AI |
| Video | Explanatory motion graphics synchronized with AI narration |
| Captions | Included automatically and editable |
| Changes | Conversational revisions at the storyboard and video stages |
| Delivery | Preview, vertical 1080p MP4 export, Instagram publishing and scheduling |
| Persistence | Accounts, project library, autosave, generation history and failure recovery |
| **Languages** | **English (launch default), Hindi, Hinglish**: one simple language choice per project |
| **Voice** | **Male / Female** narrator choice per project (one curated voice of each for every language) |
| Branding | No brand kit, logo upload or user-configurable branding tools |
| Billing | No subscription checkout, credit balance or billing dashboard |
| Approval | Nothing publishes without explicit creator approval of that exact version and destination |
| Preferred tools | Gemini for planning, ElevenLabs for speech, Remotion for animation and rendering, Meta API for Instagram |

### 2.2 Implementation defaults

These defaults make the specification buildable. They can change during review without changing the four-step workflow.

- **Launch with English** narration and captions. Hindi and Hinglish are available as a single language choice. Language is stored on every project and in all data structures, so more languages can be added later.
- **One polished default visual style.** For narration, the creator picks just **Male or Female** (default: Female). Each language has one curated male voice and one curated female voice, set in internal configuration (ElevenLabs voice IDs). Creators never browse voice libraries, and there is **no required voice/style setup screen**.
- One Instagram connection per user, one owner per project, one video per project.
- A single sign-in method at first (the exact provider is an engineering decision, via Better Auth).
- Vertical **9:16 only**, at **1080 × 1920**, **30 fps**.
- Target **adult creators**. Child-directed accounts and classroom administration are outside V1.
- **Private / limited beta without billing.** Apply internal abuse controls and spend ceilings, without exposing a credit product.
- **No background music** in the initial release. Speech, animation and captions are enough for the agreed scope.
- Begin with **eight reusable motion patterns**: title/hook, labeled diagram, process flow, comparison, timeline, chart, step sequence, takeaway.

---

## 3. Audience, Problem and Value

### Primary audience
Educational creators, coaches and subject-matter experts who want to explain one concept clearly, without recording themselves or learning video-editing software. Initial market: India, which is why Hindi and Hinglish matter.

### Primary job to be done
> "When I have something useful to teach, help me turn it into a clear, attractive short video that I can review and publish with minimal manual production work."

### Problems addressed
- Turning a topic into a concise, engaging explanation takes time.
- Matching visuals to narration requires animation and editing skills.
- Producing captions and managing timing is repetitive work.
- Correcting a small mistake often means rebuilding or re-editing a video.
- Moving approved files into a separate publishing process creates friction.
- Most tools produce poor results for Hindi/Hinglish explainers.

### Product differentiation hypothesis
Creators will value relevant explanatory visuals, straightforward corrections, a dependable idea-to-publishing workflow, and good Hindi/Hinglish support. *This hypothesis must be validated through actual published videos and repeat use; it is not an established market claim.*

---

## 4. Goals, Non-Goals and Success Measures

### Goals
1. Help a first-time creator produce a usable explainer without understanding video production.
2. Produce motion that **communicates the explanation**, not motion that only decorates the narration.
3. Keep narration, animation cues and captions on **one consistent timeline**.
4. Let creators correct content through **plain-language requests**.
5. Preserve drafts and previous successful outputs through interruptions and failed operations.
6. Publish **only the exact version and destination the user approved**.

### Explicit non-goals (V1)
- General-purpose cinematic text-to-video generation or complex character animation
- AI avatars, face animation or voice cloning
- Full timeline editing or frame-by-frame editing tools
- Branding controls or custom theme editors
- User billing, subscriptions, credit purchases and user-facing provider costs
- Team workspaces, client approvals, collaboration or roles beyond an owner
- **Bulk generation, recurring topic generation, or unattended creation-to-publishing** (series/autopilot → later)
- Platforms other than Instagram Reels, including Instagram Stories and carousels
- Video uploads, image uploads, PDF ingestion, website scraping or automatic research from the open web
- Guaranteed factual correctness, reach, engagement or educational outcomes
- Multilingual dubbing (one video in several languages) and languages beyond English, Hindi and Hinglish

### Proposed beta success measures
| Measure | Target |
|---|---|
| First-time creators who complete a video without help | > 70% |
| Generated videos that are downloaded or published | > 60% |
| Storyboards accepted with ≤ 2 revisions | > 60% |
| Render success rate (after automatic retries) | > 97% |
| Median time from idea to finished video | < 5 minutes |
| Creators who make a 2nd video within 7 days | > 40% |
| Average provider cost per video | Tracked internally; stays under the spend ceiling |

---

## 5. V1 Features

| # | Feature | V1 scope |
|---|---|---|
| 1 | Account and project library | Sign in, create projects, resume drafts, view previous videos |
| 2 | AI idea planning | Enter a topic, paste notes, or brainstorm with AI |
| 3 | Combined script and storyboard | Scene-by-scene narration and visual plan on one review screen |
| 4 | Motion-graphics generation | Animated text, shapes, icons, illustrations and diagrams from 8 motion patterns |
| 5 | AI voiceover and synchronization | Narration timed to the concepts being explained |
| 6 | Automatic captions | Readable, synchronized and editable |
| 7 | Conversational revisions | Plain-language changes to the whole storyboard/video or a specific scene |
| 8 | Video preview and export | Preview; download vertical 1080p MP4 |
| 9 | Instagram connection and publishing | Connect an eligible account; publish an approved video now or schedule it |
| 10 | Reliable generation and autosave | Autosave, generation status, retries, recovery from failures |
| 11 | Language choice | English (default), Hindi, Hinglish |

---

## 6. User Flows

### 6.0 Project states

```
draft ─► planning ─► storyboard_ready ─► [creator approves storyboard] ─► generating
                       ▲     │                                               │
                       │  revision                                           ▼
                       └─────┘                    video_ready ◄── (failed → retry)
                                                       │  ▲
                                          revision ────┘  │ (new version)
                                                       │
                                     [creator approves video + destination]
                                                       ▼
                                       scheduled ─► publishing ─► published
                                                       └──────► publish_failed (retry)
```

Each storyboard and each render is a **numbered version**. Earlier successful versions are never deleted by a failed operation.

### 6.1 Step ① Idea
- One text box: *"What do you want to explain?"*. It also accepts **pasted notes** (up to ~5,000 characters).
- **✨ Brainstorm with AI**: the creator types a broad subject, and the AI suggests several focused video ideas with hooks. One tap selects one.
- **Language** chip: English (default) · हिंदी Hindi · Hinglish.
- **Voice** chip: 👩 Female (default) · 👨 Male, each with a ▶ short preview sample in the selected language.
- Primary button: **Create storyboard**.

### 6.2 Step ② Review storyboard (script + storyboard combined)
- Scene cards in order. Each card shows the **narration** (inline editable), the **visual plan** in plain words, and the **motion pattern** badge (e.g. Process flow).
- Estimated total duration (e.g. "≈ 72s").
- **Revision chat**: whole storyboard ("make it shorter", "simpler for beginners") or one scene ("scene 3: show this as a comparison").
- Each revision creates a new storyboard version. **Undo** returns to the previous version.
- Primary button: **Approve & generate video**. This is approval #1 (the story).

### 6.3 Step ③ Generate and review video
- Progress steps: *Recording narration → Timing animations → Adding captions → Rendering*.
- The creator can leave; work continues in the background and is autosaved.
- Preview player when done.
- **Caption correction**: fix caption text (e.g. a technical term) without changing the narration audio.
- **Revision chat** on the video. This produces a new storyboard version and a new render; only changed scenes regenerate narration where possible.
- Buttons: **Continue to publish** (primary), **Download MP4**.

### 6.4 Step ④ Publish
- **Download MP4** is always available.
- **Connect Instagram** (first time): Meta's authorization screen → the creator authorizes an eligible Instagram **professional** account (no linked Facebook Page needed) → the app shows the connected account. Users never paste tokens.
- AI-suggested caption and hashtags (editable).
- The creator sees the **exact video version + destination account**, then clicks **Publish now** or **Schedule** (date/time in their timezone). This is approval #2.
- Success screen with the Instagram post link, or a clear failure with **Retry**.

---

## 7. Approval Rule (Hard Requirement)

> **Nothing is ever published to Instagram without an explicit approval action by the creator, for the exact video version and destination account shown.**

- Approval stores: `render_version`, `instagram_account_id`, `approved_at`, `approved_by`.
- Any revision, caption edit, re-render or destination change **invalidates the approval**. A scheduled post is moved back to "needs approval" and the creator is notified.
- The publish job **re-checks the approval** right before publishing. If the version or destination doesn't match, it does not publish.
- Publishing is **idempotent**: a retry can never create a duplicate post.
- Every publish attempt is logged.

---

## 8. Animation Engine

Remotion is a rendering framework. **It does not understand or animate a topic on its own.** We build the visual components and the logic that turns AI scene plans into animations. This layer decides whether videos look useful and polished, so it gets most of the V1 effort.

### 8.1 The eight V1 motion patterns

| Pattern | Use | Example |
|---|---|---|
| **Title / hook** | Opening question or bold statement | "Why is the sky blue?" |
| **Labeled diagram** | Parts of a thing, with labels appearing in sync | Parts of a cell |
| **Process flow** | Cause → effect, cycles, pipelines, with arrows | Water cycle |
| **Comparison** | Side-by-side A vs B | Stocks vs mutual funds |
| **Timeline** | Events in order | History of the internet |
| **Chart** | Simple bar/line/pie with animated values | Population growth |
| **Step sequence** | Ordered steps revealed one by one | How to solve a quadratic |
| **Takeaway** | Closing summary / key lesson / CTA | "Remember: …" |

All patterns share **one polished default visual style**, using free, commercially licensed icons and simple illustrations. The library grows based on what creators actually ask for.

### 8.2 Scene plan (AI output, validated)

```json
{
  "title": "How Evaporation Works",
  "language": "en",
  "targetSeconds": 70,
  "scenes": [
    {
      "id": "s2",
      "pattern": "process_flow",
      "narration": "Water evaporates when heated, then rises as vapour.",
      "captionText": "Water evaporates when heated, then rises as vapour.",
      "visual": {
        "nodes": ["Water", "Heat", "Vapour"],
        "description": "Water particles speed up, then rise as the narration reaches 'evaporates'"
      },
      "cues": [
        { "word": "heated", "action": "highlight", "target": "Heat" },
        { "word": "evaporates", "action": "rise", "target": "Water" }
      ]
    }
  ]
}
```

- Generated with **Gemini structured outputs** against a strict schema. Only existing patterns and props are allowed.
- **Validated** before use. If a scene is invalid, it is retried once, then falls back to a simple key-text scene (never a broken video).

### 8.3 Synchronization pipeline
1. Gemini produces the script + scene plan.
2. After storyboard approval, ElevenLabs generates **narration with character-level timestamps**.
3. Characters are grouped into **words → readable caption phrases**, and each **cue word → exact time**.
4. The real narration length is measured and **pacing is adjusted** to stay within 60–90s (scene durations follow the narration; if the total is outside the range, the AI shortens or expands the script and asks the creator to re-approve).
5. Remotion renders narration, animations and captions on **one timeline** → MP4 → uploaded to R2.

---

## 9. Languages

| | English (default) | Hindi | Hinglish |
|---|---|---|---|
| Script written in | English | Hindi (Devanagari) | Hindi–English mix |
| Narration | Eleven Multilingual v2: 1 male + 1 female Indian English voice | Eleven Multilingual v2: 1 male + 1 female Hindi voice | Same Hindi male/female voices (no separate Hinglish voices) |
| Captions shown in | English | Devanagari | Roman script (Hinglish as typed on social media) |
| Font | Default style font | Font with full Devanagari support (e.g. Noto Sans Devanagari) | Default style font |

Rules:
- The language is chosen once per project (on the Idea step). Changing a project's language is not in V1: to make the video in another language, the creator creates a new project. Only the voice (Male/Female) can be switched on an existing project (decision #25).
- The **Indian accent comes mainly from the selected voice**, so voice and model are evaluated together for each language.
- **Voice (Male/Female)** can be changed on the storyboard screen before generating. Changing it after a video exists regenerates the narration for all scenes and creates a new render version (which resets any publish approval).
- If a configured voice becomes unavailable, the system falls back to the other configured voice of the same gender and language, or shows a clear error. It never silently switches gender.
- **Hinglish risk:** TTS may mispronounce Roman-script Hindi words. The scene plan may therefore store a separate `spokenText` (sent to TTS, e.g. Devanagari for Hindi words) and `captionText` (shown on screen, Roman). Captions are timed at **phrase level** by mapping phrases between the two. Phase 0 decides whether this is needed.
- Brainstorming, revisions and the Instagram caption follow the project language.

---

## 10. Video Specification

| Property | Value |
|---|---|
| Format | MP4 (H.264 + AAC) |
| Resolution / fps | 1080 × 1920 (9:16), 30 fps |
| Length | 60–90 s, chosen by AI from the topic |
| Visuals | Eight motion patterns, one default style |
| Narration | ElevenLabs, Male or Female voice (creator's choice) per language |
| Captions | Synchronized phrases, inside Instagram safe zones, editable |
| Music | None in V1 |

---

## 11. Functional Requirements

### 11.1 Access & accounts
- **Better Auth**, single sign-in method. During the private beta, sign-up is **restricted to approved (allow-listed) users**.
- **Every user is an independent creator:** a private dashboard, private projects and videos, and their own Instagram connection. Users never see each other's projects (no shared library, no team roles in V1).
- Project library: list of projects with status, last updated, thumbnail; open a draft at the step where it was left.

### 11.2 Generation (background workflows on Inngest)
Durable, step-based workflows. Each step retries independently, so completed (paid) steps are never repeated:

| Workflow | Steps |
|---|---|
| `plan-video` | Gemini → scene plan → validate → save storyboard version |
| `revise-storyboard` | Gemini (current plan + request) → validate → new version (diff of changed scenes) |
| `generate-video` | For each changed scene: ElevenLabs narration + timestamps (reuse unchanged) → build timeline → Remotion render (Vercel Sandbox) → upload MP4 + thumbnail to R2 → mark `video_ready` |
| `write-caption` | Gemini → Instagram caption + hashtags |
| `publish-post` | Check approval → create Reels container → wait until processed → publish → save permalink |
| `scheduled-publish` | Inngest scheduled run at `scheduledAt` → `publish-post` |
| `refresh-instagram-token` | Periodic refresh of long-lived tokens; notify the creator if refresh fails |

### 11.3 Instagram
- Meta **Instagram API with Instagram Login**, for professional (Business/Creator) accounts, with no Facebook Page required.
- One Meta developer app, configured once. During development, internal test accounts are used.
- **Meta App Review** is required before external users can connect.
- Video must be at a **public URL** (R2) when the container is created.

### 11.4 Internal abuse controls & spend ceilings (not shown as credits)
- Per-user limits: e.g. max projects/day, max revisions per project, max renders per project/day.
- Global daily provider-spend ceiling. When reached, new generations are paused with a friendly message.
- Every provider call is logged with provider, model, units and estimated cost.
- Input limits: notes ≤ ~5,000 chars; revision message ≤ 500 chars.
- Content moderation of prompts and scripts (Gemini safety settings + an explicit check).

---

## 12. Edge Cases and Failure Handling

| Situation | Expected behavior |
|---|---|
| Empty or very vague idea ("science") | Ask one clarifying question, or offer brainstorm suggestions; never generate garbage |
| Very long pasted notes | Accept up to the limit; the AI picks the single core concept for 60–90s and says what it left out |
| Topic needs more than 90s | AI narrows the scope and suggests splitting into follow-up videos |
| Unsafe / disallowed topic | Polite refusal with a reason; nothing generated |
| Gemini returns invalid JSON / unknown pattern | Retry once → fall back to the key-text scene for that scene only |
| Gemini rate-limited (free tier) | Queue and retry with backoff; show "busy, retrying" |
| ElevenLabs fails or quota exhausted | Retry with backoff → clear error + **Retry**; storyboard is preserved |
| Narration too long/short for 60–90s | Auto-adjust pacing; if still outside, propose a shortened/expanded script for re-approval |
| Render fails or times out | Retry automatically; the previous successful video version stays available |
| User closes tab mid-generation | Work continues; status is shown on return; notification when ready |
| Double-click on Generate / Publish | Idempotent: only one job, only one post |
| Revision while a render is running | Revision is queued, or the current render is cancelled with confirmation; never mixes versions |
| Revision request is ambiguous ("make it better") | AI asks a short follow-up or proposes a specific change for confirmation |
| Caption edit changes meaning heavily | Allowed, with a note that narration audio is unchanged; offer "regenerate narration too" |
| Hindi/Hinglish term mispronounced | Edit the spoken text for that scene and regenerate only that scene's narration |
| Instagram account not professional | Explain in one line how to switch to a Creator/Business account; download still works |
| Instagram token expired / revoked | Scheduled posts are paused, the creator is asked to reconnect, nothing is lost |
| Instagram container processing fails / times out | Retry; after max attempts → `publish_failed` with a reason and **Retry** |
| Instagram daily publishing limit reached | Post is delayed with a notice; never silently dropped |
| Video edited after scheduling | Approval reset; the post is moved to "needs approval"; the creator is notified |
| Scheduled time in the past / timezone confusion | Validate on schedule; times are shown in the creator's local timezone |
| Global spend ceiling reached | New generations paused with a friendly message; existing videos remain accessible |
| Two browser tabs editing the same project | Last-write detection via version number; the stale tab is told to refresh |

---

## 13. Tech Stack

| Layer | Choice |
|---|---|
| Web app & backend endpoints | **Next.js, TypeScript, Node.js runtime** |
| Authentication | **Better Auth** (restricted to approved users during beta) |
| Database | **MongoDB Atlas** |
| Video, audio & asset storage | **Cloudflare R2** |
| Web hosting | **Vercel** |
| Background workflows & scheduling | **Inngest** (durable, retryable steps) |
| Animation & rendering | **Remotion**, rendered in **Vercel Sandbox**, output uploaded to R2 |
| Planning, scripts, revisions, captions | **Google Gemini API** (structured outputs) |
| Narration | **ElevenLabs Eleven Multilingual v2** (`eleven_multilingual_v2`), its most stable option for longer generations; **Eleven v3** auditioned during testing |
| Captions & sync | ElevenLabs character timestamps + our own timeline logic |
| Instagram | **Meta Instagram API** (Instagram Login) |

Notes:
- **Hosting the website and rendering videos are separate workloads.** We start with Remotion in Vercel Sandbox for the prototype and **benchmark its rendering time and cost** before committing to it permanently.
- Voices are chosen by **listening to the same scripts** across voices and models, including technical terms, in each language.

---

## 14. Cost Plan: Free First

### Development & testing: target ₹0
| Service | Free option | Caution |
|---|---|---|
| Gemini | Rate-limited free tier | Free-tier content **may be used to improve Google products**; test with sample topics only |
| ElevenLabs | Free allowance | **Non-commercial and requires attribution**; fine for testing only |
| Remotion | Free for individuals / teams ≤ 3 | Company license ($0.01/render, $100/month minimum) only if the team grows beyond 3 |
| Vercel | Hobby plan | Hobby is meant for **personal, non-commercial** use |
| MongoDB Atlas | Free cluster | Small storage; enough for beta |
| Inngest | Free tier | Check run limits |
| Cloudflare R2 | Free tier (10 GB) | — |
| Better Auth | Open source | — |
| Meta Instagram API | Free | App Review needed for external users |

### Before real (commercial) users, expect to pay for:
- **ElevenLabs Starter** (~$6/month) for commercial rights
- **Vercel Pro**, if commercial use or Sandbox rendering exceeds Hobby limits
- **Gemini paid tier**, to keep real user content out of training and for higher limits
- Rendering compute (Vercel Sandbox usage), measured in the Phase 0 benchmark

*Verify all prices and limits on the providers' pages before launch.*

---

## 15. Data Model (MongoDB collections)

| Collection | Key fields |
|---|---|
| `users` / auth collections | Managed by Better Auth; plus `allowListed`, `timezone` |
| `projects` | `_id`, `ownerId`, `title`, `language` (`en`/`hi`/`hinglish`), `voiceGender` (`female`/`male`), `inputType` (`topic`/`notes`/`brainstorm`), `inputText`, `status`, `currentStoryboardVersion`, `currentRenderVersion`, `updatedAt` |
| `storyboards` | `_id`, `projectId`, `version`, `plan` (scene plan JSON), `source` (`ai`/`revision`/`user_edit`), `approvedAt` |
| `revisions` | `_id`, `projectId`, `scope` (`project`/`scene`), `sceneId`, `stage` (`storyboard`/`video`), `message`, `resultVersion`, `status` |
| `narrations` | `_id`, `projectId`, `sceneId`, `textHash`, `voiceId`, `model`, `audioKey`, `timestamps`, `durationMs` (reused when `textHash` is unchanged) |
| `renders` | `_id`, `projectId`, `version`, `storyboardVersion`, `status`, `mp4Key`, `thumbnailKey`, `durationMs`, `error`, `startedAt`, `finishedAt` |
| `captionEdits` | `_id`, `projectId`, `renderVersion`, `phraseIndex`, `text` |
| `instagramConnections` | `_id`, `userId`, `igUserId`, `username`, `accessToken` (encrypted), `expiresAt`, `status` |
| `posts` | `_id`, `projectId`, `renderVersion`, `connectionId`, `caption`, `scheduledAt`, `status`, `approval` {`renderVersion`, `connectionId`, `approvedAt`}, `igContainerId`, `igMediaId`, `permalink`, `attempts`, `error` |
| `providerUsage` | `_id`, `userId`, `projectId`, `provider`, `model`, `operation`, `units`, `estCost`, `createdAt` |
| `auditLogs` | `_id`, `userId`, `action`, `subject`, `data`, `createdAt` |

---

## 16. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Reliability | Durable workflows; idempotent publish; no lost drafts or previous outputs |
| Speed | Storyboard < 30 s; video render target a few minutes (benchmarked) |
| Usability | Mobile-friendly; one primary action per screen; plain-language errors |
| Security | Tokens encrypted; API keys server-side only; signed URLs for private assets; per-user authorization on every project |
| Privacy | No real user content sent to free tiers that train on content; privacy policy before public launch (India DPDP Act) |
| Accessibility | Readable caption size and contrast; Devanagari rendering verified |

---

## 17. Build Plan (phases, no fixed dates)

| Phase | Deliverable |
|---|---|
| **0. Prototype & benchmark** | Produce **three sample explainers** with Gemini + ElevenLabs + Remotion (English first, then one Hindi and one Hinglish). Evaluate explanation quality, animation relevance, caption readability, pronunciation and revision effort. Benchmark Vercel Sandbox render time/cost. Create the Meta developer app. |
| **1. Foundation** | Next.js + TypeScript project, Better Auth (allow-list), MongoDB Atlas, R2, Inngest, project library, autosave |
| **2. Idea → Storyboard** | Topic / notes / brainstorm, language choice, scene plan generation, combined review screen, revision chat, versions + undo |
| **3. Generate & review video** | Narration + timestamps, timeline builder, 8 motion patterns, captions + editing, render, preview, download, video revisions |
| **4. Publish** | Instagram Login connect, caption/hashtags, approval rule, publish now / schedule, token refresh; submit Meta App Review |
| **5. Private beta** | Abuse controls, spend ceilings, usage logging, edge-case polish, switch to commercial plans, invite beta users |

---

## 18. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Animations generic or irrelevant | Eight well-designed patterns; strict schema; grow based on real requests |
| Hindi/Hinglish pronunciation or caption issues | Test in Phase 0; separate spoken text and caption text; per-scene narration fix |
| Rendering slow or costly on Vercel Sandbox | Benchmark in Phase 0; alternative render host if needed |
| Free-tier limits and licensing | Free tiers for development only; switch before real users |
| Meta App Review delay | Create the app early; download fallback |
| Factual errors | Storyboard review + two approvals; no claim of guaranteed correctness |
| Instagram token expiry | Auto-refresh + reconnect prompts; scheduled posts paused, not lost |

---

## 19. Future Roadmap
- Branding (colors, font, logo); background music
- Billing (Razorpay, INR plans), credits
- Series / recurring topic generation with an approval queue
- More motion patterns and styles; voice choice for creators
- Regional languages (Tamil, Telugu, Marathi, Bengali…)
- AI images / AI video clips as premium; other platforms; analytics; teams

---

## 20. Our Differences from the Course PRD

| Area | Course PRD | ByteReel |
|---|---|---|
| Languages | English only | **English (default) + Hindi + Hinglish** |
| Voice | One default narrator; voice selection internal only | **Male / Female choice** per project (curated voices internally) |
| Users | Internal version; each team member is an independent creator with a private dashboard, projects, videos and own Instagram | Same model (private per user), for allow-listed beta creators; public SaaS later |
| Name | Shortlist: VideoExplain AI, VideoCraft AI (top two), VideoLesson AI, VideoSpark AI, ExplainVideo AI, VideoGenerator AI; product/domain check before finalizing **ByteReel** (by TechByte Chronicles), connected to the founder's channel |

Everything else follows the course plan, so our code stays in sync.

---

## 21. Decisions Log

| # | Decision | Date |
|---|---|---|
| 1 | Audience: educational creators, coaches and subject-matter experts | 2026-11-12 |
| 2 | Flow: Idea → Review storyboard → Generate and review video → Publish | 2026-11-12 |
| 3 | Two approvals: storyboard before render; exact video + destination before publish | 2026-11-12 |
| 4 | Visuals: Remotion motion graphics, 8 patterns, one default style; no AI images | 2026-11-12 |
| 5 | Tools: Gemini, ElevenLabs Multilingual v2, Remotion, Meta Instagram API | 2026-11-12 |
| 6 | Rev 3: stack = Next.js/TS, Better Auth, MongoDB Atlas, R2, Vercel, Inngest, Vercel Sandbox *(replaces Laravel plan)* | 2026-11-12 |
| 7 | Rev 3: languages = **English (launch default), Hindi, Hinglish** | 2026-11-12 |
| 8 | Rev 3: one default narrator per language; no creator voice/style setup *(superseded by #15)* | 2026-11-12 |
| 9 | Rev 3: no background music, branding, billing or series in V1; private beta with spend ceilings | 2026-11-12 |
| 10 | Rev 3: no image/video/PDF uploads in V1 | 2026-11-12 |
| 11 | Free tools for development; paid plans only for commercial launch | 2026-11-12 |
| 12 | Each user has a private dashboard, projects, videos and own Instagram connection (matches course) | 2026-11-12 |
| 13 | Product name: **ByteReel** (by TechByte Chronicles) *(replaces working name ReelPilot)*; domain check pending | 2026-11-12 |
| 14 | **PRD v1.0 finalized**; approved for build | 2026-11-12 |
| 15 | Voice: creator chooses **Male or Female** (default Female); one curated voice of each per language | 2026-11-12 |
| 16 | Build order (matches course): technical pipeline design → idea-to-MP4 prototype → evaluate 3 explainers (process, comparison, abstract) → system architecture → app. See `docs/PIPELINE_DESIGN.md` | 2026-11-12 |
| 17 | Pipeline design v1.0 aligned with the course design: hash-based plan approval, scene-level speech, deterministic compiler, local manifest/artifacts, P0–P4 milestones; Gemini baseline `gemini-3.8-flash`; Hindi/Hinglish added after the English slice | 2026-11-12 |
| 18 | Hinglish narration reuses the Hindi male/female voices; no separate Hinglish voice IDs (4 voices total) | 2026-11-12 |
| 19 | Prototype planner model: `gemini-3.6-flash` (3.8 and 3.7 Flash returned "high demand"/timeouts on the free tier on 2026-11-12). Array-length limits are not sent in the Gemini schema (3.6 rejects them) but are still validated by our code. Run state `plan-approved` added between `awaiting-approval` and `running` | 2026-11-12 |
| 20 | System design `docs/ARCHITECTURE.md` v1.1 approved: email+password login form, polling, no email in V1, no Gemini auto-fallback, presigned R2 URLs, no backups in V1, pre-recorded voice samples, 3 videos/user/day, one repo | 2026-11-12 |
| 21 | Voices are shown to creators only as "Female voice" / "Male voice"; voice artist names, voice IDs and provider names are never shown in the UI or sent to the frontend (backend configuration only) | 2026-11-12 |
| 22 | API style: REST under `/api/v1` (Next.js route handlers), documented in `docs/API.md` + `docs/openapi.yaml` (OpenAPI 3.1); Better Auth stays at `/api/auth/*` | 2026-11-12 |
| 23 | UI: "Ember Gold" brand (`docs/BRAND.md`) and all 16 desktop screens in Google Stitch approved by the founder | 2026-11-12 |
| 24 | Founder answers to API open questions: (a) caption fixes do **not** count toward the 3 videos/day quota; (b) if the AI can't build a valid storyboard after repair, the job fails with "Couldn't build a good storyboard, try rephrasing" + Try again (no key-text fallback scene); (c) if a voice is unavailable, show a clear error, never silently switch voices; (d) one Instagram account can be connected by only one ByteReel user (`igUserId` unique among active connections) | 2026-11-12 |
| 25 | Changing a project's language is not in V1; create a new project. Voice (female/male) can still be switched | 2026-11-13 |

## 22. Open Items (resolved during build, do not block it)
- Domain + trademark check for **ByteReel** (.com / .ai / .in / get… / try… variants); backups: ByteMotion, ByteKahaani
- Pick 1 male + 1 female ElevenLabs voice per language (6 voices total) after listening tests
- Whether Hinglish needs separate spoken/caption text (Phase 0 result)
- Vercel Sandbox render benchmark result → keep or change the render host
- Free, commercially licensed icon/illustration set
