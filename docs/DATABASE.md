# ByteReel — Database Design (MongoDB)

| | |
|---|---|
| **Version** | 1.2 · 2026-11-13 (code-review fixes; all open questions decided; account deletion = 30-day soft delete + anonymous log) |
| **Status** | Draft for founder review (feature F04). Nothing is created yet: this is a document only |
| **Sources** (priority order) | [`ARCHITECTURE.md`](ARCHITECTURE.md) §7, §8, §9, §20.5 · [`API.md`](API.md) · [`PRD.md`](../PRD.md) §15 (older short list, see §12.2) |
| **Companion** | [`API.md`](API.md): every endpoint that reads or writes these collections |
| **Reader** | The founder: knows JS/React/Laravel/MySQL, new to MongoDB |

**What this document answers:** *what* ByteReel stores, *where* it lives, and *why*. Every collection and field here comes from ARCHITECTURE §8 or API.md. Where those documents don't define something, this document says so in **Open questions (§12.3)** instead of guessing.

---

## Table of contents
1. MongoDB in 2 minutes (for a MySQL/Laravel developer)
2. Where your data lives
3. Collections at a glance
4. Every collection in detail
5. How the collections connect
6. Safety and privacy rules
7. Transactions (all-or-nothing changes)
8. Indexes summary
9. How big will it get?
10. Backups
11. What gets created when
12. Glossary, differences from PRD §15, open questions

---

## 1. MongoDB in 2 minutes

### 1.1 The same ideas, different names

| MySQL / Laravel | MongoDB | In ByteReel |
|---|---|---|
| Database | **Database** | One database for the app (§2.2) |
| Table | **Collection** | `projects`, `posts`, … |
| Row | **Document** | One project, one post |
| Column | **Field** | `title`, `state` |
| `id` (auto-increment number) | **`_id`** (an **ObjectId**, see 1.2) | `"67330d5e9f1e4b2a7c0d2a10"` |
| Foreign key (`user_id`) | **Reference**: the other document's `_id` stored in a field | `projects.ownerId` = the user's `_id` |
| `JOIN` | A second query (or `$lookup`). We mostly do two small queries | |
| JSON column | Normal: a field can hold a nested object or a list | A whole storyboard lives inside one `planVersions` document |
| Migration (`ALTER TABLE`) | Not needed to add a field. A small **setup script** creates indexes and validators (ARCHITECTURE §26.3, `packages/db/migrations`) | |
| Form Request validation | **Zod** schemas in our code (first check) + a **validator** in the database (last safety net, see 1.4) | |
| `DB::transaction(fn …)` | A **transaction** (see 1.6) | Approve, publish, delete account |

### 1.2 Documents and `_id`
A **document** is a JSON-like record. Atlas shows it like this:

```js
{
  _id: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  title: "How UPI payments work",
  input: { type: "topic", text: "How UPI payments work" },
  createdAt: ISODate("2026-11-12T05:00:00.000Z")
}
```

- **ObjectId**: a 24-character hex id. The app (not the database) creates it, so we know the id before saving. It is unique across the whole database and contains the time it was made. There is no 1, 2, 3 counter.
- **ISODate**: a date. ByteReel always stores dates in **UTC** and shows them in the user's timezone (default `Asia/Kolkata`).
- The examples in this document use this "Atlas view" style, with **fake data** only.

### 1.3 No fixed table shape
MySQL refuses a row that doesn't fit the table. MongoDB, by default, accepts any document. That's flexible, but it also means mistakes can slip in. We protect against that in two layers (1.4).

### 1.4 Validators (the database's own rules)
A **validator** is a rule attached to a collection, for example "`state` must be one of these 12 words" or "`ownerId` is required". MongoDB rejects a write that breaks the rule. Our code checks everything with **Zod** first: that is the real check, and the **Rules** under each collection describe what our code enforces. The database validator is kept **minimal** (Q9): on every collection that belongs to a user, it only requires `ownerId` (an ObjectId) and `schemaVersion` (except the short-lived helper records `idempotencyKeys` and `usageCounters`, which only require `ownerId`). That one rule catches the worst bug (a document with no owner, which could leak between users) without making every future change a two-place edit. Better Auth's own collections get no validator.

### 1.5 Indexes
An **index** works the same as in MySQL: a sorted lookup list that makes a search fast. A **unique** index also forbids duplicates ("one account per email"). Two kinds you may not have used:
- **Partial index**: applies only to some documents ("unique `igUserId`, but only among *active* connections").
- **TTL index** (time to live): MongoDB deletes documents automatically after a time ("forget idempotency keys after 24 hours"). Four things to know:
  - The clean-up runs in the background **about every 60 seconds** and can fall behind when the server is busy, so an expired document may still be there for a minute or more.
  - A TTL index works on **one date field** only.
  - A document whose TTL field is **missing or not a date** is **never** deleted.
  - Because of the delay, **our code still checks the expiry itself** ("is `expiresAt` in the past?") and treats an expired document as gone. TTL is only the tidy-up.

### 1.6 Transactions
A **transaction** groups several writes so they **all happen or none happen**, like `DB::transaction()` in Laravel. Example: approving a storyboard must save the approval *and* create the video job *and* update the project. If one fails, all are undone. A change to **one** document is always all-or-nothing on its own; transactions are for changes to **several** documents. Full list in §7.

### 1.7 Two conventions used everywhere (ARCHITECTURE §8)
- Every document that belongs to a user has **`ownerId`** (the user's `_id`). Every query filters by it (§6.3).
- Documents carry **`schemaVersion`** (starts at `1`), so a future change of shape can be detected and fixed by a data migration. **Versioned documents are insert-only**: a new version is a new document; old ones are never edited.

---

## 2. Where your data lives

### 2.1 MongoDB Atlas, in your own account
- **Service:** MongoDB Atlas, the company's cloud database.
- **Plan:** the free **M0** cluster: **512 MB** of storage, no automatic backups (§10). A *cluster* is the database server Atlas runs for us; M0 is the free size.
- **Owner:** **your own Atlas account**, created together in **F05**. You log in to Atlas and see every record yourself. No hidden or local database is used by the app.
- **Region:** the database must sit **next to the server that talks to it**, not next to the users: every page load makes several database calls from the Vercel function, and each call travels between the two. So we pick the **Atlas region and the Vercel function region together**. Recommended: **Atlas Mumbai (AWS `ap-south-1`) + Vercel functions in Mumbai (`bom1`)**, if Atlas offers Mumbai for free clusters (otherwise the nearest free region, with Vercel set to match). **Founder decision (2026-11-13): Mumbai for both** (the founder is in Pune). Set up in **F05**; the Vercel side is set again in F38.
- **Connection:** the app connects with a connection string (`MONGODB_URI`) that contains a database user and password created in F05. The connection is encrypted (TLS). Atlas also has a network access list (which computers may connect), set up in F05.

### 2.2 Database name
- ARCHITECTURE only names the setting (`MONGODB_DB`, §26.2), not its value. **F05 uses `bytereel`**, so this document uses **`bytereel`**.
- Production gets its own free cluster in a second Atlas project at F38 (**Q1**).

### 2.3 Local development uses the Atlas dev database
- When you run the app on your computer, it connects to the **same Atlas dev database** (`bytereel` on your free M0), through `MONGODB_URI` in your `.env`. No MongoDB is installed on your computer.
- Why not a local Docker MongoDB: a single local MongoDB server (a "standalone" `mongod`) **can't run transactions**, and ByteReel needs them (§7). Making a local one that can is extra setup for no gain. One database is also simplest: what you see in Atlas is exactly what the app wrote.
- Automated tests may still use a throw-away in-memory MongoDB that runs as a replica set (ARCHITECTURE §26.4); that is for tests only, never for running the app.

### 2.4 What is NOT in MongoDB

| What | Where it lives | What MongoDB keeps |
|---|---|---|
| Videos (`output.mp4`), narration audio (`audio.mp3`), thumbnails, preview frames, timeline/captions/alignment JSON files | **Cloudflare R2**, a private file store in your own account (set up in F22), bucket `bytereel-dev` / `bytereel-prod` (ARCHITECTURE §9) | Only the **file key** (its path), e.g. `users/<ownerId>/projects/<projectId>/renders/<renderId>/output.mp4`, plus its size and SHA-256 hash |
| Secrets: API keys (Gemini, ElevenLabs, Meta), `BETTER_AUTH_SECRET`, the token encryption keys | **Environment variables** (`.env` locally, Vercel settings in production). Never in the database, never in git | Nothing |
| Pre-recorded voice samples | Static files in `public/voices/` (decision D7) | Nothing |
| Brainstorm ideas and AI caption suggestions | Not stored (only shown to the creator) | Only what the creator picks: `project.input.brainstormChoice`, `post.caption` |

Why: video and audio files are large (a 75-second reel ≈ 18 MB). 512 MB of database would fill after about 25 videos. R2 has 10 GB free. Keeping files out keeps the database small and fast.

### 2.5 How you can look at the data
- **Atlas website:** Database → **Browse Collections** (the *Data Explorer*). You can open every collection and read every document. We tour it in F05.
- **MongoDB Compass:** MongoDB's free desktop app. Paste the same connection string and you get the same view, plus export to JSON/CSV (useful for the safety net in §10).
- Rule for both: **look, don't edit by hand**, unless we agree on it. Editing a document by hand can skip rules our code enforces (approvals, versions).

### 2.6 The big picture

```
  Creator's browser
        │  HTTPS (pages + /api/v1)
        ▼
  ┌───────────────────────────────┐     reads / writes      ┌──────────────────────────────┐
  │ Next.js app on Vercel         │ ──────────────────────► │ MongoDB Atlas (your account) │
  │ + background jobs (Inngest)   │                         │ database "bytereel"          │
  │                               │                         │ text records: users,         │
  │ secrets: environment          │                         │ projects, plans, jobs, posts │
  │ variables only                │                         └──────────────────────────────┘
  └───────────────┬───────────────┘
                  │ uploads files, creates short-lived links (presigned URLs)
                  ▼
  ┌───────────────────────────────┐
  │ Cloudflare R2 (your account)  │ ◄── the browser plays / downloads a video
  │ private bucket: mp4, mp3, jpg,│     with a link valid for 15 minutes
  │ json files                    │
  └───────────────────────────────┘
```

---

## 3. Collections at a glance

**Phase A2 (F05–F11) only needs the Better Auth collections (`user`, `session`, `account`) and the `allowlist`**, plus a small `rateLimits` collection for the sign-up/login limits (API.md §3.7) and a temporary `healthchecks` test in F06. Everything else arrives with the feature that needs it.

| § | Collection | What it holds (one line) | First used in | Phase |
|---|---|---|---|---|
| 4.1 | `user` | One document per person with an account (Better Auth) | F08 | A2 |
| 4.2 | `session` | One document per logged-in browser (Better Auth) | F08, F09 | A2 |
| 4.3 | `account` | The hashed password for each user (Better Auth) | F08 | A2 |
| 4.4 | `verification` | Admin-issued one-time password-reset links (Better Auth) | F35 | A6 |
| 4.5 | `allowlist` | Emails invited to the private beta | F07 | A2 |
| 4.6 | `rateLimits` | Short-lived counters for "too many attempts" | F08, F09 | A2 |
| 4.7 | `healthchecks` | Temporary: one test record to prove the connection; dropped at the end of F06 | F06 | A2 |
| 4.8 | `projects` | One document per video project (idea, state, pointers) | F12 | A3 |
| 4.9 | `jobs` | Background work and its progress (plan, revise, generate, caption, publish) | F15 | A3 |
| 4.10 | `planVersions` | Every version of a storyboard (never edited) | F15 | A3 |
| 4.11 | `revisions` | The creator's change requests ("make it shorter") | F18 | A3 |
| 4.12 | `storyboardApprovals` | Approval #1: "I approve this exact storyboard" | F20 | A3 |
| 4.13 | `idempotencyKeys` | Remembers button clicks for 24 h so a double-click does nothing twice | F12 | A3 |
| 4.14 | `usageCounters` | Daily/monthly counts for the limits (projects, videos, voice characters) | F12 (projects counted and limited), F27 (the other limits enforced) | A3 |
| 4.15 | `providerUsage` | Every paid AI/render call and its estimated cost | F14 | A3 |
| 4.16 | `auditLogs` | Who did what important thing, and when | F20 | A3 |
| 4.17 | `settings` | One global document: limits, ceilings, models, maintenance | F27, F36 | A4 |
| 4.18 | `speechArtifacts` | Recorded narration per scene (file keys + reuse key) | F23 | A4 |
| 4.19 | `renders` | Every rendered video version (file keys + checks) | F23 | A4 |
| 4.20 | `captionOverrides` | The creator's caption text fixes | F25 | A4 |
| 4.21 | `instagramConnections` | The user's connected Instagram account (token encrypted) | F28 | A5 |
| 4.22 | `posts` | Publish/schedule requests with approval #2 | F30 | A5 |
| 4.23 | `publishAttempts` | Log of every call to Instagram for a post | F30 | A5 |
| 4.24 | `notifications` | In-app messages ("Your video is ready") | F32 | A5 |
| 4.25 | `deletionRequests` | Account deletion and Meta data-deletion requests | F33, F37 | A6 |
| 4.26 | `deletionLog` | Permanent anonymous facts about each deleted account (no personal data) | F33 | A6 |

26 collections in total (25 permanent + 1 temporary). Sources: 4.1–4.5, 4.8–4.12, 4.15–4.23 are in ARCHITECTURE §8; 4.6, 4.13, 4.14, 4.24, 4.25 are named only in API.md, and 4.26 was added by the founder's account-deletion decision (6.7); their fields are defined in this document (Q2) and copied into ARCHITECTURE §8 (Q3); 4.7 is from the F06 feature file.

---

## 4. Every collection in detail

How to read each section: **Purpose** → **Example** (fake data) → **Fields** → **Rules** (validator highlights and behaviour) → **Indexes**. "Req" = required: **Yes**, **No** (may be missing or `null`), or **Auto** (set by the server or Better Auth).

### Accounts (phase A2, plus `verification` in A6)

**Better Auth fields (4.1–4.4).** The core fields below come from Better Auth's core schema (`user`, `session`, `account`, `verification`). **Confirmed in F08 (2026-11-13) against real documents written by Better Auth 1.7.14** (Q17). Two rules for all four collections:
- **All ids are ObjectId.** Better Auth calls its id `id`; in MongoDB it is stored as `_id`. Our code in `packages/db` converts between ObjectId (database) and string (API) in one place.
- **`userId` is stored as an ObjectId** in `session` and `account` (checked in F08), so lookups by the user's `_id` work directly and no conversion is needed. The adapter turns the string ids the API uses into ObjectIds itself. Only `account.accountId` is a **string** (the user's id as 24 hex characters).

#### 4.1 `user` (Better Auth)
**Purpose:** one document per person with a ByteReel account. Better Auth (our login library) creates and manages it; we add a few extra fields. Unlike a Laravel `users` table, **the password is not here**: it's in `account` (4.3).

```js
{
  _id: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  name: "Priya Sharma",
  email: "priya@example.com",
  emailVerified: false,
  image: null,
  role: "creator",
  status: "active",
  timezone: "Asia/Kolkata",
  defaultLanguage: "en",
  defaultVoiceGender: "female",
  failedLoginCount: 0,
  lockedUntil: null,
  lastLoginAt: ISODate("2026-11-12T04:30:00.000Z"),
  createdAt: ISODate("2026-11-12T04:30:00.000Z"),
  updatedAt: ISODate("2026-11-12T04:30:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` | ObjectId | The user's id. Used as `ownerId` everywhere else | Auto |
| `name` | string, 1–80 | Display name from the sign-up form | Yes |
| `email` | string, lowercased, ≤ 254 | Login email | Yes |
| `emailVerified` | boolean | Better Auth field. Always `false` in V1 (no emails are sent; the allow-list replaces verification) | Auto |
| `image` | string \| null | Better Auth field. Not used in V1 | No |
| `role` | `creator` \| `admin` | `admin` can open `/admin` | Auto |
| `status` | `active` \| `suspended` \| `deleting` | Only `active` users can log in. `deleting` = account deletion in progress (API A-3) | Auto |
| `timezone` | string (IANA name) | For "today" limits and schedule times. Default `Asia/Kolkata` | Auto |
| `defaultLanguage` | `en` \| `hi` \| `hinglish` | Pre-selected language on the Idea step | Auto |
| `defaultVoiceGender` | `female` \| `male` | Pre-selected voice | Auto |
| `failedLoginCount` | int | Wrong passwords in a row. Reset to 0 on success. Added with one atomic update (F09, `packages/db/src/login-guard.ts`) | Auto |
| `lockedUntil` | date \| null | Set to now + 15 min at every 10th wrong password in a row (10, 20, …) | No |
| `lastLoginAt` | date \| null | Last successful login | No |
| `createdAt`, `updatedAt` | date | Better Auth timestamps | Auto |

**Rules**
- Every extra field (`role`, `status`, `failedLoginCount`, `lockedUntil`, `lastLoginAt`, `timezone`, `defaultLanguage`, `defaultVoiceGender`) is **server-owned** (`input: false`): nobody can set it through sign-up or any auth endpoint (§6.4). New users always start as `creator` + `active`.
- `timezone`, `defaultLanguage`, `defaultVoiceGender` and `name` change only through `PATCH /api/v1/me` (B2).
- Sign-up only succeeds if the email is in `allowlist` (4.5).

**Confirmed in F08:** a new user has exactly the fields in the example except `image`, which is **missing** (not `null`) when no picture is given; `lockedUntil` and `lastLoginAt` are stored as `null` until F09 fills them. The extra fields are set by the server only: the sign-up hook forces `role: creator`, `status: active` and the defaults, and the sign-up endpoint refuses a body that contains any of them (400).

**Indexes (required, phase A2):** unique `email` = one account per email. **We create the Better Auth indexes ourselves** (`npm run db -- indexes --feature F08 --apply`). **Checked in F08:** Better Auth 1.7.14's MongoDB adapter creates **no** indexes for `user`, `session`, `account` or `verification` (it only creates indexes that a plugin declares at table level, and we use none). Full list in §8.

#### 4.2 `session` (Better Auth)
**Purpose:** one document per logged-in browser. Your browser holds a cookie; on every request the server looks up the matching session here. Logging out deletes the document.

```js
{
  _id: ObjectId("67330c1b9f1e4b2a7c0d1f01"),
  userId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  token: "Qm9vX2V4YW1wbGVfdG9rZW5fbm90X3JlYWw",   // fake
  expiresAt: ISODate("2026-12-12T04:30:00.000Z"),
  ipAddress: "203.0.113.24",
  userAgent: "Mozilla/5.0 (Linux; Android 14) …",
  createdAt: ISODate("2026-11-12T04:30:00.000Z"),
  updatedAt: ISODate("2026-11-12T04:30:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` (`id`) | ObjectId | Session id | Auto |
| `userId` | ObjectId → `user` | Whose session | Auto |
| `token` | string | The session token (32 characters). Your cookie holds this token plus a signature | Auto |
| `expiresAt` | date | 30 days after the last refresh (rolling: pushed forward at most once a day while you use the app) | Auto |
| `ipAddress`, `userAgent` | string? | The browser's IP address and browser name when the session was made (Better Auth reads the IP from the request headers; outside Vercel this is whatever the browser sent, so treat it as a hint, not proof) | No |
| `createdAt`, `updatedAt` | date | Timestamps | Auto |

**Rules**
- Deleted on logout; **all** of a user's sessions are deleted on password reset, suspension and account deletion. Changing your password deletes all your *other* sessions.
- The cookie cache is off: every request reads this collection, so a deleted session stops working immediately.

**Security notes (plain words)**
- Better Auth stores the session **token in plain text** (the cookie is the token + a signature). So anyone who can **read the database** could copy a token and act as that user until the session ends. That's why the database user/password (`MONGODB_URI`) must be protected like a master key: only in `.env` and Vercel settings, never shared, never in git. Same reasoning as the reset tokens in Q15.
- `ipAddress` and `userAgent` are **personal data** (DPDP). We keep them only as long as the session: the TTL index deletes expired sessions, and account deletion deletes all sessions.

**Indexes (required, phase A2, created by us, see 4.1):** unique `token` (every request finds its session by token); `userId` (log a user out everywhere); **TTL on `expiresAt`** with `expireAfterSeconds: 0` (MongoDB deletes a session soon after it expires, see §1.5).

#### 4.3 `account` (Better Auth)
**Purpose:** holds the **login credential** for a user. In V1 the only kind is email + password (`providerId: "credential"`), so each user has exactly one `account` document holding the **password hash**.

```js
{
  _id: ObjectId("67330c1a9f1e4b2a7c0d1e11"),
  accountId: "67330c1a9f1e4b2a7c0d1e01",
  providerId: "credential",
  userId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  password: "9f2c4e…:b71a0d…",   // scrypt hash, never the real password
  createdAt: ISODate("2026-11-12T04:30:00.000Z"),
  updatedAt: ISODate("2026-11-12T04:30:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` (`id`) | ObjectId | Account id | Auto |
| `accountId` | string | The id of the account at the provider. For `credential` it is the user's id | Auto |
| `providerId` | string | Always `credential` in V1 (no Google/social login, decision D1) | Auto |
| `userId` | ObjectId → `user` | Whose credential | Auto |
| `password` | string | **scrypt hash** of the password (§6.1): `<salt, 32 hex characters>:<key, 128 hex characters>` (seen in F08). Unreadable and irreversible | Auto |
| `accessToken`, `refreshToken`, `idToken`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, `scope` | | Better Auth fields for social logins. **Unused in V1** (missing or `null`) | No |
| `createdAt`, `updatedAt` | date | Timestamps | Auto |

**Rules:** written only by Better Auth (sign-up, change password, reset password). Never returned by any endpoint, never logged.

**Indexes (required, phase A2, created by us, see 4.1):** `{ userId: 1, providerId: 1 }`: find a user's password on login.

#### 4.4 `verification` (Better Auth)
**Purpose:** stores the **one-time password-reset links** an admin creates (there is no "forgot password" email in V1). Better Auth would normally use it for email verification too, but V1 sends no emails.

```js
{
  _id: ObjectId("67331a009f1e4b2a7c0d0b01"),
  identifier: "reset-password:x7Qp2sVb9LmN4cRt8wYz1aBcDeFgHiJk3LmNoPqRsTu",
  value: "67330c1a9f1e4b2a7c0d1e01",
  expiresAt: ISODate("2026-11-12T08:00:00.000Z"),
  createdAt: ISODate("2026-11-12T07:00:00.000Z"),
  updatedAt: ISODate("2026-11-12T07:00:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` (`id`) | ObjectId | Row id | Auto |
| `identifier` | string | `reset-password:<token>`. The token is 32 random bytes, shown once to the admin | Auto |
| `value` | string | The user's id the link belongs to | Auto |
| `expiresAt` | date | Created + **1 hour** | Auto |
| `createdAt`, `updatedAt` | date | Timestamps | Auto |

**Rules:** one live link per user (creating a new one deletes older unused ones); the row is deleted when used; after 1 hour it's invalid. The token is never logged or shown again (see Q15).

**Indexes (required, created by us, see 4.1):** `identifier` (find a reset link); **TTL on `expiresAt`** with `expireAfterSeconds: 0` (expired links delete themselves). Created in phase A2 with the other Better Auth indexes, although the collection is first used in F35.

#### 4.5 `allowlist`
**Purpose:** the invite list for the private beta. Sign-up is refused unless the email is here. Admins manage it (F34); in F07 you add your own email with a small command.

```js
{
  _id: ObjectId("67330b009f1e4b2a7c0d0a01"),
  email: "priya@example.com",
  note: "Physics teacher, Pune (beta wave 1)",
  invitedBy: ObjectId("67330a009f1e4b2a7c0d0001"),
  createdAt: ISODate("2026-11-12T03:00:00.000Z"),
  signedUpUserId: ObjectId("67330c1a9f1e4b2a7c0d1e01")
}
```
Your own entry, added in F07 before any admin exists, looks like this (Q14): `{ email: "<your email>", invitedBy: null, note: "added by setup command", … }`.

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` | ObjectId | Entry id | Auto |
| `email` | string, lowercased, ≤ 254 | The invited email | Yes |
| `note` | string ≤ 200 | Admin's note ("who is this?") | No |
| `invitedBy` | ObjectId? → `user` | The admin who added it. `null` for entries added by the setup command (F07, Q14) | Auto |
| `createdAt` | date | When it was added | Auto |
| `signedUpUserId` | ObjectId \| null → `user` | Set when this person signs up | No |

**Rules:** emails are lowercased before saving and before checking. Removing an entry stops future sign-ups only; an existing account is not affected (suspend it instead).

**Indexes:** unique `email` = an email can be invited only once.

#### 4.6 `rateLimits`
**Purpose:** short-lived counters behind "Too many attempts. Please wait 15 minutes". Each counter belongs to an IP address, a lowercased email or a user, and counts attempts in a fixed time window (API.md §3.7, e.g. 5 sign-in attempts per 15 minutes per IP and per email).

```js
{
  _id: "signin-email:sha256:3f9a…c21e:2026-11-12T04:30:00.000Z",
  count: 3,
  expiresAt: ISODate("2026-11-12T04:45:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` | string | `<rule>:sha256:<sha256(subject) as hex>:<windowStart>` (e.g. `signup-ip:sha256:3f9a…:2026-11-12T04:30:00.000Z`). `rule` names the limit (e.g. `signin-ip`, `signin-email`, `create-project`); `subject` is the IP address, the lowercased email or the user id; `windowStart` is when this fixed window began. **No raw IP or email is stored**, only the hash | Auto |
| `count` | int | Attempts in this window so far | Auto |
| `expiresAt` | date | End of the window | Auto |

**Rules**
- **One collection for all limits, including login and sign-up** (Q13). Each request does one atomic "add 1, create if missing" (`updateOne` with `$inc` and `upsert`) and compares `count` with the limit. Fixed windows: e.g. 5 sign-ins per 15 minutes.
- Better Auth's own rate limiter is **turned off**: by default it keeps its counters in server memory, which is useless on Vercel (every function instance has its own memory).
- Counters disappear when their window ends (TTL), and the code ignores a counter whose `expiresAt` has passed (§1.5).
- The account lockout (`failedLoginCount`, `lockedUntil`) is stored on `user`, not here.
- **Which IP (F08):** on Vercel the IP comes from `X-Forwarded-For`, which Vercel writes itself. Anywhere else (your computer, a plain `next start`) that header is whatever the caller sent, so it is ignored and all requests share one counter (`untrusted-network`); a made-up address never buys extra attempts. The code: `packages/db/src/rate-limit.ts` (counters) and `apps/web/lib/auth/handler.ts` (which IP).
- A plain hash of an IP address could be guessed back by trying every IP; we accept that because a counter lives at most one hour.

**Indexes:** TTL on `expiresAt` (`expireAfterSeconds: 0`). The `_id` itself is the lookup key, so no other index is needed.

#### 4.7 `healthchecks` (temporary)
**Purpose:** F06 writes **one test record** and reads it back to prove the app can talk to your Atlas database. Its fields are decided in F06 (something like a message and a time); it never holds user data. **At the end of F06**, after you have seen the record in Browse Collections, the record is deleted and the empty `healthchecks` collection is dropped (Q16). Later health checks don't write anything: they send MongoDB's `ping` command (`db.command({ ping: 1 })`).

### Projects and storyboard (phase A3)

#### 4.8 `projects`
**Purpose:** one document per video project. It holds the idea, the language and voice, the **state** (where the project is in the 4-step flow) and **pointers** to the current storyboard version, the approved version, the current video and the running job. Think of it as the project's "header row".

```js
{
  _id: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  schemaVersion: 1,
  title: "How UPI payments work",
  language: "en",
  voiceGender: "female",
  input: { type: "topic", text: "How UPI payments work — from scanning the QR code to money reaching the shop", brainstormChoice: null },
  state: "storyboard_ready",
  currentPlanVersionId: ObjectId("67330e019f1e4b2a7c0d2b02"),
  approvedPlanVersionId: null,
  currentRenderId: null,
  activeJobId: null,
  stateVersion: 4,
  planRequestCount: 2,
  lastError: null,
  createdAt: ISODate("2026-11-12T05:00:00.000Z"),
  updatedAt: ISODate("2026-11-12T05:12:40.000Z"),
  archivedAt: null
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId` | ObjectId | Project id; owner (the user) | Auto |
| `schemaVersion` | int | Document shape version (§1.7) | Auto |
| `title` | string 1–120 | Until the storyboard arrives: the picked brainstorm idea's title, otherwise the idea text (over 120 characters cut at a word break, ending with "…"); then the plan's topic; the creator can rename | Yes |
| `language` | `en` \| `hi` \| `hinglish` | Chosen on the Idea step. **Can't be changed later** (PRD decision #25: make a new project) | Yes |
| `voiceGender` | `female` \| `male` | Narrator voice; switchable on the storyboard | Yes |
| `input` | object | The idea: `type` (`topic` \| `notes` \| `brainstorm`), `text`, `brainstormChoice` (`{ subject, title, hook }` or null) | Yes |
| `state` | enum | `draft`, `planning`, `plan_failed`, `storyboard_ready`, `generating`, `generate_failed`, `video_ready`, `scheduled`, `publishing`, `published`, `publish_failed`, `archived` (ARCHITECTURE §7.2) | Yes |
| `currentPlanVersionId` | ObjectId? → `planVersions` | The storyboard version on screen | No |
| `approvedPlanVersionId` | ObjectId? → `planVersions` | The version with a valid approval #1; reset to null by any storyboard change | No |
| `currentRenderId` | ObjectId? → `renders` | "The video" (latest successful render) | No |
| `activeJobId` | ObjectId? → `jobs` | The one job running for this project, or null | No |
| `stateVersion` | int ≥ 1 | +1 on every change. Stops two browser tabs from overwriting each other (`STALE_VERSION`, §7.3) | Auto |
| `planRequestCount` | int 0–limit | How many of the **20 plan + revision requests** this project has used: 1 at creation (C2), +1 per accepted revision (D5) and per plan retry from an edited idea (E2). Increased in the same transaction, and only if still below the limit (Q7) | Auto |
| `lastError` | `{ code, message, at }`? | Plain-language error shown to the creator | No |
| `createdAt`, `updatedAt` | date | Timestamps | Auto |
| `archivedAt` | date? | When it was archived (soft delete, §6.6) | No |
| `stateBeforeArchive` | enum? | The state it had before archiving (API C5) | No |

**Rules**
- Idea text length: topic 3–300, notes 20–5,000, brainstorm 3–300 characters (after trimming and NFC). `brainstormChoice` only when `type = brainstorm`.
- **F12 (until F15):** a new project starts in state `draft` with `planRequestCount: 0` and no job; F15 makes C2 start in `planning` with the `plan` job and `planRequestCount: 1` (API.md C2 "Until F15"). Code: `packages/db/src/projects.ts`.
- At most **one active job** per project: `activeJobId` is set with a conditional update ("only if it is currently null").
- Every change needs the caller's `stateVersion`; a mismatch changes nothing.

**Indexes**
- `{ ownerId: 1, updatedAt: -1 }`: the "My videos" list, newest first.
- `{ ownerId: 1, state: 1 }`: the tabs (Drafts, Ready, Scheduled, Published).
- No index on `activeJobId`: an earlier version of ARCHITECTURE §8.3 listed a sparse one, but it isn't needed. A job already stores its `projectId`, so "which project does this job belong to?" is a lookup by `_id`.

#### 4.9 `jobs`
**Purpose:** one document per piece of **background work**: making a storyboard (`plan`), applying a change request (`revise`), making the video (`generate`), re-rendering after a caption fix (`caption`), or publishing (`publish`). It stores the progress you see on screen ("Recording narration · scene 3 of 6") and lets a failed job **resume** without paying for finished steps again. It replaces the prototype's `manifest.json`.

```js
{
  _id: ObjectId("67330f109f1e4b2a7c0d3c03"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  projectId: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  schemaVersion: 1,
  type: "generate",
  inputRef: { planVersionId: ObjectId("67330e019f1e4b2a7c0d2b02") },
  state: "running",
  attempt: 1,
  stages: [
    { name: "approve", status: "succeeded", startedAt: ISODate("2026-11-12T05:40:01.000Z"), endedAt: ISODate("2026-11-12T05:40:01.200Z"), attempts: 1, error: null },
    { name: "speech",  status: "running",   startedAt: ISODate("2026-11-12T05:40:01.300Z"), endedAt: null, attempts: 1, error: null }
    // … compile, render, validate (pending)
  ],
  progress: { stage: "speech", percent: 24, message: "Recording narration · scene 3 of 6" },
  error: null,
  needsInput: null,
  result: null,
  idempotencyKey: "gen:67330e019f1e4b2a7c0d2b02",
  inngestRunId: "01JCXJZ8Y6V5T4S3R2Q1P0N9M8",
  cancelRequestedAt: null,
  createdAt: ISODate("2026-11-12T05:40:00.000Z"),
  updatedAt: ISODate("2026-11-12T05:40:19.000Z"),
  startedAt: ISODate("2026-11-12T05:40:01.000Z"),
  finishedAt: null
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId`, `projectId` | ObjectId | Job id; owner; project | Auto |
| `type` | `plan` \| `revise` \| `generate` \| `caption` \| `publish` | What kind of work | Yes |
| `inputRef` | `{ planVersionId?, revisionId?, postId? }` | What the job works on | Yes |
| `state` | `queued` \| `running` \| `succeeded` \| `failed` \| `needs_input` \| `cancelled` | Overall status (ARCHITECTURE §7.3) | Yes |
| `attempt` | int ≥ 1 | +1 on each retry | Auto |
| `stages` | list of `{ name, status, startedAt, endedAt, attempts, error }` | One entry per step; status `pending` \| `running` \| `succeeded` \| `failed` \| `skipped` \| `cancelled` | Yes |
| `progress` | `{ stage, percent 0–100, message }` | What the progress bar shows | Yes |
| `error` | `{ code, message, retryable }`? | Why it failed; `retryable` → show **Retry** | No |
| `needsInput` | `{ reason, message, sceneId }`? | When the creator must change something (e.g. video longer than 90 s) | No |
| `result` | `{ planVersionId?, renderId?, revisionId?, postId? }`? | What the job produced | No |
| `idempotencyKey` | string, unique, **required** | Stops duplicate jobs from double-clicks. One format per job type (Q6): `plan:{projectId}:{inputHash}`, `rev:{revisionId}`, `gen:{planVersionId}`, `cap:{captionOverrideSetId}`, `pubjob:{postId}`. Also used as the Inngest event id | Yes |
| `inngestRunId` | string? | Link to the run in the Inngest dashboard (for debugging) | No |
| `cancelRequestedAt` | date? | Set when the creator presses Cancel; the job stops between steps | No |
| `createdAt`, `updatedAt`, `startedAt`, `finishedAt` | date | Timestamps | Auto |

**Rules:** every job **must** have an `idempotencyKey` (a missing key would count as `null` in the unique index, so only one such job could ever exist). Only one active job per project (`projects.activeJobId`). A retry keeps the same job, adds 1 to `attempt`, and skips finished stages (no repeated paid calls). Jobs never create approvals.

**Indexes**
- unique `idempotencyKey`: the same job can't be created twice.
- `{ projectId: 1, createdAt: -1 }`: a project's jobs, newest first.
- `{ state: 1, updatedAt: 1 }`: the "stuck job" sweeper finds jobs running with no update for 30 minutes.

#### 4.10 `planVersions` (insert-only)
**Purpose:** every version of a storyboard. The AI's first plan is version 1; every narration edit, voice switch or AI revision adds a **new** version. Old versions are never changed, which makes **Undo** safe and makes approvals trustworthy: an approval points to one exact, unchangeable version.

```js
{
  _id: ObjectId("67330e019f1e4b2a7c0d2b02"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  projectId: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  schemaVersion: 1,
  versionNumber: 2,
  parentVersionId: ObjectId("67330d5f9f1e4b2a7c0d2b01"),
  source: "ai_revision",
  plan: {
    schemaVersion: 1, topic: "How UPI payments work", language: "en", voicePreset: "indian-english-female",
    audience: "…", learningObjective: "…", sources: [], warnings: [],
    scenes: [ /* 3–10 scenes: narration, objects, events (API.md §11.2) */ ]
  },
  planHash: "sha256:5d7a0c9e1f3b4a6d8c2e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c",
  validation: { valid: true, issues: [], warnings: [] },
  stats: { sceneCount: 6, wordCount: 176, estimatedSeconds: 70.4 },
  plannerUsage: { model: "gemini-3.6-flash", promptTokens: 9100, outputTokens: 2600, thinkingTokens: 1800, attempts: 1 },
  createdAt: ISODate("2026-11-12T05:12:40.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId`, `projectId` | ObjectId | Version id; owner; project | Auto |
| `versionNumber` | int | 1, 2, 3… per project | Auto |
| `parentVersionId` | ObjectId? → `planVersions` | The version this one was made from (null for version 1) | No |
| `source` | `ai_plan` \| `ai_revision` \| `user_edit` \| `caption_edit` | Who made it. `caption_edit` is reserved, not used in V1 (API A-7) | Yes |
| `plan` | object | The full storyboard, exactly the code contract (PIPELINE_DESIGN §5, API.md §11.2) | Yes |
| `planHash` | string `sha256:…` | Fingerprint of the plan. Any change gives a different hash | Yes |
| `validation` | `{ valid, issues[], warnings[] }` | Result of the plan checks | Yes |
| `stats` | `{ sceneCount, wordCount, estimatedSeconds }` | Shown on the storyboard. Same names as the code (`PlanStats` in `packages/pipeline/src/planning/semantic-validation.ts`, Q4) | Yes |
| `plannerUsage` | `{ model, promptTokens, outputTokens, thinkingTokens, attempts }` | The AI call that made it (for AI-made versions) | No |
| `createdAt` | date | When it was made | Auto |

**Rules**
- **Insert-only.** Never updated, never deleted (except account deletion).
- A version is saved **even if it fails validation** (so no typing is lost); it just can't be approved until fixed.
- `plan.ownerId`, `plan.projectId`, `plan.versionId` are set by code, never by the AI.
- A copy of the plan is also written to R2 (`users/{ownerId}/projects/{projectId}/plans/{planVersionId}/plan.json`, ARCHITECTURE §9) for the render step; MongoDB is the record the app reads.

**Indexes**
- unique `{ projectId: 1, versionNumber: -1 }`: no two "version 3"s in one project; also lists versions newest first.
- `{ ownerId: 1, projectId: 1 }`: owner-scoped lookups.

#### 4.11 `revisions`
**Purpose:** the revision chat. One document per change request the creator types ("make it shorter", "explain scene 2 better"), with the AI's reply and which version it produced.

```js
{
  _id: ObjectId("67330e009f1e4b2a7c0d4d01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  projectId: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  schemaVersion: 1,
  stage: "storyboard",
  scope: "project",
  sceneId: null,
  message: "Make it shorter and simpler for college students",
  basePlanVersionId: ObjectId("67330d5f9f1e4b2a7c0d2b01"),
  resultPlanVersionId: ObjectId("67330e019f1e4b2a7c0d2b02"),
  status: "succeeded",
  assistantReply: "Shortened to 6 scenes (about 70 s) and simplified the bank steps.",
  diff: { changedSceneIds: ["scene-hook", "scene-flow"], addedSceneIds: [], removedSceneIds: ["scene-settlement"], narrationChanged: true },
  jobId: ObjectId("67330e009f1e4b2a7c0d3c02"),
  createdAt: ISODate("2026-11-12T05:11:58.000Z"),
  updatedAt: ISODate("2026-11-12T05:12:40.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId`, `projectId` | ObjectId | Revision id; owner; project | Auto |
| `stage` | `storyboard` \| `video` | Asked from step ② or step ③ | Yes |
| `scope` | `project` \| `scene` | Whole video or one scene | Yes |
| `sceneId` | string? | The scene, when `scope = scene` | No |
| `message` | string 3–500 | What the creator asked | Yes |
| `basePlanVersionId` | ObjectId → `planVersions` | The version it started from | Yes |
| `resultPlanVersionId` | ObjectId? → `planVersions` | The new version, on success | No |
| `status` | `pending` \| `succeeded` \| `failed` \| `rejected` | `rejected` = unclear or unsafe request; the AI asks a question instead | Yes |
| `assistantReply` | string? | The AI's short answer or follow-up question | No |
| `diff` | `{ changedSceneIds[], addedSceneIds[], removedSceneIds[], narrationChanged }`? | What changed (for highlighting) | No |
| `jobId` | ObjectId → `jobs` | The `revise` job doing the work | Yes |
| `createdAt`, `updatedAt` | date | Timestamps | Auto |

**Rules:** each accepted revision counts toward the **20 plan + revision requests per project** (with the first plan and each plan retry after an Edit idea). A revision can't change the project language.

**Indexes:** `{ projectId: 1, createdAt: -1 }`: the chat history, newest first.

#### 4.12 `storyboardApprovals` (insert-only)
**Purpose:** **approval #1**. Proof that the creator clicked "Approve & generate" on one exact storyboard version. The video job checks it before spending money on narration and rendering.

```js
{
  _id: ObjectId("67330f109f1e4b2a7c0d5e01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  projectId: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  schemaVersion: 1,
  planVersionId: ObjectId("67330e019f1e4b2a7c0d2b02"),
  planHash: "sha256:5d7a0c9e1f3b4a6d8c2e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c",
  approvedBy: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  approvedAt: ISODate("2026-11-12T05:40:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` | ObjectId | Approval id | Auto |
| `ownerId`, `projectId` | ObjectId | Owner; project | Auto |
| `planVersionId` | ObjectId → `planVersions` | The approved version | Yes |
| `planHash` | string | The approved version's fingerprint: binds the approval to the exact plan | Yes |
| `approvedBy` | ObjectId → `user` | Who approved (always the owner) | Yes |
| `approvedAt` | date | When | Yes |

**Rules:** created **only** by the signed-in creator through D8. Background jobs, admins and the AI can never create one. Any new storyboard version has no approval, so it must be approved again.

**Indexes:** unique `planVersionId` = a version can be approved only once (approving it again reuses the same approval).

#### 4.13 `idempotencyKeys`
**Purpose:** remembers recent important button clicks for **24 hours**. Each click sends a random key; if the same key arrives again (a double-click, a network retry), the server replays the first answer instead of creating a second project, job or post (API.md §6).

```js
{
  _id: ObjectId("67330d5e9f1e4b2a7c0d0c01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  key: "9b2f4c1e-7d3a-4e8b-a1c5-2f6d8e0b4a71",
  fingerprint: "sha256:0c4e…9a1f",
  status: "done",
  lockedUntil: null,
  responseStatus: 202,
  responseBody: { /* the original answer, replayed on a repeat */ },
  createdAt: ISODate("2026-11-12T05:00:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId` | ObjectId | Record id; whose click | Auto |
| `key` | string 8–128 | The `Idempotency-Key` header sent by the browser | Yes |
| `fingerprint` | string | `sha256` of method + path + body: proves the repeat is the same request | Yes |
| `status` | `in_progress` \| `done` | `in_progress` while the first request is still running | Yes |
| `lockedUntil` | date? | Only while `in_progress`: now + **~60 s**. If the first request crashed, the marker would block the key forever; after `lockedUntil` the marker counts as **abandoned** and the next request with the key may run it again | No |
| `lockId` | string? | Only while `in_progress`: a new random value for **every** check-in, also for a takeover of an abandoned marker. Saving the answer and releasing the record both require it, so a slow first request can neither overwrite nor delete the record of the request that took over (F12 review) | Auto |
| `responseStatus`, `responseBody` | int, object | The saved answer, once `done` | When done |
| `createdAt` | date | When the key was first seen | Auto |

**Rules:** scoped per user. A key reused with a different request body → `IDEMPOTENCY_KEY_REUSED`. A repeat while `in_progress` (and before `lockedUntil`) → `IDEMPOTENCY_IN_PROGRESS`. Server errors (5xx) are not saved (the record is removed, only by the request that owns it), so the client can retry.

**Abandoned lock (corrected in the F12 review).** After `lockedUntil` a repeat may take the marker over, while the first request may in fact still be running (e.g. a slow transaction). Two runs of the same click must then not both take effect:
- Actions that write in a transaction (C2 create project; later D5, D8, F4, H2 …) save their answer on the record **inside that transaction**, filtered on their own `lockId`. If nothing matches, another request owns the click now: the action throws and the **whole transaction rolls back** (no project, no counted quota). C2 then answers `409 IDEMPOTENCY_IN_PROGRESS`; a retry gets the winner's saved answer.
- The domain keys (`jobs.idempotencyKey`, `posts.publishKey`, unique approvals, API.md §6 "Second layer") stay as a further guard for jobs and posts. They would **not** stop a second project, which is why C2 relies on the in-transaction check above.
- Code: `packages/db/src/idempotency.ts`.

**Indexes:** unique `{ ownerId: 1, key: 1 }`; TTL on `createdAt` with `expireAfterSeconds: 86400` (24 hours).

#### 4.14 `usageCounters`
**Purpose:** counts for the daily limits shown as "Videos today: 1 of 3". API.md mentions it twice: creating a project adds 1 to the projects counter (C2) and approving a storyboard adds 1 to the videos counter (D8).

**Limits it supports (API.md §10.1):** 5 projects per user per day, 3 videos (accepted `generate` jobs) per user per day, reset at midnight in the user's timezone. **Caption fixes never count** toward the 3/day. Retries and reusing an existing video don't count either.

**In plain words: the voice limit is the one that really matters.** Each user may use **3,000 narration characters per month** (ARCHITECTURE §23: "ElevenLabs characters per user per month | 3,000"; API.md §10.1: "ElevenLabs characters per user per month | 3,000 | Reserved before each speech call"). One video needs about **1,000 characters** of narration (ARCHITECTURE §25.4: "ElevenLabs (~1,000 characters)"). So each user can make **about 3 voiced videos per month**, and the "3 videos per day" limit will rarely be reached. Re-using recorded narration (§4.18) and caption fixes don't use characters; re-recording after a narration edit uses characters only for the changed scenes.

```js
{
  _id: ObjectId("67330d5e9f1e4b2a7c0d0d01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  kind: "videos",
  period: "2026-11-13",
  count: 1,
  expiresAt: ISODate("2026-11-21T18:30:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId` | ObjectId | Record id; whose count | Auto |
| `kind` | `videos` \| `projects` \| `voiceChars` \| `brainstorms` | What is counted (`brainstorms`: C7 requests, F14) | Yes |
| `period` | string | The day (`"2026-11-13"`) for `videos`/`projects`/`brainstorms`, the month (`"2026-11"`) for `voiceChars`, **in the user's timezone** | Yes |
| `count` | int | Used so far in this period (characters for `voiceChars`) | Yes |
| `expiresAt` | date | A week after the period ends; old counters then delete themselves | Yes |

**Rules (Q7)**
- Increased inside the same transaction as the action (C2, D8; `voiceChars` when characters are reserved), with one atomic "add, create if missing" on `{ ownerId, kind, period }`, and only if the result stays within the limit.
- **Counting starts in F12** (projects) and grows with each feature. The **projects** limit (5 per day) is also **enforced since F12** (C2 answers `429 QUOTA_EXCEEDED` and saves nothing), because the check costs nothing and protects the paid storyboard calls coming in F15. The other limits are enforced as their actions arrive (videos: F20/F27; voice characters: F23/F27).
- **`brainstorms` (F14, 30 per day):** C7 saves nothing else, so there is no transaction: one atomic update "add 1 where `count < 30`, create the counter if missing" (`packages/db/src/brainstorm.ts`, `countBrainstormWithinLimit`). At the limit the filter matches nothing and the insert hits the unique index (E11000) = full, nothing added; two first brainstorms of the day at the same moment can also hit E11000, and the retry then adds to the new counter. Counted before the AI call; a busy or refused answer still counts. The 10 per hour are a `rateLimits` counter (4.6).
- Code: `packages/db/src/usage-counters.ts` (`addUsageWithinLimit` adds 1, and if that goes over the limit the caller throws so the transaction rolls the +1 back; two clicks at the same moment write the same counter, so MongoDB makes one of them wait and retry, and it sees the new count).
- The **20 plan + revision requests per project** are not here: they are `projects.planRequestCount` (4.8), because they never reset.

**Indexes:** unique `{ ownerId: 1, kind: 1, period: 1 }`; TTL on `expiresAt` (`expireAfterSeconds: 0`).
**Warning:** the daily limits (projects and brainstorms) rely on the unique index. Without it, two first requests of the day can create two counters and each count from 0, so the limit can be passed. Apply the F12 indexes before using the app (`npm run db -- indexes --feature F12 --apply`).

#### 4.15 `providerUsage`
**Purpose:** a record of every paid call: Gemini (AI planner), ElevenLabs (voice), Vercel Sandbox (rendering), Meta (free, logged for completeness). It feeds the spend ceilings and the admin "spend" page, and later tells us the real cost per video.

```js
{
  _id: ObjectId("673310019f1e4b2a7c0d9101"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  projectId: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  jobId: ObjectId("67330f109f1e4b2a7c0d3c03"),
  schemaVersion: 1,
  provider: "elevenlabs",
  operation: "tts_with_timestamps",
  model: "eleven_multilingual_v2",
  units: { promptTokens: 0, outputTokens: 0, characters: 214, renderSeconds: 0 },
  estCostInr: 1.9,
  status: "final",
  outcome: "ok",
  latencyMs: 4210,
  at: ISODate("2026-11-12T05:40:20.000Z")
}
```

A C7 brainstorm call (F14) has no `projectId`/`jobId`:
```js
{ _id: ObjectId("…"), ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"), schemaVersion: 1, provider: "gemini", operation: "brainstorm", model: "gemini-3.1-flash-lite",
  units: { promptTokens: 559, outputTokens: 537, characters: 0, renderSeconds: 0 }, estCostInr: 0, status: "final", outcome: "ok", latencyMs: 3254, at: ISODate("2026-11-13T10:00:00.000Z") }
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId` | ObjectId | Record id; whose usage | Auto |
| `projectId`, `jobId` | ObjectId? | Which project/job caused it. **Not set** (field absent) when there is none, e.g. brainstorm | No |
| `provider` | `gemini` \| `elevenlabs` \| `vercel-sandbox` \| `meta` | Which service | Yes |
| `operation`, `model` | string | What was called | Yes |
| `units` | `{ promptTokens, outputTokens, characters, renderSeconds }` | How much was used. Gemini `outputTokens` = answer + thinking tokens (both are billed as output) | Yes |
| `estCostInr` | number | Estimated cost in rupees. **Rule (F14): what we actually pay, so `0` while on Gemini's free tier**; the tokens are always stored, so a paid-tier price can be applied later (price table with the spend ceilings, F27) | Yes |
| `status` | `reserved` \| `final` \| `failed` | `reserved` = written before the call with the estimate; `final` = the call finished, real units filled in; `failed` = the call failed (kept with the units the provider still billed, usually 0) | Yes |
| `outcome` | string? | How the call ended (null while `reserved`). Brainstorm: `ok`, `invalid_output` (answer failed our check), `unsuitable` (model said no safe video), `rejected` (safety block), `busy`, `timeout`, `error` (F14) | Yes (null while reserved) |
| `latencyMs` | int? | From sending the request to its end (null while `reserved`) (F14) | Yes (null while reserved) |
| `at` | date | When | Yes |

**Rules:** written **before** the call (`status: reserved`) and finalized after (`final` or `failed`), so a crash can't hide spending: a `reserved` row still counts toward the ceilings. **One row per provider request**: each retry and each repair is its own row. **Never stores what the creator typed** (no subject, prompt or answer text). Kept 12 months (ARCHITECTURE §22; see Q10 for account deletion). **TODO F27** (spend ceilings): a row left `reserved` (the server stopped mid-call) counts toward the ceilings forever; F27 adds a cleanup that marks `reserved` rows older than e.g. 15 minutes as `failed` (outcome `abandoned`), keeping their estimate. **Created in F14** (C7 brainstorm calls; `packages/db/src/provider-usage.ts`).

**Indexes:** `{ at: -1 }` (totals by time), `{ ownerId: 1, at: -1 }` (one user's usage), `{ provider: 1, at: -1 }` (per service).

#### 4.16 `auditLogs`
**Purpose:** a short history of **important actions**: storyboard approved, post approved/published, Instagram connected/disconnected, password reset link created, admin actions, account deleted. Useful for "who did this and when?" questions.

```js
{
  _id: ObjectId("673310209f1e4b2a7c0d9201"),
  schemaVersion: 1,
  actorId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  action: "storyboard.approved",
  subject: { type: "planVersion", id: ObjectId("67330e019f1e4b2a7c0d2b02") },
  data: { projectId: ObjectId("67330d5e9f1e4b2a7c0d2a10") },
  at: ISODate("2026-11-12T05:40:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` | ObjectId | Entry id | Auto |
| `actorId` | ObjectId → `user` | Who did it | Yes |
| `action` | string | e.g. `storyboard.approved`, `post.published`, `instagram.connected`, `account.deleted` | Yes |
| `subject` | `{ type, id }` | What it was done to | Yes |
| `data` | object | Extra details, **redacted** (no tokens, passwords or secrets). Ids inside it are stored as ObjectId, like everywhere else | No |
| `at` | date | When | Yes |

**Rules:** append-only. No automatic expiry in V1. On account deletion the entries are **anonymized**, not deleted (§6.7).

**Indexes:** none in V1 (Q8). Nothing on screen searches it yet; add one when the admin page needs it.

#### 4.17 `settings` (one global document)
**Purpose:** the admin's control panel values: limits, spend ceilings, AI models, enabled voices and a maintenance switch. There is exactly **one** document. The app caches it for 60 seconds.

```js
{
  _id: "global",
  version: 3,
  maintenance: { active: false, message: null },
  limits: { videosPerUserPerDay: 3, projectsPerUserPerDay: 5, planRequestsPerProject: 20, voiceCharactersPerUserPerMonth: 3000 },
  ceilings: { elevenLabsCharactersPerMonth: 9000, geminiRequestsPerDay: 400, sandboxRenderMinutesPerDay: 240, spendInrPerDay: 1000 },
  models: { planner: "gemini-3.6-flash", speech: "eleven_multilingual_v2" },
  voices: { enabledPresets: ["indian-english-male", "indian-english-female", "hindi-male", "hindi-female", "hinglish-male", "hinglish-female"] },
  updatedAt: ISODate("2026-11-12T03:00:00.000Z"),
  updatedBy: ObjectId("67330a009f1e4b2a7c0d0001")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` | string, always `"global"` | Fixed id: the app always reads `{ _id: "global" }`, so there can never be a second settings document | Auto |
| `version` | int | +1 on every save; two admins can't overwrite each other | Auto |
| `maintenance` | `{ active, message ≤ 300 }` | Pauses all changes (reads still work) | Yes |
| `limits` | object | Per-user limits (ranges in API.md I12) | Yes |
| `ceilings` | object | Global monthly/daily ceilings | Yes |
| `models` | `{ planner, speech }` | Which AI models to use | Yes |
| `voices.enabledPresets` | list (not empty) | Which voice presets creators can pick | Yes |
| `updatedAt`, `updatedBy` | date, ObjectId | Last change and by which admin | Auto |

**Rules:** only admins change it (I12); the change is audit-logged. Never holds API keys (those are environment variables).

**Indexes:** none needed (one document).

### Video (phase A4)

#### 4.18 `speechArtifacts` (reusable, per owner)
**Purpose:** one document per **recorded narration clip** (one scene, one voice). The audio file is in R2; this document holds its keys and a **reuse key** (`cacheKey`). If the same text is recorded with the same voice again, the existing clip is reused, so we don't pay ElevenLabs twice.

```js
{
  _id: ObjectId("67330f2a9f1e4b2a7c0d6a01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  schemaVersion: 1,
  cacheKey: "sha256:4b1f…e90a",
  sceneId: "scene-flow",
  firstProjectId: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  voiceId: "<voice id from server config>",
  model: "eleven_multilingual_v2",
  settings: { /* voice settings used for the call */ },
  audioKey: "users/67330c1a9f1e4b2a7c0d1e01/speech/4b1f…e90a/audio.mp3",
  alignmentKey: "users/67330c1a9f1e4b2a7c0d1e01/speech/4b1f…e90a/alignment.json",
  normalizedAlignmentKey: "users/67330c1a9f1e4b2a7c0d1e01/speech/4b1f…e90a/alignment.normalized.json",
  durationMs: 9420,
  characters: 214,
  status: "ready",
  createdAt: ISODate("2026-11-12T05:40:20.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId` | ObjectId | Clip id; owner | Auto |
| `cacheKey` | string | Hash of narration + pronunciation mapping + voice + model + settings + format + seed | Yes |
| `sceneId`, `firstProjectId` | string, ObjectId | Where it was first recorded | Yes |
| `voiceId`, `model`, `settings` | | The exact voice setup. The voice id is never sent to the browser | Yes |
| `audioKey`, `alignmentKey`, `normalizedAlignmentKey` | string | R2 file keys: audio and word timings | Yes |
| `durationMs`, `characters` | int | Clip length; characters billed | Yes |
| `status` | `pending` \| `ready` \| `failed` | Recording state | Yes |
| `createdAt` | date | When | Auto |

**Rules**
- **Reuse never crosses owners**: Priya's clip is never used in another user's video, even with identical text.
- A **retry after a failed recording updates the same document** (`status: failed` → `pending` → `ready`) instead of adding a new one: the unique `{ ownerId, cacheKey }` index allows only one document per recording setup.

**Indexes:** unique `{ ownerId, cacheKey }`: one clip per owner per exact recording setup.

#### 4.19 `renders`
**Purpose:** one document per **video version**. The MP4, thumbnail and timing files are in R2; this document holds their keys, which storyboard version and narration clips were used, the automatic quality checks, and the MP4's fingerprint (`mp4Sha256`) that approval #2 is bound to. Earlier successful versions are never deleted.

```js
{
  _id: ObjectId("67330f109f1e4b2a7c0d6f01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  projectId: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  schemaVersion: 1,
  planVersionId: ObjectId("67330e019f1e4b2a7c0d2b02"),
  planHash: "sha256:5d7a0c9e1f3b4a6d8c2e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c",
  renderNumber: 1,
  speech: [ { sceneId: "scene-flow", speechArtifactId: ObjectId("67330f2a9f1e4b2a7c0d6a01") } ],
  captionOverrideSetId: null,
  timelineKey: "users/…/renders/67330f109f1e4b2a7c0d6f01/timeline.json",
  captionsKey: "users/…/renders/67330f109f1e4b2a7c0d6f01/captions.json",
  mp4Key: "users/…/renders/67330f109f1e4b2a7c0d6f01/output.mp4",
  thumbnailKey: "users/…/renders/67330f109f1e4b2a7c0d6f01/thumbnail.jpg",
  previewFrameKeys: ["users/…/renders/67330f109f1e4b2a7c0d6f01/frames/1.png"],
  renderInputHash: "sha256:c2d4…7f10",
  mp4Sha256: "sha256:9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d",
  qa: { /* resolution, fps, duration, audio track, frame count checks */ },
  status: "ready",
  metrics: { renderMs: 268000, sandboxMs: 301000, bytes: 18734120, durationMs: 73000, frames: 2190 },
  error: null,
  createdAt: ISODate("2026-11-12T05:40:59.000Z"),
  readyAt: ISODate("2026-11-12T05:46:10.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId`, `projectId` | ObjectId | Render id; owner; project | Auto |
| `planVersionId`, `planHash` | ObjectId, string | The exact storyboard version used | Yes |
| `renderNumber` | int | Video version 1, 2, 3… per project | Auto |
| `speech` | list of `{ sceneId, speechArtifactId }` | Which narration clip each scene used | Yes |
| `captionOverrideSetId` | ObjectId? → `captionOverrides` | Caption fixes applied, if any | No |
| `timelineKey`, `captionsKey`, `mp4Key`, `thumbnailKey`, `previewFrameKeys[]` | string | R2 file keys | Yes when ready |
| `renderInputHash` | string | Fingerprint of everything that goes into the render; identical input → reuse the existing video | Yes |
| `mp4Sha256` | string | Fingerprint of the finished MP4 (API.md §9) | Yes when ready |
| `qa` | object | Machine checks: 1080×1920, 30 fps, duration, audio track, frames | No |
| `status` | `pending` \| `rendering` \| `validating` \| `ready` \| `failed` | Render state | Yes |
| `metrics` | `{ renderMs, sandboxMs, bytes, durationMs, frames }` | Speed and size | No |
| `error` | `{ code, message }`? | Why it failed | No |
| `createdAt`, `readyAt` | date | Started; finished | Auto |

**Rules:** the R2 key layout is built by code from ids only, never from user or AI input. Only `ready` renders can be played, downloaded or published.

**Indexes**
- unique `{ projectId, renderNumber }`: no two "video 2"s in a project.
- `{ ownerId: 1, projectId: 1 }`: owner-scoped list.
- `{ ownerId: 1, renderInputHash: 1 }`: find an identical earlier render to reuse.

#### 4.20 `captionOverrides`
**Purpose:** the creator's **caption text fixes** (e.g. "NPCI" spelled the way they like), applied without re-recording the narration. Each save creates a **new set** = the previous set's fixes + the new ones; the render that uses it points to it with `captionOverrideSetId`.

```js
{
  _id: ObjectId("67330fa09f1e4b2a7c0d7b01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  projectId: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  schemaVersion: 1,
  basePlanVersionId: ObjectId("67330e019f1e4b2a7c0d2b02"),
  overrides: [ { sceneId: "scene-flow", phraseIndex: 1, text: "to NPCI — the national switch" } ],
  createdAt: ISODate("2026-11-12T06:02:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId`, `projectId` | ObjectId | Set id; owner; project | Auto |
| `basePlanVersionId` | ObjectId → `planVersions` | The storyboard version the fixes belong to | Yes |
| `overrides` | list of `{ sceneId, phraseIndex, text 1–200 }` | Replacement caption text per phrase | Yes |
| `createdAt` | date | When the set was saved | Auto |

**Rules:** each (scene, phrase) appears once per set; Hindi text must be Devanagari and Hinglish Roman. Caption fixes **don't count** toward the 3 videos/day. Kept across visual-only revisions (PIPELINE_DESIGN §5).

**Indexes:** none in V1 (Q8). A set is always reached through `renders.captionOverrideSetId` (a lookup by `_id`).

### Instagram (phase A5)

#### 4.21 `instagramConnections`
**Purpose:** the creator's connected **Instagram professional account** and the **encrypted** access token ByteReel uses to publish. One per user.

```js
{
  _id: ObjectId("6733101a9f1e4b2a7c0d7a01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  schemaVersion: 1,
  igUserId: "17841400000000001",
  username: "physics.with.priya",
  accountType: "MEDIA_CREATOR",
  profilePictureUrl: "https://scontent.cdninstagram.com/v/t51.2885-19/profile_example.jpg",
  accessToken: { ciphertext: "q8V0…Zx==", iv: "M2l…w==", tag: "pQ9…A==", keyVersion: "1" },
  tokenExpiresAt: ISODate("2027-01-11T06:10:00.000Z"),
  lastRefreshedAt: ISODate("2026-11-12T06:10:00.000Z"),
  connectedAt: ISODate("2026-11-12T06:10:00.000Z"),
  revokedAt: null,
  scopes: ["instagram_business_basic", "instagram_business_content_publish"],
  status: "active"
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId` | ObjectId | Connection id; owner | Auto |
| `igUserId` | string | Instagram's id for the account | Yes |
| `username`, `accountType`, `profilePictureUrl` | string | Shown as "Publishing to @username". `accountType` must be `BUSINESS` or `MEDIA_CREATOR` | Yes / Yes / No |
| `accessToken` | `{ ciphertext, iv, tag, keyVersion }` | The token, **encrypted** (§6.2). Removed when disconnected | Yes while active |
| `tokenExpiresAt`, `lastRefreshedAt` | date | Tokens last ~60 days and are refreshed daily when < 10 days remain | Yes |
| `connectedAt`, `revokedAt` | date | When connected; when disconnected | Auto / No |
| `scopes` | list of strings | Permissions granted | Yes |
| `status` | `active` \| `expired` \| `revoked` \| `error` | Can we publish? | Yes |

**Rules:** the token is never returned to the browser, never logged. Disconnecting removes the token and invalidates `scheduled` and `publish_failed` posts. Connecting a *different* Instagram account invalidates them too.

**Indexes**
- unique `ownerId`: **one connection per user**.
- unique partial `igUserId` where `status = "active"`: **one ByteReel user per Instagram account**. A second user trying to connect the same account gets `INSTAGRAM_ACCOUNT_IN_USE` (PRD decision #24d). The index also catches two people finishing at the same moment.
- `{ status: 1, tokenExpiresAt: 1 }`: the daily refresh job finds tokens about to expire.

#### 4.22 `posts`
**Purpose:** one document per **publish or schedule request**. It contains **approval #2**: a snapshot of exactly what the creator approved (which video, its fingerprint, which Instagram account, which caption). The publish job checks this snapshot right before posting; if anything changed, it does not publish.

```js
{
  _id: ObjectId("673310209f1e4b2a7c0d8b01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  projectId: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  schemaVersion: 1,
  renderId: ObjectId("67330fa09f1e4b2a7c0d6f02"),
  connectionId: ObjectId("6733101a9f1e4b2a7c0d7a01"),
  caption: "Ever wondered how ₹20 reaches the chaiwala in 2 seconds? 👇\n\n#UPI #DigitalIndia",
  mode: "scheduled",
  scheduledAt: ISODate("2026-11-13T13:30:00.000Z"),
  approval: {
    id: ObjectId("673310209f1e4b2a7c0d8e01"),
    renderId: ObjectId("67330fa09f1e4b2a7c0d6f02"),
    mp4Sha256: "sha256:1f2e3d4c5b6a79880a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f",
    connectionId: ObjectId("6733101a9f1e4b2a7c0d7a01"),
    igUserId: "17841400000000001",
    captionHash: "sha256:7b3c9d1e5f2a4b6c8d0e1f3a5b7c9d2e4f6a8b0c1d3e5f7a9b2c4d6e8f0a1b3c",
    approvedBy: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
    approvedAt: ISODate("2026-11-12T06:20:00.000Z")
  },
  publishKey: "pub:67330d5e9f1e4b2a7c0d2a10:67330fa09f1e4b2a7c0d6f02:6733101a9f1e4b2a7c0d7a01:673310209f1e4b2a7c0d8e01",
  state: "scheduled",
  jobId: ObjectId("673310209f1e4b2a7c0d3c05"),
  igContainerId: null, igMediaId: null, permalink: null,
  attempts: 0, nextAttemptAt: null, lastError: null, publishedAt: null,
  createdAt: ISODate("2026-11-12T06:20:00.000Z"),
  updatedAt: ISODate("2026-11-12T06:20:00.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId`, `projectId` | ObjectId | Post id; owner; project | Auto |
| `renderId`, `connectionId` | ObjectId | Which video, which Instagram connection | Yes |
| `caption` | string 1–2,200 | Caption + hashtags (≤ 30 hashtags) | Yes |
| `mode` | `now` \| `scheduled` | Publish now or later | Yes |
| `scheduledAt` | date? (UTC) | 10 min to 75 days ahead; shown in the user's timezone | When scheduled |
| `approval` | `{ id, renderId, mp4Sha256, connectionId, igUserId, captionHash, approvedBy, approvedAt }` | **Approval #2 snapshot.** `id` is a new approval id for **every** approval | Yes |
| `publishKey` | string, unique | `pub:{projectId}:{renderId}:{connectionId}:{approvalId}`: one approval can publish **at most once** | Yes |
| `state` | `draft` (reserved) \| `scheduled` \| `publishing` \| `outcome_unknown` \| `published` \| `publish_failed` \| `approval_invalidated` \| `cancelled` | Post status (ARCHITECTURE §7.4) | Yes |
| `jobId` | ObjectId? → `jobs` | The `publish` job | No |
| `igContainerId`, `igMediaId`, `permalink` | string? | Instagram's ids and the public link once posted | No |
| `attempts`, `nextAttemptAt` | int, date? | Retry bookkeeping | Auto |
| `lastError` | `{ code, message, at }`? | Plain-language reason it failed | No |
| `publishedAt`, `createdAt`, `updatedAt` | date | Timestamps | Auto |

**Rules (the hard rule: nothing publishes without approval)**
- A post is created **only** by the creator through H2. Jobs, admins and the AI can never create an approval.
- **Any change requested on the project** (revision, narration edit, voice switch, undo, caption fix), disconnecting or switching the Instagram account, Meta's deauthorize callback, suspending the user, or a new render moves a post that is **`scheduled` or `publish_failed`** to `approval_invalidated` **at the moment the change is requested**, in the same transaction (§7). Why `publish_failed` too: a failed post can be retried (H6, admin I9), and a retry must never publish with an approval that no longer matches. Archiving the project and deleting the account move both states to `cancelled` instead. Re-approving creates a new approval id, so a new `publishKey`.
- The publish job uses **conditional updates** ("move to `publishing` only if the post is still `scheduled`"), so a change made at the last second can't slip through. The real guard is the post's **`state`** plus the full re-check below, not `approval.renderId`: the approval snapshot never changes on a post, so checking it against itself proves nothing. Every change moves the post out of `scheduled`/`publish_failed` in the same transaction, so the `state` filter catches it.
- **The full re-check** (right before posting, and in every retry, H6 and I9) also requires: the project is **not archived**, the owner's `user.status` is **`active`**, the project's `currentRenderId` is still `approval.renderId`, and the project's `currentPlanVersionId` and `approvedPlanVersionId` still equal that render's `planVersionId`. Any difference → no publish.
- `captionHash` is computed by the server; `igUserId` is copied from the connection.

**Indexes**
- unique `publishKey`: the same approval can never post twice.
- `{ ownerId: 1, createdAt: -1 }`: the user's posts, newest first.
- `{ state: 1, scheduledAt: 1 }`: find scheduled posts that are due. **Open item for F30/F31:** a post can be scheduled up to 75 days ahead, and the publish job waits with Inngest's `sleepUntil`. Check the Inngest **free plan's maximum sleep** before F31. If it is shorter than 75 days, a small cron uses this index to start posts that are due.
- unique partial `projectId` where `state` is `scheduled`, `publishing` or `outcome_unknown`: **one live post per project** (API A-14; see Q5).

#### 4.23 `publishAttempts`
**Purpose:** the paper trail of every call ByteReel made to Instagram for a post (PRD §7). If a post fails or a creator asks "did it post?", this shows each step and Instagram's answer.

```js
{
  _id: ObjectId("673310a09f1e4b2a7c0d8c01"),
  postId: ObjectId("673310209f1e4b2a7c0d8b01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  schemaVersion: 1,
  step: "create_container",
  request: { /* redacted: no token */ },
  response: { /* redacted */ },
  outcome: "ok",
  at: ISODate("2026-11-13T13:30:05.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `postId`, `ownerId` | ObjectId | Entry id; post; owner | Auto |
| `step` | `create_container` \| `poll` \| `publish` \| `reconcile` | Which call | Yes |
| `request`, `response` | object | What was sent and received, **redacted** (never the token) | Yes |
| `outcome` | string | Result of the call (values not listed in the docs) | Yes |
| `at` | date | When | Auto |

**Rules:** append-only. A Meta data-deletion request deletes the request/response payloads (§6.8).

**Indexes:** `{ postId: 1 }`: show a post's attempts, and find them for Meta data deletion (Q8).

#### 4.24 `notifications`
**Purpose:** in-app messages for the bell and the banners on your next visit ("Your video is ready", "Post published", "Instagram needs reconnecting"). V1 sends no emails, so this is how ByteReel tells you things.

```js
{
  _id: ObjectId("673310f19f1e4b2a7c0d9a01"),
  ownerId: ObjectId("67330c1a9f1e4b2a7c0d1e01"),
  schemaVersion: 1,
  type: "video_ready",
  projectId: ObjectId("67330d5e9f1e4b2a7c0d2a10"),
  postId: null,
  title: "Your video is ready",
  message: "\"How UPI payments work\" is ready to review.",
  readAt: null,
  createdAt: ISODate("2026-11-12T05:46:12.000Z")
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id`, `ownerId` | ObjectId | Notification id; owner | Auto |
| `schemaVersion` | int | Document shape version (§1.7) | Auto |
| `type` | `storyboard_ready` \| `video_ready` \| `needs_input` \| `generate_failed` \| `post_published` \| `post_failed` \| `approval_invalidated` \| `instagram_reconnect` | Kind | Yes |
| `projectId`, `postId` | ObjectId? | What it is about | No |
| `title`, `message` | string | The text shown | Yes |
| `readAt` | date? | When you marked it read | No |
| `createdAt` | date | When | Auto |

Source: the `Notification` shape in API.md §11.3 (+ `ownerId` and `schemaVersion`, which every user-owned document has); copied into ARCHITECTURE §8 (Q2, Q3).

**Rules:** created by the server only (in the same transaction as the event it reports, §7). B6 sets `readAt`. Deleted with the account.

**Indexes:** `{ ownerId: 1, createdAt: -1 }`: the bell list, newest first; also used for "unread only" (a user has few notifications, so no separate index, Q8).

### Compliance (phase A6)

#### 4.25 `deletionRequests`
**Purpose:** tracks two kinds of deletion: a creator **deleting their ByteReel account** (B3, F33) and **Meta's data-deletion callback** when someone removes ByteReel from their Instagram settings (J2, F37). Meta requires a public status page with a confirmation code, which is read from here.

```js
{
  _id: ObjectId("673312aa9f1e4b2a7c0d9c02"),
  kind: "meta_data",
  confirmationCode: "DEL-7K3M9Q2X",
  status: "completed",
  requestedAt: ISODate("2026-11-12T08:00:00.000Z"),
  completedAt: ISODate("2026-11-12T08:00:04.000Z")
}
```
(While it is still `pending`, it also holds `igUserId: "17841400000000001"`, so the background job knows whose data to delete.)

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` | ObjectId | Request id (B3 returns it as `deletionRequestId`) | Auto |
| `kind` | `account` \| `meta_data` | `account` = the creator deleted their account (B3); `meta_data` = Meta's callback (J2) | Yes |
| `status` | `pending` \| `completed` \| `failed` \| `cancelled` | Progress; `cancelled` = an admin restored the account within the 30 days | Yes |
| `eraseAfter` | date | `account` requests: when the 30-day grace period ends and the erase starts (`requestedAt` + 30 days) | `account` only |
| `requestedAt`, `completedAt` | date | Timestamps | Auto / No |
| `confirmationCode` | string `DEL-` + 8 characters | Meta requests only; shown on the public status page | Meta only |
| `ownerId` | ObjectId? | `account` requests: whose account. **Removed when completed** | While pending |
| `igUserId` | string? | `meta_data` requests: which Instagram account. **Removed when completed** | While pending |
| `error` | `{ code, message }`? | Why it failed (no personal data) | No |

**Rules:** the public status page (J3) returns no personal data. `meta_data` records: when the request completes, `igUserId` is removed, so the record keeps only `{ kind, status, requestedAt, completedAt, confirmationCode }` (needed for Meta's status page). `account` records live only while the deletion is in progress; the erase step deletes them after writing the `deletionLog` entry (6.7).

**Indexes:** **partial** unique `confirmationCode`, created with `partialFilterExpression: { confirmationCode: { $type: "string" } }`, for the status page lookup. Why partial: account-deletion records have no code, and a plain unique index treats every missing field as `null`, so the second record without a code would be refused as a "duplicate".


#### 4.26 `deletionLog`
**Purpose:** the **permanent, anonymous** record of each deleted account (founder decision, 2026-11-13). It lets you see how long people stayed, how much they used ByteReel and what a user costs, **without keeping the person**. Written once, by the erase step after the 30-day grace period (6.7), and never changed.

```js
{
  _id: "acct_7f3k9q2m",             // random code, NOT an ObjectId and not linked to anything
  signedUpMonth: "2026-12",
  deletionRequestedMonth: "2027-02",
  erasedMonth: "2027-03",
  reason: "user_request",
  projectsCount: 14,
  videosCount: 9,
  postsPublishedCount: 6,
  languagesUsed: ["en", "hi"],
  aiCostRange: "₹100-200",
  schemaVersion: 1
}
```

| Field | Type | Meaning | Req |
|---|---|---|---|
| `_id` | string `acct_` + 8 random characters | A random code. We keep **no table** that maps it back to the user | Yes |
| `signedUpMonth`, `deletionRequestedMonth`, `erasedMonth` | string `YYYY-MM` | **Month only**, never the exact date | Yes |
| `reason` | `user_request` | Why the account was deleted (only creator requests in V1) | Yes |
| `projectsCount`, `videosCount`, `postsPublishedCount` | int | How much they used ByteReel | Yes |
| `languagesUsed` | array of `en` \| `hi` \| `hinglish` | Which languages they made videos in | Yes |
| `aiCostRange` | string range, e.g. `₹0-100`, `₹100-200`, `₹200-500`, `₹500+` | Total AI cost, **in a range**, never exact | Yes |
| `schemaVersion` | int | Shape version | Yes |

**Rules (why it stays anonymous):**
- **Why the rounding?** With only a few beta users, an exact date plus an exact cost could be enough to guess who it was, which would make it personal data again under the DPDP Act. Months and ranges prevent that.
- **Why not an ObjectId?** An ObjectId contains the exact moment it was created, which would undo the month rounding.
- **Never stored here:** name, email, phone, the creator's own words (topics, notes, scripts), Instagram username or ids, IP addresses, file keys.
- Topics are not stored: V1 projects have no topic category field, only the creator's own text, which is personal. If a category field is added later, categories (not text) may be added here.
- Not owner-scoped, so the minimal validator (Q9) doesn't require `ownerId`; it requires `schemaVersion`.

**Indexes:** none (only `_id`). It's small and read rarely.
---

## 5. How the collections connect

```
 allowlist ···(signedUpUserId)···► user
                                     │
     ┌─────────────┬─────────────┬───┴──────────┬───────────────┬─────────────────┐
     ▼ many        ▼ one         ▼ many         ▼ many          ▼ many            ▼ at most one
  session       account     verification   notifications   speechArtifacts   instagramConnections
                                                                 ▲                  ▲
                                                                 │ used by          │ published to
                                                                 │                  │
 user ──► many projects                                          │                  │
            ├──► many planVersions ──► 0 or 1 storyboardApprovals│                  │
            ├──► many revisions                                  │                  │
            ├──► many jobs                                       │                  │
            ├──► many captionOverrides                           │                  │
            ├──► many renders ───────────────────────────────────┘                  │
            └──► many posts ────────────────────────────────────────────────────────┘
                   └──► many publishAttempts

 Side records (no screen of their own):
   providerUsage · auditLogs · usageCounters · idempotencyKeys · rateLimits · deletionRequests
   settings (one global document, belongs to nobody)
```

**Which field holds each link**

| Document | Field | Points to |
|---|---|---|
| `session`, `account` | `userId` | `user` |
| `verification` | `value` | `user` (as a string id) |
| `allowlist` | `signedUpUserId` | `user` |
| Every user-owned document | `ownerId` | `user` |
| `projects` | `currentPlanVersionId`, `approvedPlanVersionId` | `planVersions` |
| `projects` | `currentRenderId` | `renders` |
| `projects` | `activeJobId` | `jobs` |
| `planVersions` | `projectId`; `parentVersionId` | `projects`; the previous `planVersions` |
| `storyboardApprovals` | `planVersionId` | `planVersions` |
| `revisions` | `basePlanVersionId`, `resultPlanVersionId`; `jobId` | `planVersions`; `jobs` |
| `jobs` | `inputRef.planVersionId` / `revisionId` / `postId` | `planVersions` / `revisions` / `posts` |
| `captionOverrides` | `basePlanVersionId` | `planVersions` |
| `renders` | `planVersionId`; `captionOverrideSetId`; `speech[].speechArtifactId` | `planVersions`; `captionOverrides`; `speechArtifacts` |
| `posts` | `renderId`; `connectionId`; `jobId` | `renders`; `instagramConnections`; `jobs` |
| `publishAttempts` | `postId` | `posts` |
| `providerUsage` | `projectId`, `jobId` | `projects`, `jobs` |
| `auditLogs` | `actorId`; `subject.id` | `user`; any document |
| `notifications` | `projectId`, `postId` | `projects`, `posts` |

`speechArtifacts` belong to the **user**, not to one project, so a narration clip can be reused by any of that user's projects (never by another user).

**References are like foreign keys, but not enforced.** A reference is just the other document's `_id` stored in a field (e.g. `posts.renderId`). Unlike MySQL foreign keys, **MongoDB does not check them**: it wouldn't stop us saving a post that points to a render that doesn't exist, and it won't cascade-delete. **Our code enforces them**: the repositories in `packages/db` always load the referenced document with the same `ownerId`, and account deletion removes every related document itself (§6.7).

**Embedded vs referenced.** Some data lives *inside* its parent instead of in its own collection: the whole storyboard (`planVersions.plan`), job stages (`jobs.stages`), and the publish approval (`posts.approval`). We embed when the data is only ever read together with its parent and must never change separately. The storyboard approval (#1) is a separate collection because `planVersions` are **insert-only**: a version can't be edited after it is saved, so the approval can't be written into it later. A separate document (unique per version) records it instead.

---

## 6. Safety and privacy rules

### 6.1 Passwords
- Hashed by Better Auth with **scrypt** (a slow, one-way scramble) and stored in `account.password`. You'll see a long random-looking string in Atlas; that's the expected result (F08 checks it).
- Nobody can read a password back, including admins. A forgotten password is replaced via an admin's one-time reset link (`verification`, 4.4).
- Passwords are never logged or returned by any endpoint. Rules: 8–128 characters.

### 6.2 Instagram tokens (encrypted)
- Encrypted with **AES-256-GCM** before saving (ARCHITECTURE §21.4). The database stores `{ ciphertext, iv, tag, keyVersion }`, never the plain token.
- The **key is not in the database**. It lives in environment variables: `TOKEN_ENCRYPTION_KEYS` (a JSON map `{ version: base64Key }`) and `TOKEN_ENCRYPTION_ACTIVE_VERSION`, in `.env` locally and in Vercel settings in production. Never in git.
- So someone who gets a copy of the database alone can't use the tokens.
- A **new random IV** (the "starting value" for AES-GCM) is made for **every** encryption, including each time a refreshed token is saved. Re-using an IV with the same key would break the encryption's safety.
- `keyVersion` allows changing the key later (decrypt with the old key, re-encrypt with the new one).
- If the key is lost, the stored tokens can't be decrypted and creators must reconnect Instagram. Videos and projects are unaffected.

### 6.3 Owner check on every query
- Every repository method takes the signed-in user's `ownerId` and adds it to **every** filter: `projects.get(ownerId, projectId)`. There is no "find by id" without an owner (ARCHITECTURE §10.3).
- Another user's item is answered with **`404 NOT_FOUND`**, never `403`, so nobody can even learn that an id exists.
- Background jobs receive `{ ownerId, projectId, jobId }` and re-check ownership before acting.
- R2 links (presigned URLs) are created only after this check, and expire after 15 minutes. One exception: the link Instagram uses to **fetch the video** for publishing lasts **2 hours** (ARCHITECTURE §9, decision D5) and is used only for that one upload.
- Admin endpoints are the only exception, and admins see metadata only (no plan text, captions, videos or tokens).
- Enforced by the typed repository API, a code-review/lint rule (no raw collection access outside `packages/db`), and tests that user A can't read or change user B's data.

### 6.4 Server-owned fields (users can't set them)
- **User fields** `role`, `status`, `failedLoginCount`, `lockedUntil`, `lastLoginAt`, `timezone`, `defaultLanguage`, `defaultVoiceGender` are declared `input: false` in Better Auth. A sign-up body containing any of them is rejected. Only 6 Better Auth endpoints are open; everything else (update-user, delete-user, …) is blocked.
- **Never accepted from the browser:** `ownerId`, `state`, `stateVersion`, approvals, `captionHash`, `publishKey`, file keys, `schemaVersion`. The server sets them.
- **Never accepted from the AI:** ownership, approvals, storage paths, credentials. The planner's output is stripped of those and the code assigns them.
- Request bodies are strict: an unknown field → `400 INVALID_INPUT`.

### 6.5 What we never store
- Plain-text passwords, or Instagram tokens in plain text.
- API keys and other secrets (environment variables only).
- Video, audio or image files (R2 holds them; MongoDB holds only keys).
- Brainstorm ideas and AI caption suggestions that the creator didn't pick.
- Payment details (no billing in V1).
- Instagram tokens or passwords inside logs, audit logs or `publishAttempts` (those are redacted).

### 6.6 Archive is not delete
- **Archiving** a project (C5, the "delete" on a project card) is a **soft delete**: `state = archived`, `archivedAt = now`, `stateBeforeArchive` kept. The project disappears from My videos.
- **Nothing is deleted**: not in MongoDB, **not in R2**. A running job is asked to stop, and a `scheduled` or `publish_failed` post is `cancelled` (so it can never be published or retried).
- Archiving is refused while a post is being published right now (`publishing`) **or** its outcome is still being checked (`outcome_unknown`).
- Real deletion of data happens only through account deletion (6.7).

### 6.7 Account deletion (India DPDP Act): final rule
> **Founder decision, 2026-11-13 (Q10).** Deleting an account is a **30-day soft delete**, then a real erase of personal data, with one **anonymous** entry kept forever in `deletionLog` (4.26). Before the public launch, the privacy policy (F37) must say this in plain words, and it should be checked once by someone who knows Indian privacy law (F37).

The creator deletes their account in Settings (B3, F33) with their password and by typing `DELETE`.

1. **Right away, in one transaction (§7):** user `status = deleting` (they can't log in; nothing of theirs is visible to anyone), **all sessions deleted** (logged out everywhere), `scheduled` and `publish_failed` posts `cancelled`, running jobs asked to stop, and a `deletionRequests` record with `eraseAfter = requestedAt + 30 days`.
2. **Right away, in the background:** the **Instagram token and connection are deleted** (Meta's rule: Meta data goes as soon as the user leaves). If they come back within 30 days they connect Instagram again.
3. **For 30 days (grace period):** everything else is kept. If the creator writes to us ("I deleted by mistake"), an admin can **restore** the account (F34): `status` back to `active`, the `deletionRequests` record becomes `cancelled`. Cancelled posts stay cancelled (the creator approves again).
4. **After 30 days** (the `delete-account` job, started at `eraseAfter`):
   - **first writes one anonymous `deletionLog` entry** (4.26): rounded facts only, no name, email, words or Instagram data;
   - deletes the R2 folder `users/{ownerId}/` (all videos, audio, thumbnails);
   - deletes every document with that `ownerId`: `projects`, `planVersions`, `revisions`, `storyboardApprovals`, `jobs`, `speechArtifacts`, `renders`, `captionOverrides`, `posts`, `publishAttempts`, `notifications`, `idempotencyKeys`, `usageCounters`;
   - deletes the person's **`allowlist` entry** (their email), so coming back needs a new invite;
   - `rateLimits`: the counters hold only a **hash** of the IP, email or user id and delete themselves within their short window (TTL); counters for the user's id and email are deleted anyway by re-computing the hash;
   - **anonymizes** `providerUsage` (not deleted): `ownerId`, `projectId` and `jobId` are removed; provider, units, cost and date stay, so the spend ceilings and monthly totals stay correct;
   - **anonymizes** `auditLogs` (the entries stay, but no longer point to the person);
   - **finally** removes the Better Auth rows (`user`, `account`, `session`, `verification`) and the `deletionRequests` record itself (its job is done; the permanent record is the `deletionLog` entry).
5. The background job can be repeated safely if it is interrupted (it just deletes whatever is left; the `deletionLog` entry is written once, keyed by the request).

**What is never kept after the 30 days:** name, email, phone, password hash, the creator's topics, notes and scripts, video/audio files, Instagram username or ids, IP addresses.

### 6.8 Meta data-deletion request
When someone removes ByteReel in their Instagram settings, Meta calls us (J2, F37). We create a `deletionRequests` record (`kind: meta_data`), then delete the Instagram connection document (token, username, picture), remove Instagram-derived fields on that user's posts (`igContainerId`, `igMediaId`, `permalink`; `approval.igUserId` is replaced by a hash), delete the `publishAttempts` request/response payloads, and invalidate `scheduled` and `publish_failed` posts. The ByteReel account and videos stay (they aren't Meta's data).

---

## 7. Transactions (all-or-nothing changes)

### 7.1 Why
Many actions change several documents at once. If the server crashed halfway, we could end up with, for example, an **approval without a job** (you clicked, nothing happens), a **counted video without a job** (you lose one of your 3), or worst, a **change saved while a scheduled post still holds its old approval** (it would publish something you didn't approve). A transaction makes each action happen completely or not at all. Atlas clusters, including the free M0, run as a *replica set* (three copies of the data), which is what MongoDB needs for transactions.

The checks (is this still the current version? is the job slot free? quota left?) are done **inside** the same transaction, so nothing can change between "check" and "write".

**How the code does it (beginner note).** We use the driver's `session.withTransaction(async () => { … })`. If MongoDB reports a temporary conflict, `withTransaction` **runs the whole callback again**. So the callback must only contain database reads and writes. **Never send an Inngest event or call an outside service (Gemini, ElevenLabs, Meta, R2) inside it**: a re-run would send it twice, and a rolled-back transaction would have sent something for changes that never happened. Events are sent **after** the commit; if that send fails, the sweeper re-sends it (Q11). Calls to outside services happen before the transaction (e.g. the Instagram token exchange in G3) or in a background step.

### 7.2 The operations that use a transaction

| # | Action | Endpoint · feature | Changes together | What would go wrong without it |
|---|---|---|---|---|
| 1 | Create project | C2 · F12/F15 | insert `projects` (`planning`, `planRequestCount: 1`) + insert `plan` job + set `activeJobId` + `usageCounters` projects +1. **F12 (until F15):** `usageCounters` projects +1 (within 5) + insert `projects` (`draft`, `planRequestCount: 0`, no job) + the answer saved on the `idempotencyKeys` record | A project stuck in "planning" with no job, or a used quota with no project |
| 2 | Edit idea after a failed storyboard | C4 · F15 | `projects` idea text, title, `stateVersion` (one document: atomic anyway) | — |
| 3 | Edit narration / switch voice | D3, D4 · F17, F19 | insert `planVersions` + project pointers (`currentPlanVersionId`, `approvedPlanVersionId = null`, state, `stateVersion`) + `scheduled`/`publish_failed` post → `approval_invalidated` + notification | A new storyboard while an old publish approval stays live |
| 4 | Revision request | D5 · F18, F26 | insert `revisions` + insert `revise` job + `activeJobId` + `planRequestCount` +1 (only if below the limit) + `scheduled`/`publish_failed` post → `approval_invalidated` + notification | Same as 3; or a revision with no job, or a counted change with no revision |
| 5 | Undo / restore a version | D7 · F17 | project pointers + `scheduled`/`publish_failed` post → `approval_invalidated` + notification (ARCHITECTURE §17.5) | Same as 3 |
| 6 | **Approve storyboard** (approval #1) | D8 · F20 | insert `storyboardApprovals` + insert `generate` job + project `generating`, `approvedPlanVersionId`, `activeJobId` + `usageCounters` videos +1. Re-approving a version that already has a video instead points the project back to that render (no job, no quota) | Approval with no job, or a counted video with no job |
| 7 | Caption fix | F4 · F25 | insert `captionOverrides` + insert `caption` job + project `generating`, `activeJobId` + `scheduled`/`publish_failed` post → `approval_invalidated` + notification (**no** quota counter) | A caption change while the old approval stays live |
| 8 | Retry a job | E2 (and admin I9) · F15, F23 | job `queued`, `attempt` +1 + project back to `planning`/`generating`, `activeJobId`, `lastError` cleared + `planRequestCount` +1 when a plan retry uses an edited idea | A queued job the project doesn't know about, or a counted retry that never runs |
| 9 | **Publish now / schedule** (approval #2) | H2 · F30, F31 | insert `posts` (approval snapshot with a new approval id, `publishKey`) + insert `publish` job + project `publishing`/`scheduled` + audit `post.approved` | A post without a job (never published), or a job without its approval record |
| 10 | Cancel a scheduled post | H5 · F31 | post → `cancelled` + job cancelled + project → `video_ready` | A cancelled post whose job still wakes up, or a project stuck in "scheduled" |
| 11 | Retry a failed publish | H6 (and admin I9) · F30 | post → `publishing`, `attempts` +1 + publish job re-queued (after the full re-check, §4.22) | A post marked "publishing" with no job behind it |
| 12 | Archive project | C5 · F21 | running job `cancelRequestedAt` + `scheduled`/`publish_failed` post `cancelled` + project `archived` | An archived project whose post still publishes or can be retried |
| 13 | Connect Instagram | G3 · F28 | upsert `instagramConnections` (encrypted token) + if it is a *different* account: `scheduled`/`publish_failed` posts → `approval_invalidated` + notifications + audit `instagram.connected` (the calls to Meta happen first, outside) | A new account connected while posts approved for the old one stay live |
| 14 | Disconnect Instagram | G4 · F28 | connection token removed, `status = revoked`, `revokedAt` + all `scheduled`/`publish_failed` posts → `approval_invalidated` + notifications + audit | Scheduled posts aimed at an account that is gone |
| 15 | Meta deauthorize callback | J1 · F37 | connection `revoked`, token removed + `scheduled`/`publish_failed` posts → `approval_invalidated` + notification `instagram_reconnect` + audit | Same as 14 |
| 16 | Suspend a user (admin) | I6 · F34 | user `suspended` + all sessions deleted + jobs asked to stop + `scheduled`/`publish_failed` posts → `approval_invalidated` | A suspended user still logged in, or their post still publishing |
| 17 | **Delete account** | B3 · F33 | user `deleting` + all sessions deleted + `scheduled`/`publish_failed` posts `cancelled` + jobs asked to stop + insert `deletionRequests` (with `eraseAfter` = +30 days) | A half-deleted account that can still log in or post |
| 18 | **A job finishes** (the last step of every background job, and the stuck-job sweeper) | Inngest functions · F15 onwards | job final state (`succeeded`/`failed`/`needs_input`/`cancelled`) + project state + clear `activeJobId` + project pointers (e.g. `currentPlanVersionId`, `currentRenderId`) + notification. A short transaction: only these few writes | A finished job while the project still shows "working" forever, or a new video the project doesn't point to |

### 7.3 Other safety tools (no transaction needed)
- **One-document changes are always atomic.** Updating several fields of one project at once is all-or-nothing by itself.
- **Conditional updates:** "update only if the document is still in the state I expect", e.g. move a post to `publishing` only if it is still `scheduled`. If someone changed it meanwhile, nothing happens.
- **`stateVersion` (optimistic concurrency):** every project change sends the version it saw. If another tab changed the project first, the request fails with "This project changed in another tab, refresh."
- **Unique indexes as the last guard:** even if two requests race, the database refuses a second approval for the same version, a second live post for a project, or a second job with the same key.

### 7.4 What is deliberately NOT one transaction
Long work runs in background steps (Inngest), each saved as it finishes: making the storyboard, recording narration, rendering, publishing, the account-deletion clean-up, Meta data deletion. A transaction can't last minutes, so instead every step is **safe to repeat** (keyed by job + stage + scene) and a retry continues from the last finished step. The background event is sent **after** the transaction commits (see Q11).

---

## 8. Indexes summary

"Source" = where the index is defined (Q = decided in §12.3). **Required (BA)** = Better Auth index that **we create ourselves** with the setup script (F08), because Better Auth's MongoDB adapter creates none for these collections (verified in F08 with Better Auth 1.7.14). All of them are needed for **phase A2**.

| Collection | Index | Unique? | Why (plain words) | Source |
|---|---|---|---|---|
| `user` | `email` | Yes | One account per email | Required (BA) |
| `session` | `token` | Yes | Find your session on each request | Required (BA) |
| `session` | `userId` | No | Log a user out everywhere | Required (BA) |
| `session` | `expiresAt` TTL (`expireAfterSeconds: 0`) | No | Expired sessions delete themselves | Required (BA) |
| `account` | `{ userId: 1, providerId: 1 }` | No | Find a user's password on login | Required (BA) |
| `verification` | `identifier` | No | Find a reset link | Required (BA) |
| `verification` | `expiresAt` TTL (`expireAfterSeconds: 0`) | No | Expired reset links delete themselves | Required (BA) |
| `allowlist` | `email` | Yes | An email is invited once | ARCH §8.2 |
| `rateLimits` | `expiresAt` TTL (`expireAfterSeconds: 0`); lookups use `_id` | No | Old counters delete themselves | API §3.7 + Q2/Q13 |
| `projects` | `{ ownerId, updatedAt: -1 }` | No | My videos list, newest first | ARCH §8.3 |
| `projects` | `{ ownerId, state }` | No | The tabs | ARCH §8.3 |
| `planVersions` | `{ projectId, versionNumber: -1 }` | Yes | No duplicate version numbers; history order | ARCH §8.4 |
| `planVersions` | `{ ownerId, projectId }` | No | Owner-scoped lookups | ARCH §8.4 |
| `revisions` | `{ projectId, createdAt: -1 }` | No | Revision chat history | ARCH §8.5 |
| `storyboardApprovals` | `planVersionId` | Yes | A version is approved at most once | ARCH §8.6 |
| `jobs` | `idempotencyKey` | Yes | No duplicate jobs from double-clicks | ARCH §8.9 |
| `jobs` | `{ projectId, createdAt: -1 }` | No | A project's jobs | ARCH §8.9 |
| `jobs` | `{ state, updatedAt }` | No | Find stuck jobs | ARCH §8.9 |
| `idempotencyKeys` | `{ ownerId, key }` | Yes | A click is processed once | API §6 + Q2 |
| `idempotencyKeys` | `createdAt` TTL (`expireAfterSeconds: 86400`) | No | Forget clicks after a day | API §6 + Q2 |
| `usageCounters` | `{ ownerId, kind, period }` | Yes | One counter per user, kind and day/month | Q2/Q7 |
| `usageCounters` | `expiresAt` TTL (`expireAfterSeconds: 0`) | No | Old counters delete themselves | Q2 |
| `speechArtifacts` | `{ ownerId, cacheKey }` | Yes | One recording per exact setup per owner; enables reuse | ARCH §8.7 |
| `renders` | `{ projectId, renderNumber }` | Yes | No duplicate video numbers | ARCH §8.8 |
| `renders` | `{ ownerId, projectId }` | No | Owner-scoped list | ARCH §8.8 |
| `renders` | `{ ownerId, renderInputHash }` | No | Reuse an identical earlier render | ARCH §8.8 |
| `instagramConnections` | `ownerId` | Yes | One connection per user | ARCH §8.11 |
| `instagramConnections` | `igUserId` where `status = active` (partial) | Yes | One ByteReel user per Instagram account | ARCH §8.11 |
| `instagramConnections` | `{ status, tokenExpiresAt }` | No | Daily token refresh | ARCH §8.11 |
| `posts` | `publishKey` | Yes | One approval publishes at most once | ARCH §8.12 |
| `posts` | `{ ownerId, createdAt: -1 }` | No | A user's posts | ARCH §8.12 |
| `posts` | `{ state, scheduledAt }` | No | Find posts that are due | ARCH §8.12 |
| `posts` | `projectId` where `state` ∈ {`scheduled`, `publishing`, `outcome_unknown`} (partial) | Yes | One live post per project | ARCH §8.12 + API A-14 (Q5) |
| `providerUsage` | `{ at: -1 }`, `{ ownerId, at: -1 }`, `{ provider, at: -1 }` | No | Spend totals by time, user, service | ARCH §8.14 |
| `publishAttempts` | `postId` | No | A post's attempts; Meta data deletion | Q8 |
| `notifications` | `{ ownerId, createdAt: -1 }` | No | The bell list (also unread only) | Q8 |
| `deletionRequests` | `confirmationCode`, **partial**: only where it is a string (`$type: "string"`) | Yes | Meta status page lookup; account-deletion records have no code (missing = `null` would clash) | Decided (Q8) |
| `captionOverrides`, `auditLogs`, `settings` | none in V1 | | Reached by `_id`, or not searched yet | Q8 |

A partial index with a list of states (`$in`) needs MongoDB 6.0 or newer; Atlas runs a current version.

---

## 9. How big will it get?

**The free limit is 512 MB.** Because videos and audio live in R2, MongoDB holds only text. Rough sizes (uncompressed; the real number is likely smaller):

| Per project (typical: 3 storyboard versions, 2 revisions, 1–2 videos, 1 post) | Size |
|---|---|
| `projects` (1) | ~1.5 KB |
| `planVersions` (3 × ~10 KB; the storyboard JSON is the big part) | ~30 KB |
| `jobs` (~5 × ~3 KB, with stages) | ~15 KB |
| `revisions`, `storyboardApprovals`, `captionOverrides` | ~3 KB |
| `speechArtifacts` (~7 scenes × ~0.6 KB) | ~4 KB |
| `renders` (2 × ~2 KB) | ~4 KB |
| `posts` + `publishAttempts` (~5) | ~9 KB |
| `providerUsage` (~15 calls), `auditLogs`, `notifications` | ~9 KB |
| **Total, plus room for indexes** | **≈ 100 KB** |
| Worst case: 20 changes (≈ 21 storyboard versions) | ≈ 300 KB |

Per user, the account records (`user`, `account`, `session`s, `allowlist`, `instagramConnections`) add only ~3 KB.

**What that means**
- 512 MB ≈ **5,000 typical projects** (≈ 1,700 if every project used all 20 changes).
- At the full beta pace in ARCHITECTURE §25.2 (~22 videos a day), that's ~65 MB a month, so we'd reach ARCHITECTURE's **upgrade trigger of 300 MB** after roughly 4–5 months. Early beta use will be much lower.
- We'll replace these guesses with real numbers after F15 and F23 (Atlas shows each collection's size).

**Other free-tier limits besides size** (read on 2026-11-13 from MongoDB's page "Atlas Free Cluster Limits", https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/; they can change, so re-check before launch):

| Limit | Free cluster |
|---|---|
| Storage (documents + indexes) | 0.5 GB |
| Open connections | 500 |
| Operations per second | 100 |
| Data transfer | 10 GB in + 10 GB out per rolling 7 days |
| Databases / collections | 100 databases, 500 collections in total |
| Free clusters per Atlas project | 1 (production uses a second project, Q1) |
| Inactivity | **Paused after 30 days with zero connections** (can be resumed); idle free clusters may be deactivated under the Terms of Service |

Our 26 collections are far below 500. Checked in F05: the cluster runs **MongoDB 8.0** as a **replica set**, so transactions (§7) and partial indexes with `$in` work. What we do about the limits:
- **Cache the MongoDB client globally.** On Vercel each server function can start many times; if every start opened a new connection, we would run out of connections. `packages/db` keeps one client in a global variable and reuses it (the usual Next.js pattern).
- **Polling is the main load.** While a job runs, the browser asks for the status **every 2 seconds** (C6, decision D2): about 30 small reads per minute per open tab. That, not storage, is what pushes against the operations limit. Keep each status read to one or two small indexed queries, and stop polling when nothing is running (`pollAfterMs: null`).

**What happens when it's full:** Atlas stops accepting new writes on the free cluster, while reads keep working. ByteReel would fail to save new projects or progress. To avoid it: watch the size in Atlas, and at 300 MB either clean up (e.g. `providerUsage` older than 12 months, old finished jobs) or upgrade to a paid tier. **Upgrading costs money, so it's your decision when we get there.**

---

## 10. Backups

- **Correction (2026-11-13, F05):** free clusters **can** have backups now. MongoDB's page says: "You can enable backups on Free clusters", and then "Atlas takes a daily snapshot and retains up to four snapshots" (https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/). It costs nothing, so we **recommend switching it on** (Atlas → the cluster → *Backup*). It gives a copy of the last ~4 days, which is enough to recover from a mistake. ARCHITECTURE §20.5 (decision D6, "no backup system in V1") was written when this didn't exist; switching on the free snapshot isn't building a backup system, so D6 still holds for anything that costs money or needs code.
- R2 files aren't backed up either. If the database were lost, the videos would still be in R2, but the accounts and projects that point to them would be gone.

**Simple, free safety net (proposed, no cost):** before any risky change (a data migration, a bulk delete, a cluster change), take a manual copy:
- **Compass:** open a collection → *Export Collection* → JSON. Good for one or two collections.
- **`mongodump`** (part of MongoDB's free Database Tools): one command copies the whole `bytereel` database to a folder; `mongorestore` puts it back.
- Keep the copy **private and out of git** (it contains people's emails and content), and delete it when it's no longer needed (DPDP).
- We never run destructive commands (dropping a collection, deleting data) without your explicit OK.

---

## 11. What gets created when

A collection appears in Atlas the first time something is written to it (or when the setup script creates its indexes). To keep "what you see = what we built", **each feature creates only its own collections and indexes**, not all 26 on day one.

| Feature | You'll see in Atlas (Browse Collections) |
|---|---|
| **F05** Atlas setup | Your free cluster and the `bytereel` database, empty. (Atlas shows a database only once it has a collection; we decide in F05 whether to create it now or let F06 create it) |
| **F06** Connect the app | `healthchecks` with **exactly one test record**. At the end of F06, after you have seen it, the record is deleted and the collection dropped |
| **F07** Allow-list | `allowlist` with your email |
| **F08** Sign up | `user` (you), `account` (your password hash, scrambled), `session` (your login); `rateLimits` counters. Our setup script also creates the **required Better Auth indexes** (§8), visible under each collection's *Indexes* tab |
| **F09** Log in / out | More/fewer `session` documents as you log in and out; `rateLimits` counters that vanish after 15 min; `failedLoginCount` on your `user` |
| **F10, F11** | Nothing new (F11 only reads) |
| ✅ **End of A2** | `user`, `session`, `account`, `allowlist`, `rateLimits` (and the Better Auth indexes, including those for `verification`) |
| F12 | `projects`, `idempotencyKeys`, `usageCounters` (projects counted **and** limited to 5/day; the other limits in F27). Projects are saved in state `draft` with no job until F15 |
| F14 | `providerUsage` (brainstorm calls) |
| F15 | `jobs`, `planVersions` |
| F17, F19 | More `planVersions` (`user_edit`) |
| F18 | `revisions` |
| F20 | `storyboardApprovals`, `auditLogs` |
| F21 | Archived projects (no new collection) |
| F22 | Nothing in MongoDB: your R2 bucket |
| F23 | `speechArtifacts`, `renders` (files in R2) |
| F25 | `captionOverrides` |
| F27 | `settings`; the remaining limits in `usageCounters` (videos, voice characters) and `projects.planRequestCount` start being enforced (projects/day is enforced since F12) |
| F28 | `instagramConnections` |
| F30, F31 | `posts`, `publishAttempts` |
| F32 | `notifications` |
| F33 | `deletionRequests` (account deletion), `deletionLog` (anonymous record written after the 30 days) |
| F35 | `verification` (reset links) |
| F36 | `settings` edits from the admin page |
| F37 | `deletionRequests` (Meta requests) |

---

## 12. Glossary, differences from PRD §15, open questions

### 12.1 Glossary

| Term | Meaning |
|---|---|
| **Atlas** | MongoDB's cloud service that runs the database for us |
| **Cluster / M0** | The database server Atlas runs; M0 is the free size (512 MB) |
| **Collection** | Like a MySQL table |
| **Document** | Like a row: one JSON-like record |
| **Field** | Like a column |
| **ObjectId** | MongoDB's 24-character id; contains its creation time |
| **Reference** | One document storing another's `_id`; like a foreign key, but not checked by the database |
| **Embedded** | Data stored inside its parent document (e.g. the storyboard inside a plan version) |
| **Index** | A sorted lookup list that makes searches fast |
| **Unique / compound / partial / sparse / TTL index** | No duplicates / on several fields / only for documents matching a filter / skips documents where the field is **missing** (careful: a field set to `null` is still indexed, so `activeJobId: null` would be in a sparse index; a partial index is the precise tool) / deletes documents after a time (§1.5) |
| **Validator** | A rule MongoDB checks on every write to a collection |
| **Transaction** | Several writes that all happen or none happen |
| **Replica set** | Several copies of the database kept in sync; required for transactions; Atlas always uses one |
| **Conditional update** | "Change this only if it still looks like X" |
| **Optimistic concurrency / `stateVersion`** | A counter that detects "someone else changed this first" |
| **Insert-only / immutable** | Never edited after saving; changes create a new document |
| **Owner-scoped** | Every query is limited to the signed-in user's own data (`ownerId`) |
| **Soft delete** | Marked as archived, not actually deleted |
| **Hash / SHA-256** | A fingerprint of data: any change gives a different value. Used to prove "this is exactly what was approved" |
| **scrypt** | The slow one-way scramble used for passwords |
| **AES-256-GCM** | The encryption used for Instagram tokens |
| **Idempotency key** | A random id per button click so a repeated request does nothing twice |
| **R2 / presigned URL** | Cloudflare's file storage / a link to one private file that works for a short time |
| **Better Auth** | The login library; it owns `user`, `session`, `account`, `verification` |
| **Inngest** | The service that runs our background jobs step by step |
| **Atlas Data Explorer / Compass** | Ways to look at the data: in the browser / in a free desktop app |
| **`mongodump` / `mongorestore`** | Free MongoDB tools to copy a database to files and back |
| **DPDP Act** | India's Digital Personal Data Protection Act (privacy law) |

### 12.2 Differences from PRD §15
PRD §15 is an older short list. ARCHITECTURE §8 and API.md are the later, approved design, and this document follows them. To fix in the PRD later (the PRD is not edited here; API.md G-1 asks the same):

| # | PRD §15 says | This design (ARCHITECTURE / API) |
|---|---|---|
| 1 | `users` collection with an `allowListed` flag | Better Auth `user` (singular) plus `session`, `account`, `verification`; the invite list is a separate `allowlist` collection |
| 2 | `projects.inputType`, `inputText`, `status`, `currentStoryboardVersion`, `currentRenderVersion` | `input { type, text, brainstormChoice }`, `state`, `currentPlanVersionId`, `currentRenderId`; plus `approvedPlanVersionId`, `activeJobId`, `stateVersion`, `lastError`, `archivedAt`, `stateBeforeArchive` |
| 3 | `storyboards` (`version`, `source` `ai`/`revision`/`user_edit`, `approvedAt`) | `planVersions` (`versionNumber`, `source` `ai_plan`/`ai_revision`/`user_edit`/`caption_edit`, `planHash`, `validation`, `stats`, `parentVersionId`); approvals moved to their own `storyboardApprovals` collection |
| 4 | `revisions.resultVersion` | `basePlanVersionId` + `resultPlanVersionId`, `diff`, `assistantReply`, `jobId`; status adds `rejected` |
| 5 | `narrations` (per project, reused by `textHash`, `timestamps` stored inline) | `speechArtifacts`: reused per **owner** by `cacheKey`; timings are R2 files (`alignmentKey`) |
| 6 | `renders.version`, `storyboardVersion`, `startedAt`/`finishedAt` | `renderNumber`, `planVersionId` + `planHash`, `renderInputHash`, `mp4Sha256`, `speech[]`, `qa`, `metrics`, `captionOverrideSetId`, `readyAt` |
| 7 | `captionEdits` (`renderVersion`, `phraseIndex`, `text`) | `captionOverrides`: sets of `{ sceneId, phraseIndex, text }` tied to `basePlanVersionId` |
| 8 | `instagramConnections.userId`, `expiresAt` | `ownerId`, `tokenExpiresAt`, encrypted `accessToken {ciphertext, iv, tag, keyVersion}`, `accountType`, `scopes`, `lastRefreshedAt`; unique per user **and** per active Instagram account |
| 9 | `posts.renderVersion`, `status`, `approval { renderVersion, connectionId, approvedAt }`, `error` | `renderId`, `state`, `approval { id, renderId, mp4Sha256, connectionId, igUserId, captionHash, approvedBy, approvedAt }`, `publishKey`, `mode`, `lastError` |
| 10 | `providerUsage.userId`, `estCost`, `createdAt` | `ownerId`, `estCostInr`, `at`, plus `jobId` |
| 11 | `auditLogs.userId`, `createdAt` | `actorId`, `at` |
| 12 | (not listed) | `jobs`, `storyboardApprovals`, `publishAttempts`, `settings`, `notifications`, `deletionRequests`, `idempotencyKeys`, `rateLimits`, `usageCounters` |

### 12.3 Open questions (all decided 2026-11-13)
These were the gaps and contradictions in the source documents. **Decided 2026-11-13** (engineering decisions after the code review, following "keep it as simple as possible and protect money"), except **Q10, which waits for you**.

| # | Question | Decision |
|---|---|---|
| Q1 | Database name and dev/prod split (Atlas allows one free M0 per Atlas project) | **Decided 2026-11-13.** Development uses database **`bytereel`** on the one free M0 (also when running the app on your computer, §2.3). At **F38**, production gets a **second Atlas project with its own free M0** (no cost), so test data and real users' data never mix |
| Q2 | Collections named only in API.md had no field list | **Decided 2026-11-13.** Shapes defined in this document: `rateLimits` (4.6), `idempotencyKeys` (4.13), `usageCounters` (4.14), `notifications` (4.24), `deletionRequests` (4.25) |
| Q3 | Fields used by API.md but missing from ARCHITECTURE §8 | **Decided 2026-11-13.** Copied into ARCHITECTURE §8, so ARCHITECTURE, API.md and this document match |
| Q4 | `planVersions.stats` names | **Decided 2026-11-13.** The code's names: `sceneCount`, `wordCount`, `estimatedSeconds` (`PlanStats`, `packages/pipeline/src/planning/semantic-validation.ts`). ARCHITECTURE §8.4 fixed |
| Q5 | One-live-post index | **Decided 2026-11-13.** Covers `scheduled`, `publishing` **and `outcome_unknown`** (API A-14). ARCHITECTURE §8.12 fixed |
| Q6 | Job `idempotencyKey` formats | **Decided 2026-11-13.** `plan:{projectId}:{inputHash}`, `rev:{revisionId}`, `gen:{planVersionId}`, `cap:{captionOverrideSetId}`, `pubjob:{postId}`. The key is **required** on every job (4.9) |
| Q7 | Where the per-project and per-user limits are counted | **Decided 2026-11-13.** The 20 plan + revision requests: `projects.planRequestCount`, increased in the same transaction and only if below the limit. Per-user daily/monthly counts (projects, videos, voice characters): `usageCounters`. **Counting starts in F12. Enforcement: projects/day since F12 (F12 review, protects the paid storyboard calls); the other limits in F27** |
| Q8 | Indexes not defined in the docs | **Decided 2026-11-13.** The list in §8: required Better Auth indexes, partial unique `deletionRequests.confirmationCode`, `notifications { ownerId: 1, createdAt: -1 }`, `publishAttempts { postId: 1 }`, plus the `rateLimits`/`idempotencyKeys`/`usageCounters` indexes. **No** extra indexes on `captionOverrides` or `auditLogs`; the sparse `activeJobId` index is dropped |
| Q9 | Database validators | **Decided 2026-11-13.** A **minimal** validator: on owner-scoped collections, only `ownerId` (ObjectId) and `schemaVersion` are required (`idempotencyKeys`, `usageCounters`: `ownerId` only). Zod in our code is the real check (§1.4) |
| Q10 | **Account deletion details** | **Decided by the founder, 2026-11-13.** 30-day soft delete (account hidden and restorable by an admin), Instagram data deleted right away, then personal data erased and one anonymous `deletionLog` entry kept forever (rounded months and cost range, random id). `providerUsage` and `auditLogs` anonymized, `allowlist` entry deleted. See 6.7 and 4.26 |
| Q11 | An event lost after commit leaves a job `queued` forever | **Decided 2026-11-13.** The stuck-job sweeper also **re-sends the event for `queued` jobs older than ~2 minutes**. The event id is the job's key, so Inngest drops a duplicate if the first send did arrive. ARCHITECTURE §13.1/§20.3 updated |
| Q12 | Are G3 (connect Instagram) and J1 (Meta deauthorize) transactions? | **Decided 2026-11-13.** Yes, both (§7.2 rows 13 and 15) |
| Q13 | `rateLimits` name and method | **Decided 2026-11-13.** Our own `rateLimits` collection with **fixed windows** for **all** limits, including login and sign-up. Better Auth's built-in limiter is **off** (it counts in server memory, useless on serverless). ARCHITECTURE §21.2 ("token bucket") fixed |
| Q14 | `allowlist.invitedBy` for your own email in F07 | **Decided 2026-11-13.** `invitedBy: null`, `note: "added by setup command"` |
| Q15 | Reset tokens are plain text in `verification.identifier` for up to 1 hour | **Decided 2026-11-13.** Accepted for the beta: links are one-time, last 1 hour, and only admins create them; the TTL index deletes expired ones. Same caution as the plain-text **session tokens** (4.2): database read access must be protected. Revisit at public launch |
| Q16 | `healthchecks` after F06 | **Decided 2026-11-13.** Dropped at the end of F06 (after you've seen the test record in Atlas). Later health checks use `db.command({ ping: 1 })`, which writes nothing |
| Q17 | Better Auth housekeeping fields | **Decided 2026-11-13.** Filled in from Better Auth's documented core schema (4.1–4.4). **Confirmed in F08 (2026-11-13, Better Auth 1.7.14):** the fields match 4.1–4.3 (only difference: `user.image` is missing rather than `null`); `userId` is an **ObjectId** in `session` and `account`; `accountId` is a string; the adapter creates no indexes, ours are the only ones |

**Q10 — decided (2026-11-13).** The founder wants to keep records of deleted accounts. Final rule (6.7): a 30-day soft delete, then personal data is erased and an anonymous `deletionLog` entry (4.26) is kept forever. Keeping the personal data itself was ruled out because the DPDP Act requires erasure on request and Meta requires deleting Instagram data.

**Open items for later features (not questions for now)**
- **F30/F31:** check the Inngest free plan's maximum sleep for posts scheduled up to 75 days ahead; fallback: a small cron that uses the `posts { state, scheduledAt }` index (4.22).
- **F05:** read the current M0 limits (connections, operations per second, data transfer) on Atlas (§9), and choose the Atlas region together with the Vercel function region (§2.1).
