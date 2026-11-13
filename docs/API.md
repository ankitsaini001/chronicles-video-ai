# ByteReel — HTTP API Contract (V1)

| | |
|---|---|
| **Version** | 1.0 · 2026-11-12 |
| **Status** | Draft for founder review |
| **Inputs** | [`PRD.md`](../PRD.md) v1.0 FINAL (decisions log incl. #25) · [`ARCHITECTURE.md`](ARCHITECTURE.md) v1.1 (approved) · [`PIPELINE_DESIGN.md`](PIPELINE_DESIGN.md) v1.0 · code contracts `packages/pipeline/src/contracts/*.ts`, `packages/pipeline/src/planning/planner-output.ts`, `packages/pipeline/src/planning/component-catalog.ts`, `packages/pipeline/src/planning/icon-catalog.ts` |
| **Machine-readable spec** | [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1): same endpoints, schemas and examples |
| **Companion** | [`DATABASE.md`](DATABASE.md): collections, validators, indexes, transactions |

> **Decision applied (PRD decisions log #22, 2026-11-12):** all application mutations and reads are **REST JSON route handlers under `/api/v1`** (not Next.js Server Actions), so the API is described by OpenAPI and can be tested with any HTTP client. **Better Auth** stays mounted at **`/api/auth/*`**. CSRF protection = **SameSite=Lax session cookie + an `Origin` check on every mutating request** (§3.6).

---

## Table of Contents
1. Overview
2. Conventions
3. Authentication, sessions and CSRF (complete flows)
4. Errors (envelope, code table, user-facing messages)
5. Pagination
6. Idempotency
7. Version conflicts (optimistic concurrency)
8. Asynchronous jobs and polling
9. Approval semantics
10. Quotas, rate limits and spend ceilings
11. Resource shapes
12. Endpoint index
13. Screen → endpoints map
14. Endpoints in detail
15. Internal and conditional endpoints
16. Open questions / assumptions

---

## 1. Overview

| Item | Value |
|---|---|
| Base URL (app API) | `https://<app-domain>/api/v1` (local: `http://localhost:3000/api/v1`) |
| Base URL (auth) | `https://<app-domain>/api/auth` (Better Auth handler) |
| Format | JSON (`application/json; charset=utf-8`) in and out. Two exceptions: the Meta callbacks receive `application/x-www-form-urlencoded`, and the Instagram connect/callback endpoints answer with `302` redirects |
| Runtime | Next.js App Router route handlers (Node.js runtime) on Vercel |
| Request pipeline (every endpoint) | request id → Origin check (mutations) → session (`requireUser` / `requireAdmin`) → rate limit → Zod validation → owner check → domain service (`packages/core`) → JSON response |
| Slow work | Never done in the request. The endpoint writes MongoDB records, sends an Inngest event and answers **`202 Accepted`** with a **job** object (§8) |
| Ownership | Every creator endpoint is scoped to the signed-in user. Another user's resource is answered with **`404 NOT_FOUND`**, never `403` (ARCHITECTURE §10.3) |

**Endpoint groups:** Auth (Better Auth) · Account & settings · Projects & idea · Storyboard · Jobs · Video · Instagram · Publish · Notifications · Admin · Meta callbacks · Internal (Inngest).

---

## 2. Conventions

| Topic | Rule |
|---|---|
| Field names | **camelCase** everywhere (plan/scene fields are exactly the code contract names: `narration`, `objects`, `events`, `anchor.narrationId`, `voicePreset`, …). **Only exception:** the Meta data-deletion response uses Meta's required snake_case (`confirmation_code`) |
| IDs | Strings. Database IDs are MongoDB ObjectIds as **24 lowercase hex characters** (`"67330d5e9f1e4b2a7c0d2a10"`). Plan-internal IDs (`scene.id`, `narration[].id`, `objects[].id`, `events[].id`) are **SafeIds**: `^[a-z0-9][a-z0-9-]{0,63}$` (`packages/pipeline/src/contracts/common.ts`). An ObjectId hex string is also a valid SafeId, which is why `plan.projectId/ownerId/versionId` can hold the database IDs |
| Timestamps | ISO-8601 **UTC** with milliseconds and `Z`: `"2026-11-12T09:30:00.000Z"`. The UI converts to the user's timezone (default `Asia/Kolkata`). Request timestamps (e.g. `scheduledAt`) must include an offset or `Z` |
| Hashes | `"sha256:<64 lowercase hex>"` (`Sha256Schema`): `planHash`, `mp4Sha256`, `captionHash` |
| Enums | Lowercase snake_case for app enums (`storyboard_ready`), the exact code enums for plan contracts (`"title-hook"`, `"indian-english-female"`), Meta's own values where they come from Meta (`BUSINESS`, `MEDIA_CREATOR`) |
| Nulls | Optional response fields are **present with `null`** rather than omitted (easier for the UI). Request bodies may omit optional fields. Exception: plan objects keep the contract rule that `icon` is **omitted** when absent |
| Unknown fields | Request bodies are **strict**: unknown keys → `400 INVALID_INPUT` (same as the Zod `strictObject` plan contracts) |
| Body size | Max **64 KB** per JSON request → `413 PAYLOAD_TOO_LARGE` |
| Strings | Trimmed and Unicode-NFC-normalized server side before length checks. Lengths are counted in characters (UTF-16 code units, as in Zod) |
| Request id | Every response carries `X-Request-Id`; error bodies repeat it as `requestId`. The client may send its own `X-Request-Id` (≤ 64 chars, `[A-Za-z0-9-]`) to trace a call |
| Success bodies | The resource itself (no `{ ok, data }` wrapper). Lists use `{ items, nextCursor }` (§5) |
| Status codes | `200` read/update, `201` created synchronously, `202` accepted for background work, `204` only for sign-out style calls with no body (none in `/api/v1`), `302` OAuth redirects |
| Caching | All `/api/v1` responses: `Cache-Control: no-store` (private data, presigned URLs) |
| Versioning | Breaking changes go to `/api/v2`. Additive changes (new optional fields, new enum values in responses) are allowed in v1; clients must ignore unknown response fields |

---

## 3. Authentication, Sessions and CSRF

### 3.1 Summary

| Item | V1 rule (ARCHITECTURE §10, decisions D1, D3) |
|---|---|
| Method | **Email + password** via Better Auth (`emailAndPassword.enabled = true`), MongoDB adapter. No social login |
| Who can sign up | Only emails on the **allow-list** (`allowlist` collection), checked in `databaseHooks.user.create.before` |
| Email sending | **None.** No verification email (`requireEmailVerification = false`; the allow-list replaces it), no self-service "forgot password" |
| Password reset | **Admin-issued one-time reset link**, valid **1 hour**, shown once to the admin, shared with the user directly (§3.5) |
| Session cookie | `better-auth.session_token` (in production served over HTTPS as `__Secure-better-auth.session_token`); **httpOnly, Secure, SameSite=Lax, Path=/** |
| Session lifetime | **30 days**, rolling: when a request arrives and the session is older than **1 day** since its last refresh (`updateAge`), `expiresAt` is pushed to now + 30 days |
| Session check cache | Better Auth cookie cache **off** in V1 (every request reads the `session` collection), so revocation (password change, suspension, account deletion) is immediate |
| Roles | `creator` (default) and `admin` (`user.role`). Admin endpoints check `role = admin` server side |
| Status | `active`, `suspended`, `deleting`. Only `active` users get a session; suspension and deletion revoke all sessions. **Every server-side session read also requires `status = active`** (F09: `apps/web/lib/auth/session.ts` treats any other status as signed out), so a session left over from before a status change is never honoured. The `/api/v1` pipeline does the same (F11: `apps/web/lib/api/v1.ts` + `server.ts` read the session through the same `toSessionUser`, so a non-active user gets `401 UNAUTHENTICATED`) |
| Password rules | **8–128 characters**, any characters (Unicode allowed; no composition rules), hashed with **scrypt** by Better Auth, never logged or returned. "Confirm password" is checked by the form only (the API receives one `password`) |
| Brute-force | Rate limits per IP and per email (§3.7); **10 consecutive failed logins → account locked for 15 minutes** |
| Enumeration | Login failures always answer *"Email or password is incorrect"*; lockout and rate-limit answers use one message that doesn't reveal whether the email exists. **Conscious exception (private beta): sign-up (A1) does tell the caller whether an email is not invited (`NOT_ALLOWLISTED`) or already registered (`USER_ALREADY_EXISTS`)**, so invited people get clear messages ("request access" / "log in instead"). This leaks only allow-list/account membership, never a password, and is protected by the sign-up rate limit (5 / 15 min per IP, §3.7). **The A2 account lock falls under the same exception (F09 review):** the lock lives on `user`, so an email without an account never locks; someone spreading attempts over several 15-minute windows sees `429` on the 11th attempt for a registered email but keeps getting `401` for an unknown one. Accepted for the private beta because sign-up already reveals registered emails more cheaply. Revisit when sign-up opens to the public: then the lock moves to a counter keyed by the hashed email (unknown emails lock too) and the A1 exception is removed |
| Exposed auth endpoints | **Only the 6 endpoints A1–A6** (§3.2) are reachable under `/api/auth/*`. Every other Better Auth default endpoint is **disabled** (Better Auth `disabledPaths`) **and** blocked by our route handler, which forwards only an allow-list of these 6 method + path pairs and answers `404` to anything else. Blocked examples: `update-user`, `delete-user`, `list-sessions`, `revoke-session(s)`, `revoke-other-sessions`, `change-email`, `request-password-reset` / `forget-password`, `send-verification-email`, `verify-email`, `link-social`, `list-accounts`, `unlink-account`. Our own `/api/v1` endpoints cover those needs (B2 profile/defaults, B3 delete account, I7 admin reset link) |
| Server-owned user fields | Every Better Auth `user.additionalFields` entry is declared with **`input: false`**: `role`, `status`, `failedLoginCount`, `lockedUntil`, `lastLoginAt`, and also `timezone`, `defaultLanguage`, `defaultVoiceGender` (defaults set by the server at sign-up, changed only through B2). A caller can therefore never set them through sign-up or any auth endpoint; a sign-up body that includes any of them is rejected with `400`, and the user is always created as `role: creator`, `status: active` |

### 3.2 Auth endpoints at a glance

| # | Method + path | Purpose | Auth |
|---|---|---|---|
| A1 | `POST /api/auth/sign-up/email` | Create an account (allow-list only) and sign in | anonymous |
| A2 | `POST /api/auth/sign-in/email` | Log in | anonymous |
| A3 | `POST /api/auth/sign-out` | Log out (this session) | session |
| A4 | `GET /api/auth/get-session` | Current session + user (used by the UI shell) | session (anonymous gets `null`) |
| A5 | `POST /api/auth/change-password` | Change password; revokes other sessions | session |
| A6 | `POST /api/auth/reset-password` | Set a new password with an admin-issued token | anonymous (token) |
| B1 | `GET /api/v1/me` | Current user profile, defaults, usage and alerts | creator |
| I7 | `POST /api/v1/admin/users/{userId}/password-reset-links` | Admin creates a one-time reset link | admin |

**Error body for `/api/auth/*`.** These endpoints are served by Better Auth, which answers errors with its own body **`{ "code": "…", "message": "…" }`** (no `error` wrapper, no `requestId`). Our hooks throw Better Auth `APIError`s with the codes below so the UI can map them. Everything under `/api/v1` uses our envelope (§4).

| Better Auth code | HTTP | When | Message shown |
|---|---|---|---|
| `NOT_ALLOWLISTED` | 403 | Sign-up email not on the allow-list | "ByteReel is in private beta — request access" (UI links to `/access-pending`) |
| `USER_ALREADY_EXISTS` | 422 | Sign-up with an email that already has an account | "An account with this email already exists. Log in instead." |
| `PASSWORD_TOO_SHORT` / `PASSWORD_TOO_LONG` | 400 | Password outside 8–128 | "Use 8 to 128 characters." |
| `INVALID_EMAIL` | 400 | Malformed email | "Enter a valid email address." |
| `INVALID_EMAIL_OR_PASSWORD` | 401 | Wrong email or password (or unknown email) | **"Email or password is incorrect"** |
| `TOO_MANY_ATTEMPTS` | 429 | IP/email rate limit hit **or** account locked; `Retry-After` header set | "Too many attempts. Please wait 15 minutes and try again." |
| `ACCOUNT_SUSPENDED` | 403 | Correct password but `status` is `suspended` or `deleting` (checked after the password, in Better Auth's `databaseHooks.session.create.before`, so no session is ever created for a non-active user) | "Your account is paused. Contact the ByteReel team." |
| `INVALID_PASSWORD` | 400 | Change password: current password wrong | "Your current password is incorrect." |
| `INVALID_TOKEN` | 400 | Reset token unknown, used or expired | "This reset link is invalid or has expired. Ask the ByteReel team for a new one." |
| `FORBIDDEN_ORIGIN` | 403 | Origin check failed (§3.6) | "Please reload the page and try again." |
| `INVALID_INPUT` | 400 | Body isn't JSON, or a sign-up body has a field other than `name`, `email`, `password` (e.g. `role`, `status`, `image`, `callbackURL`, `rememberMe`), or the name is empty / over 80 characters, or a sign-in body has a field other than `email`, `password`, `rememberMe` (boolean), or its password is empty / over 128 characters | "Something in the form isn't right. Please check it and try again." |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 64 KB | same as `INVALID_INPUT` |
| `NOT_FOUND` | 404 | Any `/api/auth/*` method + path that isn't one of A1–A6 (lockdown, §3.1) | — |
| `UNAUTHORIZED` | 401 | No/expired session on A5 (A3 sign-out answers `200` even without a session, F09) | redirect to `/login` |

### 3.3 Sign-up and login flows

```
Sign-up  /signup form (name, email, password, confirm)
  → POST /api/auth/sign-up/email
      hook: email lowercased → allowlist lookup → not found → 403 NOT_ALLOWLISTED → UI shows /access-pending
      ok: user {role: creator, status: active, timezone: Asia/Kolkata, defaults}, account {providerId: credential, password hash}
          allowlist.signedUpUserId set; session created; Set-Cookie → UI goes to /dashboard

Login    /login form (email, password)  ["Forgot your password? Contact the ByteReel team."]
  → POST /api/auth/sign-in/email
      rate limit (IP, email) → lockout check → password check → status check
      fail: failedLoginCount += 1 (10th failure sets lockedUntil = now + 15 min) → 401 generic message
      ok:   failedLoginCount = 0, lockedUntil = null, lastLoginAt = now; session; Set-Cookie → /dashboard

Logout   user menu → POST /api/auth/sign-out → session row deleted, cookie cleared → home page / (F09, founder's choice)
```

#### A1. `POST /api/auth/sign-up/email` — Create account
| | |
|---|---|
| Auth | anonymous (must pass the Origin check) |
| Rate limit | 5 requests / 15 min per IP |
| Body | `name` string 1–80 (required) · `email` string, valid email, ≤ 254, lowercased (required) · `password` string 8–128 (required). `callbackURL`, `image`, `rememberMe` and the server-owned fields (`role`, `status`, …, §3.1) are **not accepted** |
| Success | `200` `{ token, user }` + `Set-Cookie` (session). `user` = Better Auth user incl. our additional fields |
| Errors | `NOT_ALLOWLISTED` 403 · `USER_ALREADY_EXISTS` 422 · `PASSWORD_TOO_SHORT`/`PASSWORD_TOO_LONG`/`INVALID_EMAIL`/`INVALID_INPUT` 400 · `PAYLOAD_TOO_LARGE` 413 · `TOO_MANY_ATTEMPTS` 429 · `FORBIDDEN_ORIGIN` 403 |
| Order of checks (F08) | 404 if not A1–A6 → Origin → JSON content type → rate limit → body check → Better Auth (allow-list hook). Our route handler (`apps/web/lib/auth/handler.ts`) runs everything before Better Auth and passes it only the cleaned `name` (trimmed), `email` (trimmed, lowercased) and `password`. Better Auth's own duplicate-email code (`USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`) is renamed to `USER_ALREADY_EXISTS` |

```http
POST /api/auth/sign-up/email
Origin: https://bytereel.app
Content-Type: application/json

{ "name": "Ananya Iyer", "email": "ananya.iyer@example.in", "password": "Chai-and-Physics-2026" }
```
```json
{
  "token": "Qm9yZWVsU2Vzc2lvbl9leGFtcGxl",
  "user": {
    "id": "67330c1a9f1e4b2a7c0d1e01",
    "name": "Ananya Iyer",
    "email": "ananya.iyer@example.in",
    "emailVerified": false,
    "role": "creator",
    "status": "active",
    "timezone": "Asia/Kolkata",
    "defaultLanguage": "en",
    "defaultVoiceGender": "female",
    "createdAt": "2026-11-12T04:30:00.000Z",
    "updatedAt": "2026-11-12T04:30:00.000Z"
  }
}
```
```
Set-Cookie: __Secure-better-auth.session_token=Qm9yZWVsU2Vzc2lvbl9leGFtcGxl.sig; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000
```
Error (email not on the allow-list):
```json
{ "code": "NOT_ALLOWLISTED", "message": "ByteReel is in private beta — request access" }
```

#### A2. `POST /api/auth/sign-in/email` — Log in
| | |
|---|---|
| Auth | anonymous (Origin check) |
| Rate limit | 5 attempts / 15 min **per IP** and 5 / 15 min **per email**; lockout after **10 consecutive failures** for 15 min |
| Body | `email` string (required) · `password` string 1–128 (required) · `rememberMe` boolean (optional; accepted but dropped before Better Auth, sessions are always 30 days). Anything else (`callbackURL`, `role`, …) → `400 INVALID_INPUT` |
| Success | `200` `{ redirect: false, token, user }` + `Set-Cookie`. Sets `failedLoginCount = 0`, `lockedUntil = null`, `lastLoginAt = now` |
| Errors | `INVALID_EMAIL_OR_PASSWORD` 401 · `TOO_MANY_ATTEMPTS` 429 (+ `Retry-After`: seconds left in the window, or on the lock) · `ACCOUNT_SUSPENDED` 403 · `FORBIDDEN_ORIGIN` 403 · `INVALID_EMAIL` / `INVALID_INPUT` 400 · `PAYLOAD_TOO_LARGE` 413 |
| Order of checks (F09) | 404 if not A1–A6 → Origin → JSON content type → IP limit → body (≤ 64 KB, strict) → email limit → account lock → Better Auth (password, then status). All in `apps/web/lib/auth/handler.ts` except the status check (`create-auth.ts`, session hook). Better Auth's 401 is answered with our message and counted on the account (`recordFailedLogin`, one atomic update; an unknown email stores nothing) |

```http
POST /api/auth/sign-in/email
Origin: https://bytereel.app
Content-Type: application/json

{ "email": "ananya.iyer@example.in", "password": "Chai-and-Physics-2026" }
```
```json
{
  "redirect": false,
  "token": "Qm9yZWVsU2Vzc2lvbl9leGFtcGxl",
  "user": { "id": "67330c1a9f1e4b2a7c0d1e01", "name": "Ananya Iyer", "email": "ananya.iyer@example.in", "role": "creator", "status": "active" }
}
```
Errors:
```json
{ "code": "INVALID_EMAIL_OR_PASSWORD", "message": "Email or password is incorrect" }
```
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 900

{ "code": "TOO_MANY_ATTEMPTS", "message": "Too many attempts. Please wait 15 minutes and try again." }
```

#### A3. `POST /api/auth/sign-out` — Log out
| | |
|---|---|
| Auth | session · Origin check |
| Body | none (`{}` accepted) |
| Success | `200` `{ "success": true }`; the session row is deleted and the cookie is cleared (`Max-Age=0`) |
| Errors | `FORBIDDEN_ORIGIN` 403. Without a session Better Auth 1.7.14 still answers `200 { success: true }` and clears the cookie (confirmed in F09). The UI goes to the home page `/` afterwards |

```json
{ "success": true }
```

#### A4. `GET /api/auth/get-session` — Current session
| | |
|---|---|
| Auth | session cookie; anonymous callers get `200 null` |
| Rate limit | 120 / min per IP |
| Success | `200` `{ session, user }` or `null`. Calling it refreshes the rolling expiry when due (§3.1) |

```json
{
  "session": { "id": "67330c1b9f1e4b2a7c0d1f01", "userId": "67330c1a9f1e4b2a7c0d1e01", "expiresAt": "2026-12-12T04:30:00.000Z", "createdAt": "2026-11-12T04:30:00.000Z", "updatedAt": "2026-11-12T04:30:00.000Z" },
  "user": { "id": "67330c1a9f1e4b2a7c0d1e01", "name": "Ananya Iyer", "email": "ananya.iyer@example.in", "role": "creator", "status": "active", "timezone": "Asia/Kolkata" }
}
```
The UI shell uses A4 for "am I logged in?" and **`GET /api/v1/me` (B1)** for everything it renders (usage, Instagram status, unread notifications).

#### A5. `POST /api/auth/change-password` — Change password
| | |
|---|---|
| Auth | session · Origin check |
| Rate limit | 5 / 15 min per user |
| Body | `currentPassword` string (required) · `newPassword` string 8–128 (required) · `revokeOtherSessions` boolean — **forced to `true` server side** (ARCHITECTURE §10.1) |
| Success | `200` `{ token, user }`: the current session stays valid (new token in `Set-Cookie`), **all other sessions are deleted** |
| Errors | `INVALID_PASSWORD` 400 · `PASSWORD_TOO_SHORT`/`PASSWORD_TOO_LONG` 400 · `TOO_MANY_ATTEMPTS` 429 · `UNAUTHORIZED` 401 · `FORBIDDEN_ORIGIN` 403 |

```json
{ "currentPassword": "Chai-and-Physics-2026", "newPassword": "Monsoon-Maths-Notes-77", "revokeOtherSessions": true }
```
```json
{ "token": "TmV3U2Vzc2lvblRva2Vu", "user": { "id": "67330c1a9f1e4b2a7c0d1e01", "email": "ananya.iyer@example.in" } }
```
```json
{ "code": "INVALID_PASSWORD", "message": "Your current password is incorrect." }
```

### 3.4 Current user

`GET /api/v1/me` (B1) returns the profile and everything the header needs; `PATCH /api/v1/me` (B2) changes defaults. See §14.2.

### 3.5 Admin-issued one-time reset link (no email in V1)

```
1. User: "I forgot my password" → contacts the ByteReel team (WhatsApp/phone, outside the app).
2. Admin: /admin → Users → user → "Create reset link"
      → POST /api/v1/admin/users/{userId}/password-reset-links          (I7, admin)
      server: token = 32 random bytes (base64url); verification row
              { identifier: "reset-password:<token>", value: userId, expiresAt: now + 1 h }
              any older unused reset rows for this user are deleted (only one live link)
              audit log "user.password_reset_link_created" (token NOT logged)
      → 201 { url: "https://bytereel.app/reset-password?token=<token>", expiresAt }   ← shown ONCE
3. Admin shares the URL with the user directly.
4. User opens /reset-password?token=… → form: new password + confirm
      → POST /api/auth/reset-password { token, newPassword }             (A6)
      server: verification row found & not expired → account.password = scrypt(newPassword)
              verification row deleted (one-time) → ALL sessions of the user deleted
              failedLoginCount = 0, lockedUntil = null; audit log "user.password_reset"
      → 200 { status: true } → UI shows "Password updated" → /login
5. A second use of the same link → 400 INVALID_TOKEN. After 1 hour → 400 INVALID_TOKEN.
```

#### A6. `POST /api/auth/reset-password` — Set a new password with a reset token
| | |
|---|---|
| Auth | anonymous; the token is the credential · Origin check |
| Rate limit | 5 / 15 min per IP |
| Body | `token` string 20–128 (required) · `newPassword` string 8–128 (required) |
| Success | `200` `{ "status": true }`; all sessions of that user revoked; the user logs in again |
| Errors | `INVALID_TOKEN` 400 · `PASSWORD_TOO_SHORT`/`PASSWORD_TOO_LONG` 400 · `TOO_MANY_ATTEMPTS` 429 · `FORBIDDEN_ORIGIN` 403 |

```json
{ "token": "x7Qp2sVb9LmN4cRt8wYz1aBcDeFgHiJk3LmNoPqRsTu", "newPassword": "Monsoon-Maths-Notes-77" }
```
```json
{ "status": true }
```
```json
{ "code": "INVALID_TOKEN", "message": "This reset link is invalid or has expired. Ask the ByteReel team for a new one." }
```

### 3.6 CSRF / Origin rule

| Rule | Detail |
|---|---|
| Cookie | Session cookie is **SameSite=Lax**: browsers don't send it on cross-site `POST/PUT/PATCH/DELETE` sub-requests |
| Origin check | Every **mutating** request (`POST`, `PUT`, `PATCH`, `DELETE`) to `/api/v1/*` **and** `/api/auth/*` must carry an `Origin` header equal to the app origin: the origin of `BETTER_AUTH_URL` (`http://localhost:3000` on your computer, the real domain in production; preview URLs are set in F38. `NEXT_PUBLIC_APP_URL`, once added, must hold the same value). If `Origin` is missing, `Sec-Fetch-Site: same-origin` is accepted instead; otherwise the request is rejected **before** any work: `/api/v1` → `403 FORBIDDEN` with `details.reason = "origin_mismatch"`; `/api/auth` → `403 FORBIDDEN_ORIGIN`, checked by our route handler (F08). Better Auth's `trustedOrigins` is set to the same origin as a second layer, but on its own it checks the Origin only when a cookie or fetch-metadata header is present, so it would let a cookie-less cross-site sign-up through |
| Content type | JSON endpoints require `Content-Type: application/json` (`415`-style rejection reported as `400 INVALID_INPUT`), so a plain HTML form can't post to them |
| Exempt | The Meta callbacks (`/api/v1/meta/*`, verified by HMAC `signed_request`) and the internal Inngest endpoint (`/api/inngest`, verified by the Inngest signing key) |
| GET never mutates | Except the Instagram OAuth pair: `GET /instagram/connect` only creates a **signed, session-bound `state`** (nothing stored) and `GET /instagram/callback` only acts when that `state` matches the current session (this is the OAuth CSRF protection) |

```json
{ "error": { "code": "FORBIDDEN", "message": "Please reload the page and try again.", "details": { "reason": "origin_mismatch" }, "requestId": "req_01JCXK6S8Q2V" } }
```

### 3.7 Auth rate limits and lockout

| Endpoint | Limit | Key | Over the limit |
|---|---|---|---|
| A1 sign-up | 5 / 15 min | IP | `429 TOO_MANY_ATTEMPTS` + `Retry-After` |
| A2 sign-in | 5 / 15 min | IP **and** lowercased email (both checked) | same |
| A2 lockout | 10 consecutive failures → `lockedUntil = now + 15 min` (F09: every 10th failure in a row, i.e. 10, 20, …; the count resets only on a successful login) | user | same `429 TOO_MANY_ATTEMPTS` (same message as the rate limit, so it doesn't reveal that the email exists) |
| A5 change password | 5 / 15 min | user | same |
| A6 reset password | 5 / 15 min | IP | same |
| A4 get-session | 120 / min | IP | same |

Counters live in the `rateLimits` collection (fixed windows, TTL-expired). `failedLoginCount` / `lockedUntil` live on `user`. **IP** = the address Vercel writes in `X-Forwarded-For`; outside Vercel that header can be faked, so all requests share one counter (DATABASE.md §4.6). F08 enforces the A1 limit, F09 the A2 limits, the lockout and the A4 limit; the A5/A6 limits come with F33 (settings) and F35 (reset link). Off Vercel, everyone shares one IP counter, so on your computer 5 log-in attempts per 15 minutes is the total for all users.

**Known trade-offs (accepted for the invite-only beta, F09 review):**
- The lock is stored on `user`, so it can tell a registered email from an unknown one across windows (see §3.1 Enumeration, same exception as A1). When sign-up opens to the public, the lock moves to a counter keyed by the hashed email.
- The per-email limit (5 / 15 min) lets anyone who knows an email keep that user out for 15 minutes at a time (and 10 wrong passwords lock the account for 15 minutes). Required by this table; acceptable while the user list is small and invited.

### 3.8 Unauthenticated / unauthorized on `/api/v1`

| Situation | Answer |
|---|---|
| No cookie / expired session | `401 UNAUTHENTICATED` → the UI redirects to `/login?next=<path>` |
| Session of a suspended/deleting user | Sessions are deleted at suspension/deletion, so this is also `401 UNAUTHENTICATED` |
| Creator calls an admin endpoint | `403 FORBIDDEN` |
| Resource of another user | `404 NOT_FOUND` |

```json
{ "error": { "code": "UNAUTHENTICATED", "message": "Please log in again.", "requestId": "req_01JCXK70B4M2" } }
```

---

## 4. Errors

### 4.1 Envelope (all `/api/v1` errors)

```json
{
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "You've reached today's limit of 3 videos. Try again tomorrow.",
    "details": { "quota": "videos_per_day", "limit": 3, "used": 3, "resetsAt": "2026-11-12T18:30:00.000Z" },
    "requestId": "req_01JCXK8M3T7A"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `code` | string (enum below) | Stable, machine-readable. The UI maps codes to screens/buttons |
| `message` | string | Plain-language, safe to show as is (never contains stack traces, provider bodies or secrets) |
| `details` | object, optional | Code-specific: `issues[]` for `INVALID_INPUT`/`PLAN_INVALID`, `currentStateVersion` for `STALE_VERSION`, `resetsAt` for quotas, `retryAfterSeconds` for rate limits, `reason` for `FORBIDDEN` |
| `requestId` | string | Same as the `X-Request-Id` header; quote it in support messages and Sentry |

`INVALID_INPUT` details: `{ "issues": [ { "path": "text", "message": "must be at most 300 characters" } ] }` (Zod issues, path in dot/bracket notation like the plan validator).

### 4.2 Error code → HTTP status

Codes marked **§12.4** came from the error list that used to be ARCHITECTURE §12.4; the others were added for the REST API. That ARCHITECTURE list was removed (ARCHITECTURE §12 now points here), so **this table is the only error list**. The marker only records where a code came from.

| Code | HTTP | Meaning | Typical endpoints |
|---|---|---|---|
| `UNAUTHENTICATED` **§12.4** | 401 | No valid session | all creator/admin endpoints |
| `FORBIDDEN` | 403 | Not allowed: not an admin, or Origin check failed (`details.reason`: `admin_only`, `origin_mismatch`) | admin, all mutations |
| `NOT_FOUND` **§12.4** | 404 | Doesn't exist **or belongs to another user** | any `{id}` path |
| `INVALID_INPUT` **§12.4** | 400 | Validation failed (body, query, headers, missing `Idempotency-Key`, wrong content type) | all |
| `PAYLOAD_TOO_LARGE` | 413 | Body > 64 KB | all bodies |
| `PLAN_INVALID` | 422 | The plan version fails plan validation (schema + semantic rules); `details.issues[]` are `ValidationIssue`s. Also the job error when the AI can't produce a valid plan after the repair | D8 approve; plan/revise jobs |
| `STALE_VERSION` **§12.4** | 409 | `expectedStateVersion` / `If-Match` doesn't match (another tab changed the project) | project mutations |
| `INVALID_STATE` | 409 | The action isn't allowed in the current state (e.g. editing captions while generating, archiving while publishing) | most mutations |
| `ALREADY_EXISTS` | 409 | Unique value already present (allow-list email) | I2 |
| `JOB_ALREADY_RUNNING` **§12.4** | 409 | The project already has an active pipeline job (`activeJobId`) | C2… D3–D8, F4 |
| `APPROVAL_REQUIRED` **§12.4** | 409 | Generation/publish asked without the needed approval | E2 (generate retry after the plan changed) |
| `APPROVAL_STALE` **§12.4** | 409 | The approval doesn't match current data: `planVersionId` not current / `planHash` differs; or publish `renderId` not current / `mp4Sha256` differs / connection changed | D8, H2, H6 |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same `Idempotency-Key` with a different request body/path | idempotent endpoints |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | The first request with this key is still being processed; retry in a moment | idempotent endpoints |
| `QUOTA_EXCEEDED` **§12.4** | 429 | A per-user product limit (videos/day, projects/day, revisions/project); `details.resetsAt` when it resets (null if it never resets, e.g. per-project revisions). Caption fixes (F4) never return it (decision #24a) | C2, D5, D8 |
| `RATE_LIMITED` | 429 | Too many requests in a short window; `Retry-After` header + `details.retryAfterSeconds` | all |
| `SPEND_CEILING` **§12.4** | 503 | A global provider spend ceiling was reached; new generations are paused, existing videos stay available | C2, D5, D8, F4, C7, H1 |
| `MAINTENANCE` | 503 | Admin turned on maintenance mode; reads still work | all mutations except admin |
| `PROVIDER_BUSY` **§12.4** | 503 | Gemini (or ElevenLabs) stayed busy after the allowed retries. Sync endpoints return it directly; jobs store it as their error | C7, H1; plan/revise/generate jobs |
| `PROVIDER_REJECTED` **§12.4** | 422 | The provider refused the content (safety) | C7, H1; plan/revise jobs |
| `PROVIDER_UNAVAILABLE` | 503 | Provider auth/quota/voice error (ElevenLabs 401/402/quota, unknown voice). Admin is alerted | generate job (job error only) |
| `NEEDS_INPUT` **§12.4** | — (job/project only) | The pipeline needs a creator change (duration outside 60–90 s, uncertain alignment, ambiguous revision). Never an HTTP error; appears in `job.needsInput` and `project.lastError` | generate/revise jobs |
| `RENDER_FAILED` | — (job only) | Rendering or MP4 validation failed after the automatic retry | generate/caption jobs |
| `CANCELLED` | — (job only) | The job was cancelled by the creator | all jobs |
| `INSTAGRAM_NOT_CONNECTED` **§12.4** | 409 | No active Instagram connection (or `connectionId` isn't yours/active) | H2, H6 |
| `INSTAGRAM_TOKEN_EXPIRED` **§12.4** | 409 | Connection `expired`/`revoked`: reconnect needed | H2, H6; publish job |
| `INSTAGRAM_ACCOUNT_INELIGIBLE` **§12.4** | 422 | Account isn't Business/Creator. Delivered as a redirect query on the OAuth callback | G3 |
| `INSTAGRAM_ACCOUNT_IN_USE` | — (redirect only) | The Instagram account (`igUserId`) already has an **active** connection owned by a **different** ByteReel user (one Instagram account per ByteReel user, both ways; PRD decision #24d). Delivered as a redirect query on the OAuth callback | G3 |
| `INSTAGRAM_OAUTH_FAILED` | — (redirect only) | OAuth denied, bad `state`, or code exchange failed | G3 |
| `PUBLISH_LIMIT_REACHED` **§12.4** | — (post/job only) | Instagram's 24 h publishing limit; the post is **delayed**, never dropped | publish job |
| `PUBLISH_FAILED` | — (post/job only) | Container `ERROR`/`EXPIRED` or Meta error; `message` carries Meta's reason in plain words | publish job |
| `INVALID_SIGNATURE` | 400 | Meta `signed_request` HMAC check failed | J1, J2 |
| `INTERNAL` **§12.4** | 500 | Unexpected error (Sentry has the details) | all |

### 4.3 User-facing messages (default text; the UI may localize)

| Code / situation | Message | Button |
|---|---|---|
| `PROVIDER_BUSY` (Gemini, ARCHITECTURE §16.1) | **"Our AI is very busy right now. Your idea is saved; please try again in a few minutes."** | **Try again** (`E2` retry, or re-send for C7/H1) |
| `PROVIDER_BUSY` (ElevenLabs) | "Voice service busy. Please try again in a few minutes." | Retry |
| `PROVIDER_REJECTED` | "We can't make a video about this topic." | Edit idea (C4 with `text`, then E2) |
| `PROVIDER_UNAVAILABLE` | "Voice service unavailable right now. We've been notified." | — |
| `PLAN_INVALID` (job) | "Couldn't build a good storyboard, try rephrasing." | Edit idea (C4 with `text`, then E2) / Try again (E2) |
| `PLAN_INVALID` (approve) | "Some scenes need fixing before you can approve." + issues per scene | — |
| `NEEDS_INPUT` (duration) | "Your script is about 98 seconds; videos must be 60–90 s. Try 'make it shorter'." | Revise |
| `NEEDS_INPUT` (alignment) | "Please adjust the wording in scene 3." | Edit scene |
| `RENDER_FAILED` | "Rendering failed. Your narration is saved, so retrying is quick." | Retry |
| `QUOTA_EXCEEDED` | "You've reached today's limit, try again tomorrow." (with the reset time in the user's timezone) | — |
| `SPEND_CEILING` | "Video generation is paused for today. Your projects and videos are safe." | — |
| `STALE_VERSION` | "This project changed in another tab, refresh." | Refresh |
| `JOB_ALREADY_RUNNING` | "We're still working on the previous step." | — |
| `APPROVAL_STALE` | "Something changed since you reviewed it. Please review again." | Reload |
| `INSTAGRAM_TOKEN_EXPIRED` | "Instagram needs reconnecting. Your scheduled posts are paused, nothing is lost." | Reconnect |
| `INSTAGRAM_ACCOUNT_INELIGIBLE` | "This Instagram account is personal. Switch it to a Creator or Business account in Instagram settings, then connect again. Download still works." | Connect again |
| `INSTAGRAM_ACCOUNT_IN_USE` | "This Instagram account is already connected to another ByteReel account." | Connect again |
| `PUBLISH_LIMIT_REACHED` | "Instagram's daily posting limit was reached. We'll publish automatically when it resets." | — |
| Unknown publish outcome | "Checking whether your post went live…" | — |
| `INTERNAL` | "Something went wrong on our side. Please try again." | Retry |

---

## 5. Pagination

All list endpoints are **cursor-based**.

| Parameter | Where | Rule |
|---|---|---|
| `limit` | query | Integer 1–50, default **20** (admin lists: 1–100, default 50) |
| `cursor` | query | Opaque string from a previous `nextCursor`. Omit for the first page |
| `nextCursor` | response | String, or `null` when there are no more items |

Response shape: `{ "items": [ … ], "nextCursor": "eyJ1IjoiMjAyNi0xMS0xMlQwOTozMDowMC4wMDBaIiwiaSI6IjY3MzMwZDVlOWYxZTRiMmE3YzBkMmExMCJ9" }`.

- The cursor is base64url JSON of the sort key + `_id` (e.g. `{ u: updatedAt, i: _id }`); clients must not build or parse it. The server validates it; a tampered cursor → `400 INVALID_INPUT`.
- Sort orders are fixed per endpoint (stated in each section), always with `_id` as the tie-breaker, so pages never skip or repeat items while new items are added at the top.
- Filters (e.g. `tab`) must be the same on every page; changing them with an old cursor → `400 INVALID_INPUT`.

```json
{ "error": { "code": "INVALID_INPUT", "message": "The list cursor is invalid. Reload the list.", "details": { "issues": [ { "path": "cursor", "message": "invalid cursor" } ] }, "requestId": "req_01JCXKA2YH5D" } }
```

---

## 6. Idempotency

| Item | Rule |
|---|---|
| Header | `Idempotency-Key: <8–128 chars of [A-Za-z0-9_:-]>`, typically a UUID v4 created when the user clicks the button (re-used for automatic network retries of the same click) |
| Required on | Every endpoint that **starts a job or publishes**: C2 create project, D5 revision, D8 approve storyboard, F4 caption overrides, H2 publish/schedule, E2 job retry, H6 post retry, I9 admin job retry, B3 delete account. Missing → `400 INVALID_INPUT` |
| Scope | Per user (`ownerId` + key). Stored in `idempotencyKeys` for **24 hours** (TTL) |
| Fingerprint | `sha256(method + path + canonical JSON body)`. Same key + different fingerprint → `422 IDEMPOTENCY_KEY_REUSED` |
| Replay | Same key + same fingerprint after completion → the **original status code and body** are returned again, with header `Idempotent-Replayed: true`. No second job, no second post |
| Concurrent duplicate | While the first request is still running → `409 IDEMPOTENCY_IN_PROGRESS` (retry after ~1 s) |
| Failures | Responses with status ≥ 500 are **not** stored (the client may retry with the same key). 4xx responses are stored and replayed (a replayed error body carries the new request's `requestId`). Exception (F12): requests refused **before** the key is checked in (missing/bad `Idempotency-Key`, wrong `Content-Type`, `413`, invalid body) are not stored; a repeat simply gets the same answer again |
| Abandoned key | An `in_progress` record blocks repeats for ~60 s (`lockedUntil`); after that a repeat may run again (DATABASE.md §4.13). C2 saves its answer on the record inside the same transaction that creates the project, so a crash after the commit can't create a second project |
| Second layer | Domain keys make duplicates impossible even without the header: job keys `plan:{projectId}:{inputHash}`, `rev:{revisionId}`, `gen:{planVersionId}`, `cap:{captionOverrideSetId}`, `pubjob:{postId}`, `posts.publishKey` (`pub:{projectId}:{renderId}:{connectionId}:{approvalId}`), unique `storyboardApprovals.planVersionId` (ARCHITECTURE §20.1) |

```http
HTTP/1.1 202 Accepted
Idempotent-Replayed: true
```

---

## 7. Version Conflicts (optimistic concurrency)

| Item | Rule |
|---|---|
| Version field | `project.stateVersion` (integer, starts at 1, +1 on every project change) |
| How to send | Body field **`expectedStateVersion`** on project mutations, **or** header **`If-Match: "<stateVersion>"`** (needed for body-less calls such as `DELETE /projects/{id}`). If both are sent they must be equal |
| Required on | C4 rename / edit idea, C5 archive, D3 narration edit, D4 voice, D5 revision, D7 restore, D8 approve, F4 caption overrides, H2 publish/schedule |
| ETag | `GET /projects/{id}` and `GET /projects/{id}/status` return `ETag: "<stateVersion>"` |
| Mismatch | `409 STALE_VERSION` with `details.currentStateVersion`; nothing is changed. UI: "This project changed in another tab, refresh." |
| Admin settings | Same pattern with `settings.version` (`expectedVersion` in I12) |

```json
{ "error": { "code": "STALE_VERSION", "message": "This project changed in another tab, refresh.", "details": { "expectedStateVersion": 7, "currentStateVersion": 8 }, "requestId": "req_01JCXKB9W1QF" } }
```

---

## 8. Asynchronous Jobs and Polling

### 8.1 Pattern

1. A mutating call that needs slow work (plan, revise, generate, caption re-render, publish) answers **`202 Accepted`** with the affected resource **and a `job`**.
2. The UI polls **every 2 seconds** (decision D2) while a job is active, using either
   - `GET /api/v1/projects/{projectId}/status` (C6, preferred on project pages: one small call returns project state + active job), or
   - `GET /api/v1/jobs/{jobId}` (E1).
3. Polling stops when the response has `pollAfterMs: null` (no active job). Leaving the page is fine: work continues and the library shows the state badge.

### 8.2 Job shape

```json
{
  "id": "67330f109f1e4b2a7c0d3c03",
  "projectId": "67330d5e9f1e4b2a7c0d2a10",
  "type": "generate",
  "state": "running",
  "attempt": 1,
  "stages": [
    { "name": "approve", "status": "succeeded", "startedAt": "2026-11-12T05:40:01.000Z", "endedAt": "2026-11-12T05:40:01.200Z", "attempts": 1, "error": null },
    { "name": "speech", "status": "running", "startedAt": "2026-11-12T05:40:01.300Z", "endedAt": null, "attempts": 1, "error": null },
    { "name": "compile", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null },
    { "name": "render", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null },
    { "name": "validate", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }
  ],
  "progress": { "stage": "speech", "percent": 24, "message": "Recording narration · scene 3 of 6" },
  "error": null,
  "needsInput": null,
  "result": null,
  "cancelRequestedAt": null,
  "createdAt": "2026-11-12T05:40:00.000Z",
  "updatedAt": "2026-11-12T05:40:19.000Z",
  "startedAt": "2026-11-12T05:40:01.000Z",
  "finishedAt": null,
  "pollAfterMs": 2000
}
```

| Field | Type | Notes |
|---|---|---|
| `type` | `plan` \| `revise` \| `generate` \| `caption` \| `publish` | ARCHITECTURE §8.9 |
| `state` | `queued` \| `running` \| `succeeded` \| `failed` \| `needs_input` \| `cancelled` | ARCHITECTURE §7.3. **Terminal:** `succeeded`, `failed`, `needs_input`, `cancelled` |
| `attempt` | int ≥ 1 | +1 on each retry (E2/I9). A retry resumes: succeeded stages are skipped (`status: skipped` is never re-run work) |
| `stages[].status` | `pending` \| `running` \| `succeeded` \| `failed` \| `skipped` \| `cancelled` | Same enum as the pipeline (`STAGE_STATUSES` in `packages/pipeline/src/contracts/manifest.ts`) |
| `stages[].error` | `{ code, message }` \| null | |
| `progress` | `{ stage, percent 0–100, message }` | `message` is shown as is in the UI |
| `error` | `{ code, message, retryable: boolean }` \| null | Set when `state = failed` or `cancelled` (`CANCELLED`). `retryable = true` → show **Retry** |
| `needsInput` | `{ reason, message, sceneId }` \| null | Set when `state = needs_input`. `reason`: `duration_out_of_range` \| `alignment_uncertain` \| `clarification_needed` |
| `result` | `{ planVersionId?, renderId?, revisionId?, postId? }` \| null | Set on success (and `revisionId`/`postId` from the start for revise/publish jobs) |
| `pollAfterMs` | 2000 \| null | `null` once the job is terminal |

**Stages per job type** (stage names come from `STAGE_NAMES` in `packages/pipeline/src/contracts/manifest.ts`; publish stages mirror `publishAttempts.step`):

| Job type | Stages (in order) | Started by |
|---|---|---|
| `plan` | `plan` → `validate` | C2 create project, E2 retry |
| `revise` | `plan` → `validate` | D5 revision |
| `generate` | `approve` → `speech` → `compile` → `render` → `validate` | D8 approve storyboard |
| `caption` | `compile` → `render` → `validate` | F4 caption overrides |
| `publish` | `approve` → `create_container` → `poll` → `publish` (+ `reconcile` only when the outcome is unknown) | H2 publish now / schedule |

**UI step mapping (③ Generate, PRD §6.3):** `approve`+`speech` → *Recording narration*; `compile` → *Timing animations* then *Adding captions* (both ticked when `compile` succeeds; `progress.message` says which is running); `render`+`validate` → *Rendering*.

### 8.3 Terminal states and what the UI does

| Job state | Project effect | UI |
|---|---|---|
| `succeeded` | plan → `storyboard_ready`; revise → `storyboard_ready` (new current version); generate/caption → `video_ready` (new `currentRenderId`); publish → `published` | Show the result (storyboard, player, permalink) |
| `failed` | plan → `plan_failed`; revise → unchanged (base version kept; revision `failed`); generate/caption → `generate_failed` (caption: back to `video_ready`, old render kept); publish → `publish_failed` | `error.message` + **Retry** if `retryable` |
| `needs_input` | generate → `storyboard_ready` with `lastError.code = NEEDS_INPUT`; revise → unchanged, revision `rejected` with `assistantReply` (the follow-up question) | Show `needsInput.message` on the storyboard step (ARCHITECTURE §7.2) |
| `cancelled` | plan → `plan_failed` (`CANCELLED`); revise → unchanged; generate → `storyboard_ready` (approval kept; approving again resumes the same job); caption → `video_ready` | "Cancelled" |

`needs_input` example:
```json
{
  "id": "67330f109f1e4b2a7c0d3c03", "projectId": "67330d5e9f1e4b2a7c0d2a10", "type": "generate", "state": "needs_input", "attempt": 1,
  "stages": [ { "name": "compile", "status": "failed", "startedAt": "2026-11-12T05:41:10.000Z", "endedAt": "2026-11-12T05:41:10.400Z", "attempts": 1, "error": { "code": "NEEDS_INPUT", "message": "Total length 97.4 s is above 90 s" } } ],
  "progress": { "stage": "compile", "percent": 60, "message": "Checking video length" },
  "error": null,
  "needsInput": { "reason": "duration_out_of_range", "message": "Your narration runs about 97 seconds; videos must be 60–90 s. Try asking: \"make it shorter\".", "sceneId": null },
  "result": null, "cancelRequestedAt": null,
  "createdAt": "2026-11-12T05:40:00.000Z", "updatedAt": "2026-11-12T05:41:10.400Z", "startedAt": "2026-11-12T05:40:01.000Z", "finishedAt": "2026-11-12T05:41:10.400Z",
  "pollAfterMs": null
}
```
(The `stages` array is abbreviated here; real responses always list every stage of the job type.)

### 8.4 Retry and cancel
- **Retry** (`POST /jobs/{jobId}/retry`, E2): only for `failed` jobs with `error.retryable = true` (and `cancelled` plan/caption jobs). Same job id, `attempt + 1`, state → `queued`, completed stages are reused (no repeated paid calls). Retrying a generate job re-checks the storyboard approval: if the plan changed meanwhile → `409 APPROVAL_REQUIRED`.
- **Cancel** (`POST /jobs/{jobId}/cancel`, E3): for `queued`/`running` plan, revise, generate and caption jobs. Sets `cancelRequestedAt`, sends `job.cancelled`; the job stops between steps (an in-flight provider call finishes and its artifact is kept). Publish jobs are cancelled through the **post** (H5).

---

## 9. Approval Semantics

| Approval | Client sends | Server checks (all in one transaction) | Stored as | Invalidated by |
|---|---|---|---|---|
| **#1 Storyboard** (D8) | `planVersionId`, `planHash` (both from the plan version the user is looking at), `expectedStateVersion` | `planVersionId == project.currentPlanVersionId` · `planHash == planVersions.planHash` (canonical hash, `packages/pipeline/src/planning/plan-hash.ts`) · `validation.valid == true` · state `storyboard_ready`/`generate_failed` · no active job · quota/spend | `storyboardApprovals { planVersionId, planHash, approvedBy, approvedAt }` (immutable, unique per version) | Any new plan version (narration edit, voice change, revision, restore) → the new version has no approval |
| **#2 Publish** (H2) | `renderId`, `mp4Sha256`, `connectionId`, `caption`, `mode`, `scheduledAt?`, `expectedStateVersion` | `renderId == project.currentRenderId` and render `ready` · `mp4Sha256 == renders.mp4Sha256` · connection is the user's, `active`, token not expired · server computes `captionHash = sha256(NFC(caption))` · copies `igUserId` from the connection | `posts.approval { id, renderId, mp4Sha256, connectionId, igUserId, captionHash, approvedBy, approvedAt }` (`id` = a new approval id for every H2 call) | Any change the creator **requests** on the project: revision (storyboard or video stage, D5), narration edit (D3), voice switch (D4), restore/undo (D7), caption fix (F4); also a caption change, disconnect/reconnect/other account. The approval is cancelled **at the moment the change is requested**, in the same transaction, never later when the change's job finishes (PRD §7 hard rule). A `scheduled` **or `publish_failed`** post becomes `approval_invalidated` ("needs approval"; a failed post could otherwise be retried with H6/I9 on its old approval) and the creator gets an `approval_invalidated` notification |

- Approvals are created **only** by the signed-in creator through these two endpoints. Jobs, admins and the model can never create them (ARCHITECTURE §18).
- The publish job re-checks the approval **immediately before container creation and before `media_publish`**, with conditional updates on the post's `state` (`scheduled` → `publishing`; the post's `state` is the real guard, because every change above moves it away from `scheduled`/`publish_failed` in the same transaction). The **full re-check** (also used by H6 and I9) is: the post is still in the expected state · `renderId == project.currentRenderId`, render `ready`, same `mp4Sha256` · the project's `currentPlanVersionId` and `approvedPlanVersionId` both still equal that render's `planVersionId` (nothing was edited since) · the project is **not archived** · the owner's `user.status` is **`active`** · the connection is the approved `connectionId`, `active`, token not expired, same `igUserId`. Anything different → no publish (`APPROVAL_STALE`, or `INSTAGRAM_*` for the connection).
- The UI must show exactly what is approved: thumbnail, duration, caption, `@username` next to the button.

---

## 10. Quotas, Rate Limits and Spend Ceilings

### 10.1 Product quotas (per user; ARCHITECTURE §23, decision D8)

| Quota | Default | Counted when | Resets | Error |
|---|---|---|---|---|
| **Videos per user per day** | **3** | A `generate` job is **accepted** (D8). Caption fixes (F4) **don't count** (decision #24). Retries of the same job and reuse of an identical render don't count | 00:00 in the user's timezone (`resetsAt` in UTC) | `429 QUOTA_EXCEEDED` (`quota: videos_per_day`) |
| Projects created per user per day | 5 | C2 accepted. Editing the idea of a `plan_failed` project (C4) and trying again (E2) doesn't count. **Counted and enforced since F12** (inside C2's transaction, so concurrent clicks can't pass 5) | same | `quota: projects_per_day` |
| Plan + revision requests per project | 20 | C2 (counts 1), each D5 accepted, and each plan retry after an Edit idea (C4 → E2); stored in `projects.planRequestCount` | never (`resetsAt: null`) | `quota: plan_requests_per_project` |
| ElevenLabs characters per user per month | 3,000 | Reserved before each speech call (generate job) | 1st of the month 00:00 user timezone | generate job fails `QUOTA_EXCEEDED` (checked at D8 using the plan's character estimate too) |

Current usage is in `GET /api/v1/me` → `usage`.

### 10.2 Global spend ceilings
Global ElevenLabs characters/month (90% of the plan), Gemini requests/day, Sandbox render minutes/day, estimated INR/day (admin settings, I11/I12). When reached: `503 SPEND_CEILING` on C2, C7, D5, D8, F4, H1; running jobs finish; existing videos, downloads and publishing keep working.

### 10.3 Rate limits (short windows, per user unless stated)

| Endpoints | Limit |
|---|---|
| Auth (A1, A2, A5, A6) | see §3.7 |
| Polling reads (C6, E1, H4) | 120 / min |
| Other reads (`GET`) | 300 / min (one shared counter per user for all of these reads; F11) |
| C7 brainstorm, H1 caption suggestions | 10 / hour each |
| C2 create project | 10 / hour (plus the daily quota) |
| D3 narration edit, D4 voice, D7 restore, C4 rename / edit idea | 60 / min |
| D5 revision | 20 / hour |
| D8 approve, F4 caption overrides | 10 / hour |
| H2 publish/schedule, H5, H6 | 10 / hour |
| E2, E3 retry/cancel | 30 / hour |
| B2, B3, B6 | 30 / min (B3: 3 / hour) |
| G2 connect | 10 / hour |
| Admin endpoints | 120 / min per admin |
| J1–J3 Meta callbacks | 60 / min per IP |

Over the limit: `429 RATE_LIMITED`, header `Retry-After: <seconds>`.
```json
{ "error": { "code": "RATE_LIMITED", "message": "You're going a bit fast. Please wait a minute.", "details": { "retryAfterSeconds": 42 }, "requestId": "req_01JCXKC4H6RN" } }
```

---

## 11. Resource Shapes

Types use TypeScript notation; `| null` fields are always present. Full JSON Schemas are in `openapi.yaml` → `components.schemas`.

### 11.1 Enums

| Enum | Values | Source |
|---|---|---|
| `Language` | `en` \| `hi` \| `hinglish` | `LANGUAGES` (common.ts) |
| `VoiceGender` | `female` \| `male` | ARCHITECTURE §8.3 |
| `VoicePreset` | `indian-english-male` \| `indian-english-female` \| `hindi-male` \| `hindi-female` \| `hinglish-male` \| `hinglish-female` | `VOICE_PRESETS` (common.ts). Mapping: `en`→`indian-english-*`, `hi`→`hindi-*`, `hinglish`→`hinglish-*` |
| `SceneType` | `title-hook` \| `labeled-diagram` \| `process-flow` \| `comparison` \| `timeline` \| `chart` \| `step-sequence` \| `takeaway` | `SCENE_TYPES` |
| `ObjectKind` | `headline`, `subtitle`, `icon`, `diagram`, `part`, `arrow`, `node`, `particles`, `column`, `point`, `axis`, `milestone`, `bar`, `line-point`, `pie-slice`, `counter`, `step`, `bullet` (allowed per pattern: `COMPONENT_CATALOG`) | component-catalog.ts |
| `EventAction` | `appear`, `highlight`, `pulse`, `point-to`, `flow`, `rise`, `fall`, `speed-up`, `gather`, `check`, `cross`, `advance`, `grow`, `count-up`, `complete` (allowed per pattern: `COMPONENT_CATALOG`) | component-catalog.ts |
| `IconName` | `sun`, `raindrop`, `droplets`, `cloud`, `waves`, `snowflake`, `glass`, `mountain`, `layers`, `thermometer`, `flame`, `wind`, `leaf`, `globe`, `bulb`, `check`, `cross`, `clock`, `coin`, `bank`, `chart`, `book`, `flag`, `star`, `question`, `people`, `gear`, `dot` | `ICON_NAMES` (icon-catalog.ts) |
| `ProjectState` | `draft` \| `planning` \| `plan_failed` \| `storyboard_ready` \| `generating` \| `generate_failed` \| `video_ready` \| `scheduled` \| `publishing` \| `published` \| `publish_failed` \| `archived` | ARCHITECTURE §7.2 |
| `ProjectStep` | `idea` \| `storyboard` \| `video` \| `publish` | derived (which stepper step is active) |
| `InputType` | `topic` \| `notes` \| `brainstorm` | ARCHITECTURE §8.3 |
| `PlanVersionSource` | `ai_plan` \| `ai_revision` \| `user_edit` \| `caption_edit` (reserved, not produced in V1) | ARCHITECTURE §8.4 |
| `JobType` / `JobState` / `StageStatus` | see §8.2 | ARCHITECTURE §7.3, manifest.ts |
| `RevisionStage` / `RevisionScope` / `RevisionStatus` | `storyboard`\|`video` / `project`\|`scene` / `pending`\|`succeeded`\|`failed`\|`rejected` | ARCHITECTURE §8.5 |
| `RenderStatus` | `pending` \| `rendering` \| `validating` \| `ready` \| `failed` | ARCHITECTURE §8.8 |
| `PostMode` / `PostState` | `now`\|`scheduled` / `draft` (reserved) \| `scheduled` \| `publishing` \| `outcome_unknown` \| `published` \| `publish_failed` \| `approval_invalidated` \| `cancelled` | ARCHITECTURE §7.4, §8.12 |
| `ConnectionStatus` | `active` \| `expired` \| `revoked` \| `error` | ARCHITECTURE §8.11 |
| `AllowedAction` | `rename`, `edit_idea` (only in `plan_failed`), `archive`, `edit_storyboard`, `request_revision`, `approve_storyboard`, `cancel_job`, `retry_job`, `edit_captions`, `download`, `publish`, `cancel_post`, `retry_post` | derived server side (principle "the server owns state") |
| `NotificationType` | `storyboard_ready`, `video_ready`, `needs_input`, `generate_failed`, `post_published`, `post_failed`, `approval_invalidated`, `instagram_reconnect` | §14.2 |

### 11.2 Plan contract (exact code field names: `packages/pipeline/src/contracts/plan.ts`)

```ts
Plan = {
  schemaVersion: 1;                       // PLAN_SCHEMA_VERSION
  projectId: SafeId; ownerId: SafeId;     // assigned by code (= database ids)
  versionId: SafeId;                      // = planVersion id
  parentVersionId: SafeId | null;
  topic: string;                          // 1–200
  audience: string;                       // 1–200
  learningObjective: string;              // 1–300
  language: Language;
  voicePreset: VoicePreset;
  sources: Source[];                      // { id: SafeId, title: string ≥1, notes: string ≤ 20000 }
  scenes: Scene[];                        // schema 2–12; semantic rule 3–10; first "title-hook", last "takeaway"
  warnings: PlanWarning[];                // { sceneId: SafeId | null, message: string ≥1 }
}
Scene = {
  id: SafeId;
  type: SceneType;
  narration: NarrationBlock[];            // 1–4 blocks (SCENE_LIMITS.maxNarrationBlocks)
  objects: VisualObject[];                // count per pattern (COMPONENT_CATALOG min/maxObjects)
  events: SceneEvent[];                   // ≤ 8 (SCENE_LIMITS.maxEvents)
}
NarrationBlock = { id: SafeId; text: string /*1–300*/; speech: string | null; display: string | null }
VisualObject  = { id: SafeId; kind: ObjectKind; label: string /*≤32 or ≤60 by kind*/; icon?: IconName /*omitted when none*/; value: number | null /*chart kinds only*/ }
SceneEvent    = { id: SafeId; anchor: { narrationId: SafeId; phrase: string }; action: EventAction; target: SafeId /*object id in the same scene*/ }
ValidationIssue = { sceneId: string | null; path: string; message: string }   // packages/pipeline/src/planning/validation-issue.ts
```
Objects are **strict** (unknown keys rejected). Label limits: `headline`, `subtitle`, `point`, `step`, `bullet` ≤ 60; all other kinds ≤ 32; `bar`, `line-point`, `pie-slice`, `counter` require a numeric `value`, the others need `value: null`. Hindi on-screen text must be Devanagari; Hinglish on-screen text must be Roman (Devanagari only in `speech`).

### 11.3 Application resources

```ts
Me = { id; name; email; role: "creator" | "admin"; timezone: string /*IANA*/; defaultLanguage: Language; defaultVoiceGender: VoiceGender;
       createdAt; usage: { videosToday: Usage; projectsToday: Usage; voiceCharactersThisMonth: Usage };
       instagram: { status: ConnectionStatus | "not_connected"; username: string | null };
       unreadNotifications: number; maintenance: { active: boolean; message: string | null } }
Usage = { used: number; limit: number; resetsAt: string | null }

ProjectSummary = { id; title; language; voiceGender; state: ProjectState; currentStep: ProjectStep; thumbnailUrl: string | null;
                   latestPost: PostSummary | null; activeJobType: JobType | null; createdAt; updatedAt }
Project = ProjectSummary & {
  input: { type: InputType; text: string; brainstormChoice: { subject: string; title: string; hook: string } | null };
  stateVersion: number; currentPlanVersionId: string | null; approvedPlanVersionId: string | null;
  currentRenderId: string | null; activeJobId: string | null; activeJob: Job | null;
  lastError: { code: string; message: string; at: string } | null;
  allowedActions: AllowedAction[]; archivedAt: string | null }
ProjectStatus = { projectId; state; currentStep; stateVersion; currentPlanVersionId; currentRenderId; activeJob: Job | null;
                  lastError; latestPost: PostSummary | null; allowedActions; updatedAt; pollAfterMs: 2000 | null }

PlanVersionSummary = { id; projectId; versionNumber: number; parentVersionId: string | null; source: PlanVersionSource;
                       planHash: string; isCurrent: boolean; isApproved: boolean; valid: boolean;
                       stats: { sceneCount: number; wordCount: number; estimatedSeconds: number }; createdAt }
PlanVersion = PlanVersionSummary & { plan: Plan; validation: { valid: boolean; issues: ValidationIssue[]; warnings: ValidationIssue[] };
                                     approval: { id; approvedBy; approvedAt } | null; changedSceneIds: string[] }

Revision = { id; projectId; stage: RevisionStage; scope: RevisionScope; sceneId: string | null; message: string;
             basePlanVersionId; resultPlanVersionId: string | null; status: RevisionStatus; assistantReply: string | null;
             diff: { changedSceneIds: string[]; addedSceneIds: string[]; removedSceneIds: string[]; narrationChanged: boolean } | null;
             jobId: string; createdAt; updatedAt }

StoryboardApproval = { id; projectId; planVersionId; planHash; approvedBy; approvedAt }

RenderSummary = { id; projectId; renderNumber: number; planVersionId; planHash; status: RenderStatus; isCurrent: boolean;
                  durationMs: number | null; mp4Sha256: string | null; bytes: number | null; width: 1080; height: 1920; fps: 30;
                  captionOverrideSetId: string | null; thumbnailUrl: string | null; error: { code; message } | null; createdAt; readyAt: string | null }
Render = RenderSummary & { captions: CaptionPhrase[] }   // [] until ready
CaptionPhrase = { sceneId: SafeId; phraseIndex: number; text: string; originalText: string; startMs: number; endMs: number; overridden: boolean }

InstagramConnection = { id; igUserId: string; username: string; accountType: "BUSINESS" | "MEDIA_CREATOR"; profilePictureUrl: string | null;
                        status: ConnectionStatus; tokenExpiresAt; connectedAt; lastRefreshedAt }   // the token is never returned

PostSummary = { id; state: PostState; mode: PostMode; scheduledAt: string | null; permalink: string | null }
Post = PostSummary & { projectId; renderId; connectionId; caption: string; jobId: string | null;
       approval: { id /*approvalId, new for every H2 approval*/; renderId; mp4Sha256; connectionId; igUserId; captionHash; approvedBy; approvedAt };
       destination: { username: string; profilePictureUrl: string | null };
       igMediaId: string | null; attempts: number; nextAttemptAt: string | null;
       lastError: { code; message; at } | null; publishedAt: string | null; createdAt; updatedAt }

Notification = { id; type: NotificationType; projectId: string | null; postId: string | null; title: string; message: string; readAt: string | null; createdAt }
Job = see §8.2
```

`currentStep` rules: `draft`/`planning`/`plan_failed` → `idea`; `storyboard_ready` → `storyboard`; `generating`/`generate_failed`/`video_ready` → `video`; `scheduled`/`publishing`/`published`/`publish_failed` → `publish`. (`video_ready` stays on `video` until the creator clicks **Continue to publish**, which is client navigation only.)

---

## 12. Endpoint Index

Auth: **anon** = anonymous · **session** = any signed-in user (Better Auth) · **creator** = signed-in `active` user (admins are creators too) · **admin** = `role = admin` · **Meta** = Meta `signed_request` HMAC. **Idem** = `Idempotency-Key` required. **Ver** = `expectedStateVersion`/`If-Match` required.

| # | Method | Path | Purpose | Auth | Success | Idem | Ver |
|---|---|---|---|---|---|---|---|
| A1 | POST | `/api/auth/sign-up/email` | Sign up (allow-list) | anon | 200 | | |
| A2 | POST | `/api/auth/sign-in/email` | Log in | anon | 200 | | |
| A3 | POST | `/api/auth/sign-out` | Log out | session | 200 | | |
| A4 | GET | `/api/auth/get-session` | Current session | session/anon | 200 | | |
| A5 | POST | `/api/auth/change-password` | Change password | session | 200 | | |
| A6 | POST | `/api/auth/reset-password` | Set password with reset token | anon | 200 | | |
| B1 | GET | `/api/v1/me` | Current user, usage, alerts | creator | 200 | | |
| B2 | PATCH | `/api/v1/me` | Update name/defaults/timezone | creator | 200 | | |
| B3 | DELETE | `/api/v1/me` | Delete account (async cascade) | creator | 202 | ✓ | |
| B4 | GET | `/api/v1/voices` | Voice presets + preview samples | creator | 200 | | |
| B5 | GET | `/api/v1/notifications` | In-app notifications | creator | 200 | | |
| B6 | POST | `/api/v1/notifications/mark-read` | Mark notifications read | creator | 200 | | |
| C1 | GET | `/api/v1/projects` | Library (tabs, paginated) | creator | 200 | | |
| C2 | POST | `/api/v1/projects` | Create project + start storyboard | creator | 202 | ✓ | |
| C3 | GET | `/api/v1/projects/{projectId}` | Project detail | creator | 200 | | |
| C4 | PATCH | `/api/v1/projects/{projectId}` | Rename; edit the idea after the storyboard failed | creator | 200 | | ✓ |
| C5 | DELETE | `/api/v1/projects/{projectId}` | Archive (soft delete) | creator | 200 | | ✓ |
| C6 | GET | `/api/v1/projects/{projectId}/status` | Lightweight status for 2 s polling | creator | 200 | | |
| C7 | POST | `/api/v1/brainstorm` | AI idea suggestions (sync) | creator | 200 | | |
| D1 | GET | `/api/v1/projects/{projectId}/plan-versions` | Version history | creator | 200 | | |
| D2 | GET | `/api/v1/projects/{projectId}/plan-versions/{planVersionId}` | Full plan (or `current`) | creator | 200 | | |
| D3 | POST | `/api/v1/projects/{projectId}/narration-edits` | Edit one narration block → new version | creator | 201 | | ✓ |
| D4 | POST | `/api/v1/projects/{projectId}/voice` | Switch Male/Female → new version | creator | 201 | | ✓ |
| D5 | POST | `/api/v1/projects/{projectId}/revisions` | Revision chat (storyboard or video) | creator | 202 | ✓ | ✓ |
| D6 | GET | `/api/v1/projects/{projectId}/revisions` | Revision chat history | creator | 200 | | |
| D7 | POST | `/api/v1/projects/{projectId}/plan-versions/{planVersionId}/restore` | Undo / restore a version | creator | 200 | | ✓ |
| D8 | POST | `/api/v1/projects/{projectId}/storyboard-approval` | Approve storyboard + start video | creator | 202 | ✓ | ✓ |
| E1 | GET | `/api/v1/jobs/{jobId}` | Job status | creator | 200 | | |
| E2 | POST | `/api/v1/jobs/{jobId}/retry` | Retry/resume a failed job | creator | 202 | ✓ | |
| E3 | POST | `/api/v1/jobs/{jobId}/cancel` | Cancel a running job | creator | 202 | | |
| F1 | GET | `/api/v1/projects/{projectId}/renders` | Render (video) versions | creator | 200 | | |
| F2 | GET | `/api/v1/projects/{projectId}/renders/{renderId}` | Render detail + caption phrases | creator | 200 | | |
| F3 | GET | `/api/v1/projects/{projectId}/renders/{renderId}/media` | Presigned URL (play/download/thumbnail) | creator | 200 / 302 | | |
| F4 | POST | `/api/v1/projects/{projectId}/renders/{renderId}/caption-overrides` | Caption correction → re-render | creator | 202 | ✓ | ✓ |
| G1 | GET | `/api/v1/instagram/connection` | Connection status | creator | 200 | | |
| G2 | GET | `/api/v1/instagram/connect` | Start Instagram OAuth | creator | 302 | | |
| G3 | GET | `/api/v1/instagram/callback` | OAuth callback | creator (state) | 302 | | |
| G4 | DELETE | `/api/v1/instagram/connection` | Disconnect | creator | 200 | | |
| H1 | POST | `/api/v1/projects/{projectId}/caption-suggestions` | AI Instagram caption + hashtags (sync) | creator | 200 | | |
| H2 | POST | `/api/v1/projects/{projectId}/posts` | Publish now **or** schedule (approval #2) | creator | 202 | ✓ | ✓ |
| H3 | GET | `/api/v1/projects/{projectId}/posts` | Posts of a project | creator | 200 | | |
| H4 | GET | `/api/v1/posts/{postId}` | Post status (polling) | creator | 200 | | |
| H5 | POST | `/api/v1/posts/{postId}/cancel` | Cancel a scheduled post | creator | 200 | | |
| H6 | POST | `/api/v1/posts/{postId}/retry` | Retry a failed publish | creator | 202 | ✓ | |
| I1 | GET | `/api/v1/admin/allowlist` | List allow-list | admin | 200 | | |
| I2 | POST | `/api/v1/admin/allowlist` | Add email | admin | 201 | | |
| I3 | DELETE | `/api/v1/admin/allowlist/{entryId}` | Remove email | admin | 200 | | |
| I4 | GET | `/api/v1/admin/users` | List users | admin | 200 | | |
| I5 | GET | `/api/v1/admin/users/{userId}` | User detail + usage | admin | 200 | | |
| I6 | PATCH | `/api/v1/admin/users/{userId}` | Suspend / reactivate | admin | 200 | | |
| I7 | POST | `/api/v1/admin/users/{userId}/password-reset-links` | One-time reset link | admin | 201 | | |
| I8 | GET | `/api/v1/admin/jobs` | Jobs (failed/stuck filters) | admin | 200 | | |
| I9 | POST | `/api/v1/admin/jobs/{jobId}/retry` | Retry any user's job | admin | 202 | ✓ | |
| I10 | GET | `/api/v1/admin/usage` | Spend, ceilings, metrics | admin | 200 | | |
| I11 | GET | `/api/v1/admin/settings` | Global settings | admin | 200 | | |
| I12 | PUT | `/api/v1/admin/settings` | Update settings | admin | 200 | | (`expectedVersion`) |
| J1 | POST | `/api/v1/meta/deauthorize` | Meta deauthorize callback | Meta | 200 | | |
| J2 | POST | `/api/v1/meta/data-deletion` | Meta data-deletion callback | Meta | 200 | | |
| J3 | GET | `/api/v1/meta/data-deletion/{confirmationCode}` | Deletion status (public) | anon | 200 | | |
| — | GET/POST/PUT | `/api/inngest` | Inngest functions (internal, §15) | Inngest signature | — | | |

**Total: 59 public operations** (6 Better Auth + 53 under `/api/v1`) + 1 internal endpoint (+ 1 conditional media proxy, §15).

---

## 13. Screen → Endpoints Map

| Screen (ARCHITECTURE §11) | On load | Actions |
|---|---|---|
| `/` landing | A4 | links to `/signup`, `/login` |
| `/signup` | — | A1 (on `NOT_ALLOWLISTED` → `/access-pending`) |
| `/login` | — | A2 |
| `/reset-password?token=…` | — | A6 |
| `/access-pending` | — | none (mailto / external form) |
| App shell (every signed-in page) | A4, B1 | A3 logout, B5/B6 notifications bell, toasts from B5 (`unreadOnly=true`) |
| `/dashboard` | C1 (`tab`), B1 | C5 archive, C4 rename, "+ New video" → `/projects/new` |
| `/projects/new` ① Idea | B1 (defaults), B4 (voices) | C7 brainstorm, C2 create storyboard → poll C6 |
| ① Idea of an existing project in `plan_failed` (storyboard failed) | C3 (idea text + `lastError`) | **Edit idea** = C4 with `text` (and optional `title`), then **Try again** = E2 on the failed plan job → poll C6 |
| `/projects/[id]/storyboard` ② | C3, D2 `current`, D6, (D1 when history opens) | D3 narration edit, D4 voice, D5 revision (`stage: storyboard`), D7 undo/restore, D8 approve & generate, E2 retry / E3 cancel, poll C6 every 2 s while `activeJob` |
| `/projects/[id]/video` ③ | C3, F2 current render, F3 `kind=video` | F3 `kind=download`, F4 caption fixes, D5 revision (`stage: video`), E2 retry, E3 cancel, F1 previous versions, poll C6 |
| `/projects/[id]/publish` ④ | C3, F2, F3 (`thumbnail`, `video`), G1, H3 | G2 connect, H1 AI caption, H2 publish now / schedule, H5 cancel, H6 retry, F3 download, poll H4 / C6 |
| `/settings` | B1, G1 | B2 defaults, A5 change password, G2 connect, G4 disconnect, B3 delete account |
| `/admin` | I1, I4, I8, I10, I11 | I2, I3, I5, I6, I7, I9, I12 |
| `/data-deletion/[code]` (Meta status page) | J3 | — |

---

## 14. Endpoints in Detail

Common to all `/api/v1` endpoints unless stated: errors `401 UNAUTHENTICATED`, `403 FORBIDDEN` (Origin, mutations), `429 RATE_LIMITED`, `500 INTERNAL`; mutations also `503 MAINTENANCE` and `413 PAYLOAD_TOO_LARGE`. Each section lists the **additional** errors. Example ids: user `67330c1a9f1e4b2a7c0d1e01`, project `67330d5e9f1e4b2a7c0d2a10`.

### 14.1 Auth (Better Auth)
A1–A6 are specified in §3 with examples.

### 14.2 Account, settings, voices, notifications

#### B1. `GET /api/v1/me` — Current user
Purpose: profile, defaults, quotas, Instagram badge and unread count for the app shell. Auth: creator. Rate: 300/min.
Success `200` → `Me`.
Errors: common only.
**Until the related features exist (F11):** the `usage` counts are `0` (limits and `resetsAt` are real; counting starts in F12 for projects and with video generation for videos and voice characters), `instagram` is `{ "status": "not_connected", "username": null }` (until F28), `unreadNotifications` is `0` (until F32) and `maintenance` is off (until the `settings` document, F27/F36). The limits live in one constant, `USAGE_LIMITS` in `packages/db/src/usage.ts`; the app shell's "Videos today" pill calls the same server function as this endpoint (`apps/web/lib/account/me.ts`).
```json
{
  "id": "67330c1a9f1e4b2a7c0d1e01",
  "name": "Ananya Iyer",
  "email": "ananya.iyer@example.in",
  "role": "creator",
  "timezone": "Asia/Kolkata",
  "defaultLanguage": "en",
  "defaultVoiceGender": "female",
  "createdAt": "2026-11-12T04:30:00.000Z",
  "usage": {
    "videosToday": { "used": 1, "limit": 3, "resetsAt": "2026-11-12T18:30:00.000Z" },
    "projectsToday": { "used": 2, "limit": 5, "resetsAt": "2026-11-12T18:30:00.000Z" },
    "voiceCharactersThisMonth": { "used": 1180, "limit": 3000, "resetsAt": "2026-11-30T18:30:00.000Z" }
  },
  "instagram": { "status": "active", "username": "physics.with.ananya" },
  "unreadNotifications": 1,
  "maintenance": { "active": false, "message": null }
}
```
```json
{ "error": { "code": "UNAUTHENTICATED", "message": "Please log in again.", "requestId": "req_01JCXM0A1B2C" } }
```

#### B2. `PATCH /api/v1/me` — Update profile and defaults
Auth: creator. Rate: 30/min.
Body (at least one field): `name` string 1–80 · `timezone` IANA zone name (validated with `Intl.supportedValuesOf('timeZone')`) · `defaultLanguage` `Language` · `defaultVoiceGender` `VoiceGender`.
Success `200` → `Me`. Errors: `400 INVALID_INPUT`.
```json
{ "defaultLanguage": "hinglish", "defaultVoiceGender": "male" }
```
```json
{ "id": "67330c1a9f1e4b2a7c0d1e01", "name": "Ananya Iyer", "email": "ananya.iyer@example.in", "role": "creator", "timezone": "Asia/Kolkata", "defaultLanguage": "hinglish", "defaultVoiceGender": "male", "createdAt": "2026-11-12T04:30:00.000Z", "usage": { "videosToday": { "used": 1, "limit": 3, "resetsAt": "2026-11-12T18:30:00.000Z" }, "projectsToday": { "used": 2, "limit": 5, "resetsAt": "2026-11-12T18:30:00.000Z" }, "voiceCharactersThisMonth": { "used": 1180, "limit": 3000, "resetsAt": "2026-11-30T18:30:00.000Z" } }, "instagram": { "status": "active", "username": "physics.with.ananya" }, "unreadNotifications": 1, "maintenance": { "active": false, "message": null } }
```
```json
{ "error": { "code": "INVALID_INPUT", "message": "Please check the highlighted fields.", "details": { "issues": [ { "path": "timezone", "message": "unknown timezone \"India/Mumbai\"" } ] }, "requestId": "req_01JCXM0D3E4F" } }
```

#### B3. `DELETE /api/v1/me` — Delete account
Purpose: delete the account (DPDP; ARCHITECTURE §22; DATABASE.md §6.7). **30-day soft delete** (founder decision, 2026-11-13): the account is hidden and logged out right away and can be restored by an admin within 30 days; then personal data is erased and one anonymous `deletionLog` entry is kept. Auth: creator. Rate: 3/hour. **Idempotency-Key required.**
Body: `password` string (required, re-authentication) · `confirm` must equal `"DELETE"`.
Effect (one transaction, see DATABASE.md §7): user `status = deleting`, all sessions deleted, `scheduled` and `publish_failed` posts `cancelled`, active jobs get `cancelRequestedAt`, a `deletionRequests` record with `eraseAfter` = now + 30 days. Right after the transaction, the Instagram token and connection are deleted (Meta's rule). At `eraseAfter`, the `delete-account` Inngest function writes the anonymous `deletionLog` entry, deletes the R2 prefix `users/{ownerId}/` and every owner-scoped collection, deletes the `allowlist` entry, anonymizes `providerUsage` and audit logs and finally removes the Better Auth rows and the request record (DATABASE.md §6.7).
Success `202` → `{ deletionRequestId, status: "pending", requestedAt, eraseAfter }` and the session cookie is cleared.
Errors: `400 INVALID_INPUT` (wrong `confirm`) · `403 FORBIDDEN` (`details.reason: "wrong_password"`) · `409 INVALID_STATE` (a post is `publishing` right now; try again in a few minutes).
```json
{ "password": "Monsoon-Maths-Notes-77", "confirm": "DELETE" }
```
```json
{ "deletionRequestId": "673312aa9f1e4b2a7c0d9c01", "status": "pending", "requestedAt": "2026-11-12T10:00:00.000Z" }
```
```json
{ "error": { "code": "FORBIDDEN", "message": "Your password is incorrect.", "details": { "reason": "wrong_password" }, "requestId": "req_01JCXM0G5H6J" } }
```

#### B4. `GET /api/v1/voices` — Voice presets and preview samples
Purpose: the ① Idea voice chips with ▶ preview (pre-recorded static MP3s in `public/voices/`, decision D7; no ElevenLabs cost). Auth: creator. Query: `language` optional `Language` filter.
Success `200` → `{ items: [{ preset, language, gender, label, sampleUrl, sampleText, enabled }] }`. Voice IDs are never exposed. `enabled = false` when an admin disabled the preset (I12).
Errors: `400 INVALID_INPUT` (unknown language).
```http
GET /api/v1/voices?language=hi
```
```json
{
  "items": [
    { "preset": "hindi-female", "language": "hi", "gender": "female", "label": "महिला आवाज़ (Female)", "sampleUrl": "/voices/hindi-female.mp3", "sampleText": "नमस्ते! आज हम समझेंगे कि इंद्रधनुष कैसे बनता है।", "enabled": true },
    { "preset": "hindi-male", "language": "hi", "gender": "male", "label": "पुरुष आवाज़ (Male)", "sampleUrl": "/voices/hindi-male.mp3", "sampleText": "नमस्ते! आज हम समझेंगे कि इंद्रधनुष कैसे बनता है।", "enabled": true }
  ]
}
```
```json
{ "error": { "code": "INVALID_INPUT", "message": "Please check the highlighted fields.", "details": { "issues": [ { "path": "language", "message": "must be one of en, hi, hinglish" } ] }, "requestId": "req_01JCXM0K7L8M" } }
```

#### B5. `GET /api/v1/notifications` — In-app notifications
Purpose: banners/toasts on the next visit (no email in V1, decision D3). Auth: creator. Query: `unreadOnly` boolean (default false), `limit`, `cursor`. Sort: `createdAt` desc.
Success `200` → `{ items: Notification[], nextCursor }`. Errors: `400 INVALID_INPUT` (bad cursor).
```json
{
  "items": [
    { "id": "673310f19f1e4b2a7c0d9a01", "type": "video_ready", "projectId": "67330d5e9f1e4b2a7c0d2a10", "postId": null, "title": "Your video is ready", "message": "\"How UPI payments work\" is ready to review.", "readAt": null, "createdAt": "2026-11-12T05:46:12.000Z" }
  ],
  "nextCursor": null
}
```
```json
{ "error": { "code": "INVALID_INPUT", "message": "The list cursor is invalid. Reload the list.", "details": { "issues": [ { "path": "cursor", "message": "invalid cursor" } ] }, "requestId": "req_01JCXM0N9P0Q" } }
```

#### B6. `POST /api/v1/notifications/mark-read` — Mark read
Auth: creator. Body: exactly one of `ids` (array of 1–100 notification ids) or `all: true`. Success `200` → `{ updated: number }`. Unknown/foreign ids are ignored (counted as not updated). Errors: `400 INVALID_INPUT`.
```json
{ "ids": ["673310f19f1e4b2a7c0d9a01"] }
```
```json
{ "updated": 1 }
```
```json
{ "error": { "code": "INVALID_INPUT", "message": "Send either ids or all.", "details": { "issues": [ { "path": "", "message": "exactly one of ids or all is required" } ] }, "requestId": "req_01JCXM0R1S2T" } }
```

### 14.3 Projects and ① Idea

#### C1. `GET /api/v1/projects` — Library
Purpose: dashboard cards. Auth: creator. Query: `tab` optional — `drafts` (`draft`, `planning`, `plan_failed`, `storyboard_ready`, `generating`, `generate_failed`) · `ready` (`video_ready`, `publish_failed`) · `scheduled` (`scheduled`, `publishing`) · `published` (`published`); omitted = all non-archived. `limit` 1–50 (20), `cursor`. Sort: `updatedAt` desc, `_id` desc. Archived projects are never listed.
Success `200` → `{ items: ProjectSummary[], nextCursor }`. `thumbnailUrl` is a 15-minute presigned URL (or null).
Errors: `400 INVALID_INPUT`.
```http
GET /api/v1/projects?tab=ready&limit=20
```
```json
{
  "items": [
    {
      "id": "67330d5e9f1e4b2a7c0d2a10",
      "title": "How UPI payments work",
      "language": "en",
      "voiceGender": "female",
      "state": "video_ready",
      "currentStep": "video",
      "thumbnailUrl": "https://bytereel-prod.r2.example-account.r2.cloudflarestorage.com/users/67330c1a9f1e4b2a7c0d1e01/projects/67330d5e9f1e4b2a7c0d2a10/renders/67330f109f1e4b2a7c0d6f01/thumbnail.jpg?X-Amz-Expires=900&X-Amz-Signature=3f1c",
      "latestPost": null,
      "activeJobType": null,
      "createdAt": "2026-11-12T05:00:00.000Z",
      "updatedAt": "2026-11-12T05:46:12.000Z"
    }
  ],
  "nextCursor": null
}
```
```json
{ "error": { "code": "INVALID_INPUT", "message": "Please check the highlighted fields.", "details": { "issues": [ { "path": "tab", "message": "must be one of drafts, ready, scheduled, published" } ] }, "requestId": "req_01JCXM1A2B3C" } }
```

#### C2. `POST /api/v1/projects` — Create project and start the storyboard
Purpose: ① **Create storyboard**. Auth: creator. Rate: 10/hour + quota 5 projects/day. **Idempotency-Key required.**

| Field | Type | Req | Rules |
|---|---|---|---|
| `inputType` | `topic` \| `notes` \| `brainstorm` | ✓ | |
| `text` | string | ✓ | `topic`: 3–300 chars · `notes`: 20–5,000 chars · `brainstorm`: 3–300 (the chosen idea's title + hook) |
| `language` | `Language` | ✓ | |
| `voiceGender` | `VoiceGender` | ✓ | → `voicePreset` (e.g. `en` + `female` → `indian-english-female`) |
| `brainstormChoice` | `{ subject 2–100, title 3–120, hook 3–200 }` | iff `inputType = brainstorm` | Copied from a C7 idea |

Effect (one transaction): `projects` (state `planning`, `stateVersion 1`, `title` = first 120 chars of the idea until the plan arrives, then `plan.topic`), `jobs` (`plan`, `queued`, key `plan:{projectId}:{inputHash}`), `activeJobId`, `planRequestCount: 1`, `usageCounters.projects +1`; then Inngest `plan.requested`. Notes are stored as the plan's single `sources[]` entry (`id: "creator-notes"`).
Success `202` → `{ project: Project, job: Job }`.
Errors: `400 INVALID_INPUT` · `429 QUOTA_EXCEEDED` (`projects_per_day`) · `503 SPEND_CEILING`.

**Until F15 (built in F12, no AI yet).** C2 saves the project but starts no job. Differences from the spec above:
- Effect (one transaction): `usageCounters.projects +1` (only while within 5/day, otherwise `429 QUOTA_EXCEEDED` and nothing is saved), insert `projects` with **state `draft`**, `stateVersion 1`, **`planRequestCount: 0`**, `activeJobId: null`, `title` = the first 120 characters of the idea (spaces and line breaks collapsed), and the answer saved on the `Idempotency-Key` record. No `jobs` document, no Inngest event.
- Success **`201`** → `{ project: Project, job: null }` (`currentStep: "idea"`, `activeJobType: null`, `allowedActions: []` until rename/archive and the job actions exist).
- The UI sends `inputType: "topic"` when the trimmed text is ≤ 300 characters and `"notes"` above that (one box for both, PRD §6.1). `brainstorm` is accepted by the validator but no screen sends it until F14.
- No `503 SPEND_CEILING` / `MAINTENANCE` yet (they arrive with the `settings` document, F27/F36).
- After success the UI goes to the temporary project page **`/projects/[id]`** (owner only; another user's project, a missing one or a malformed id → the same 404 page). F15/F16 turn it into a redirect to the project's current step.
- F15 switches to the full spec: state `planning`, the queued `plan` job in the same transaction, `planRequestCount: 1`, `202` with the job.

```http
POST /api/v1/projects
Origin: https://bytereel.app
Content-Type: application/json
Idempotency-Key: 9b2f4c1e-7d3a-4e8b-a1c5-2f6d8e0b4a71

{ "inputType": "topic", "text": "How UPI payments work — from scanning the QR code to money reaching the shop", "language": "en", "voiceGender": "female" }
```
```json
{
  "project": {
    "id": "67330d5e9f1e4b2a7c0d2a10", "title": "How UPI payments work — from scanning the QR code to money reaching the shop",
    "language": "en", "voiceGender": "female", "state": "planning", "currentStep": "idea", "thumbnailUrl": null, "latestPost": null, "activeJobType": "plan",
    "input": { "type": "topic", "text": "How UPI payments work — from scanning the QR code to money reaching the shop", "brainstormChoice": null },
    "stateVersion": 1, "currentPlanVersionId": null, "approvedPlanVersionId": null, "currentRenderId": null,
    "activeJobId": "67330d5f9f1e4b2a7c0d3c01", "activeJob": null, "lastError": null, "allowedActions": ["cancel_job"],
    "archivedAt": null, "createdAt": "2026-11-12T05:00:00.000Z", "updatedAt": "2026-11-12T05:00:00.000Z"
  },
  "job": {
    "id": "67330d5f9f1e4b2a7c0d3c01", "projectId": "67330d5e9f1e4b2a7c0d2a10", "type": "plan", "state": "queued", "attempt": 1,
    "stages": [
      { "name": "plan", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null },
      { "name": "validate", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }
    ],
    "progress": { "stage": "plan", "percent": 0, "message": "Writing your storyboard…" },
    "error": null, "needsInput": null, "result": null, "cancelRequestedAt": null,
    "createdAt": "2026-11-12T05:00:00.000Z", "updatedAt": "2026-11-12T05:00:00.000Z", "startedAt": null, "finishedAt": null, "pollAfterMs": 2000
  }
}
```
(In `project`, `activeJob` is `null` because the full job is returned next to it.)
```json
{ "error": { "code": "QUOTA_EXCEEDED", "message": "You've created 5 projects today. Try again tomorrow.", "details": { "quota": "projects_per_day", "limit": 5, "used": 5, "resetsAt": "2026-11-12T18:30:00.000Z" }, "requestId": "req_01JCXM1D4E5F" } }
```

#### C3. `GET /api/v1/projects/{projectId}` — Project detail
Auth: creator. Success `200` → `Project` (with `activeJob` filled when a job is active), header `ETag: "<stateVersion>"`. Archived projects still return (`state: archived`).
Errors: `404 NOT_FOUND`.
```json
{
  "id": "67330d5e9f1e4b2a7c0d2a10", "title": "How UPI payments work", "language": "en", "voiceGender": "female",
  "state": "storyboard_ready", "currentStep": "storyboard", "thumbnailUrl": null, "latestPost": null, "activeJobType": null,
  "input": { "type": "topic", "text": "How UPI payments work — from scanning the QR code to money reaching the shop", "brainstormChoice": null },
  "stateVersion": 4, "currentPlanVersionId": "67330e019f1e4b2a7c0d2b02", "approvedPlanVersionId": null, "currentRenderId": null,
  "activeJobId": null, "activeJob": null, "lastError": null,
  "allowedActions": ["rename", "archive", "edit_storyboard", "request_revision", "approve_storyboard"],
  "archivedAt": null, "createdAt": "2026-11-12T05:00:00.000Z", "updatedAt": "2026-11-12T05:12:40.000Z"
}
```
```json
{ "error": { "code": "NOT_FOUND", "message": "We couldn't find this project.", "requestId": "req_01JCXM1G6H7J" } }
```

#### C4. `PATCH /api/v1/projects/{projectId}` — Rename, or edit the idea after the storyboard failed
Auth: creator. Rate: 60/min. Body: at least one of `title` string 1–120 · `text` string (the idea; same length rules as C2 for the project's `inputType`) · plus `expectedStateVersion` int (required).
- **Rename** (`title` only): allowed in every state except `archived`. Doesn't touch plans or approvals.
- **Edit idea** (`text`, optionally with `title`): allowed **only in `plan_failed`** with no active job (the "Edit idea" button after a failed storyboard, §4.3). Effect (transaction): `project.input.text` replaced (`inputType` and `brainstormChoice` unchanged), `title` = the sent `title`, else the first 120 chars of the new text (as in C2), `stateVersion + 1`; the project stays `plan_failed` with its `lastError`, and `allowedActions` includes `retry_job`. The creator then presses **Try again** (E2 on the failed `plan` job), which plans from the edited idea. Editing the idea and trying again **does not count toward the 5 projects/day quota** (no new project is created), but each retry that plans from an edited idea **counts 1 toward the 20 plan + revision requests per project** (it is a paid AI call; founder, 2026-11-13). At the limit, E2 returns `429 QUOTA_EXCEEDED` (`plan_requests_per_project`). Language and voice are not editable here (language: create a new project, PRD decision #25; voice: D4 once a storyboard exists).
Success `200` → `Project`. Errors: `400 INVALID_INPUT` (no field, text length) · `404 NOT_FOUND` · `409 STALE_VERSION` · `409 INVALID_STATE` (archived; `text` sent outside `plan_failed`) · `409 JOB_ALREADY_RUNNING`.
```json
{ "title": "UPI in 2 seconds", "expectedStateVersion": 4 }
```
Response: the `Project` with `"title": "UPI in 2 seconds"`, `"stateVersion": 5`.

Edit idea after a failed storyboard:
```json
{ "text": "How a UPI payment travels from your phone to the shop's bank in two seconds", "expectedStateVersion": 3 }
```
Response: the `Project` with `"state": "plan_failed"`, the new `input.text` and `title`, `"stateVersion": 4`, `"allowedActions": ["rename", "edit_idea", "retry_job", "archive"]`. Next call: `POST /api/v1/jobs/{planJobId}/retry` (E2).
```json
{ "error": { "code": "STALE_VERSION", "message": "This project changed in another tab, refresh.", "details": { "expectedStateVersion": 4, "currentStateVersion": 5 }, "requestId": "req_01JCXM1K8L9M" } }
```

#### C5. `DELETE /api/v1/projects/{projectId}` — Archive (soft delete)
Auth: creator. Header `If-Match: "<stateVersion>"` (required). Allowed in any state **except `publishing`/`outcome_unknown` post in flight** (ARCHITECTURE §7.2). Effect (transaction): active pipeline job gets `cancelRequestedAt`; a `scheduled` or `publish_failed` post → `cancelled` (so it can never be published or retried); project `state = archived`, `archivedAt = now`, `stateBeforeArchive` kept. Nothing is deleted from R2 (DATABASE.md §6.6).
Success `200` → `Project` (`state: archived`). Errors: `404 NOT_FOUND` · `409 STALE_VERSION` · `409 INVALID_STATE` (publishing; already archived).
```http
DELETE /api/v1/projects/67330d5e9f1e4b2a7c0d2a10
Origin: https://bytereel.app
If-Match: "9"
```
```json
{ "error": { "code": "INVALID_STATE", "message": "This video is being published right now. You can archive it in a few minutes.", "details": { "state": "publishing" }, "requestId": "req_01JCXM1N0P1Q" } }
```

#### C6. `GET /api/v1/projects/{projectId}/status` — Polling
Purpose: the one call the project pages poll **every 2 s** while `pollAfterMs` is not null (decision D2). Auth: creator. Rate: 120/min. Header `ETag`. Supports `If-None-Match` → `304` with no body when nothing changed (saves bandwidth).
Success `200` → `ProjectStatus`. Errors: `404 NOT_FOUND`.
```json
{
  "projectId": "67330d5e9f1e4b2a7c0d2a10",
  "state": "generating",
  "currentStep": "video",
  "stateVersion": 6,
  "currentPlanVersionId": "67330e019f1e4b2a7c0d2b02",
  "currentRenderId": null,
  "activeJob": {
    "id": "67330f109f1e4b2a7c0d3c03", "projectId": "67330d5e9f1e4b2a7c0d2a10", "type": "generate", "state": "running", "attempt": 1,
    "stages": [
      { "name": "approve", "status": "succeeded", "startedAt": "2026-11-12T05:40:01.000Z", "endedAt": "2026-11-12T05:40:01.200Z", "attempts": 1, "error": null },
      { "name": "speech", "status": "succeeded", "startedAt": "2026-11-12T05:40:01.300Z", "endedAt": "2026-11-12T05:40:58.000Z", "attempts": 1, "error": null },
      { "name": "compile", "status": "succeeded", "startedAt": "2026-11-12T05:40:58.100Z", "endedAt": "2026-11-12T05:40:59.000Z", "attempts": 1, "error": null },
      { "name": "render", "status": "running", "startedAt": "2026-11-12T05:40:59.100Z", "endedAt": null, "attempts": 1, "error": null },
      { "name": "validate", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }
    ],
    "progress": { "stage": "render", "percent": 71, "message": "Rendering · 1,350 of 2,190 frames" },
    "error": null, "needsInput": null, "result": null, "cancelRequestedAt": null,
    "createdAt": "2026-11-12T05:40:00.000Z", "updatedAt": "2026-11-12T05:43:30.000Z", "startedAt": "2026-11-12T05:40:01.000Z", "finishedAt": null, "pollAfterMs": 2000
  },
  "lastError": null,
  "latestPost": null,
  "allowedActions": ["cancel_job"],
  "updatedAt": "2026-11-12T05:40:00.000Z",
  "pollAfterMs": 2000
}
```
```json
{ "error": { "code": "NOT_FOUND", "message": "We couldn't find this project.", "requestId": "req_01JCXM1R2S3T" } }
```

#### C7. `POST /api/v1/brainstorm` — Brainstorm with AI
Purpose: ① *✨ Brainstorm with AI*: a broad subject → 5–8 focused video ideas with hooks (synchronous Gemini call, 30 s timeout, ARCHITECTURE §14). Doesn't create a project or count toward quotas; logged in `providerUsage`. Auth: creator. Rate: 10/hour.
Body: `subject` string 2–100 (required) · `language` `Language` (required; ideas are written in that language).
Success `200` → `{ subject, language, ideas: [{ id: "idea-1"…, title (≤120), hook (≤200), angle (≤200) }] }` (5–8 ideas). Not stored: the UI keeps them until the user picks one and calls C2 with `inputType: "brainstorm"`.
Errors: `400 INVALID_INPUT` · `422 PROVIDER_REJECTED` (unsafe subject) · `503 PROVIDER_BUSY` · `503 SPEND_CEILING`.
```json
{ "subject": "Indian monsoon", "language": "en" }
```
```json
{
  "subject": "Indian monsoon",
  "language": "en",
  "ideas": [
    { "id": "idea-1", "title": "Why the monsoon reaches Kerala first", "hook": "Every June, Kerala gets wet before Delhi. The reason is a giant sea breeze.", "angle": "Land vs sea heating and the south-west winds" },
    { "id": "idea-2", "title": "How the Western Ghats make Mumbai rainy", "hook": "Mountains can squeeze rain out of clouds like a sponge.", "angle": "Orographic rainfall with a simple diagram" },
    { "id": "idea-3", "title": "What a 'normal monsoon' forecast really means", "hook": "IMD says 'normal'. Normal compared to what?", "angle": "Long-period average and percent departure" },
    { "id": "idea-4", "title": "Why Chennai gets rain in November", "hook": "When the rest of India dries up, Chennai's rainy season begins.", "angle": "North-east (retreating) monsoon" },
    { "id": "idea-5", "title": "How the monsoon feeds your plate", "hook": "Half of India's farmland waits for one season of rain.", "angle": "Kharif crops and rain-fed farming" }
  ]
}
```
```json
{ "error": { "code": "PROVIDER_BUSY", "message": "Our AI is very busy right now. Your idea is saved; please try again in a few minutes.", "requestId": "req_01JCXM1V4W5X" } }
```

### 14.4 ② Storyboard

#### D1. `GET /api/v1/projects/{projectId}/plan-versions` — Version history
Purpose: version history + undo list. Auth: creator. Query: `limit` (20), `cursor`. Sort: `versionNumber` desc.
Success `200` → `{ items: PlanVersionSummary[], nextCursor }`. Errors: `404 NOT_FOUND` · `400 INVALID_INPUT`.
```json
{
  "items": [
    { "id": "67330e019f1e4b2a7c0d2b02", "projectId": "67330d5e9f1e4b2a7c0d2a10", "versionNumber": 2, "parentVersionId": "67330d5f9f1e4b2a7c0d2b01", "source": "ai_revision", "planHash": "sha256:5d7a0c9e1f3b4a6d8c2e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c", "isCurrent": true, "isApproved": false, "valid": true, "stats": { "sceneCount": 6, "wordCount": 176, "estimatedSeconds": 70.4 }, "createdAt": "2026-11-12T05:12:40.000Z" },
    { "id": "67330d5f9f1e4b2a7c0d2b01", "projectId": "67330d5e9f1e4b2a7c0d2a10", "versionNumber": 1, "parentVersionId": null, "source": "ai_plan", "planHash": "sha256:0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9", "isCurrent": false, "isApproved": false, "valid": true, "stats": { "sceneCount": 7, "wordCount": 214, "estimatedSeconds": 85.6 }, "createdAt": "2026-11-12T05:00:36.000Z" }
  ],
  "nextCursor": null
}
```
```json
{ "error": { "code": "NOT_FOUND", "message": "We couldn't find this project.", "requestId": "req_01JCXM2A1B2C" } }
```

#### D2. `GET /api/v1/projects/{projectId}/plan-versions/{planVersionId}` — Full plan
Purpose: the storyboard screen (scene cards, narration, visual plan, pattern badge, warnings, estimated duration). `planVersionId` may be the literal **`current`**. Auth: creator.
Success `200` → `PlanVersion` (the `plan` is exactly the code contract, §11.2). `changedSceneIds` lists scenes that differ from the parent version (for highlighting after a revision).
Errors: `404 NOT_FOUND` (also when the project has no plan yet: `details.reason: "no_plan_yet"`).

Example (plan abbreviated to 3 scenes for readability; real plans have 3–10 scenes and ≈ 150–225 words for 60–90 s):
```json
{
  "id": "67330e019f1e4b2a7c0d2b02",
  "projectId": "67330d5e9f1e4b2a7c0d2a10",
  "versionNumber": 2,
  "parentVersionId": "67330d5f9f1e4b2a7c0d2b01",
  "source": "ai_revision",
  "planHash": "sha256:5d7a0c9e1f3b4a6d8c2e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c",
  "isCurrent": true,
  "isApproved": false,
  "valid": true,
  "stats": { "sceneCount": 6, "wordCount": 176, "estimatedSeconds": 70.4 },
  "validation": {
    "valid": true,
    "issues": [],
    "warnings": [ { "sceneId": "scene-flow", "path": "scenes[1].objects[3].label", "message": "label \"bank debit credit\" looks like a list of icon keywords, not on-screen text; it is shown to viewers as written. Use a short readable label and put the picture in \"icon\"." } ]
  },
  "approval": null,
  "changedSceneIds": ["scene-flow"],
  "createdAt": "2026-11-12T05:12:40.000Z",
  "plan": {
    "schemaVersion": 1,
    "projectId": "67330d5e9f1e4b2a7c0d2a10",
    "ownerId": "67330c1a9f1e4b2a7c0d1e01",
    "versionId": "67330e019f1e4b2a7c0d2b02",
    "parentVersionId": "67330d5f9f1e4b2a7c0d2b01",
    "topic": "How UPI payments work",
    "audience": "Young adults in India who pay with UPI every day but never wondered how it works",
    "learningObjective": "Explain the path of a UPI payment from the payer's app through NPCI to the shop's bank in about two seconds",
    "language": "en",
    "voicePreset": "indian-english-female",
    "sources": [],
    "scenes": [
      {
        "id": "scene-hook",
        "type": "title-hook",
        "narration": [
          { "id": "line-hook", "text": "You scan a QR code, type your PIN, and the chaiwala gets paid in two seconds. How does the money travel so fast?", "speech": null, "display": null }
        ],
        "objects": [
          { "id": "hook-title", "kind": "headline", "label": "How does UPI move money?", "icon": "question", "value": null },
          { "id": "hook-sub", "kind": "subtitle", "label": "From QR code to the shop's bank in 2 seconds", "value": null }
        ],
        "events": [
          { "id": "ev-hook-title", "anchor": { "narrationId": "line-hook", "phrase": "How does the money travel" }, "action": "appear", "target": "hook-title" },
          { "id": "ev-hook-sub", "anchor": { "narrationId": "line-hook", "phrase": "two seconds" }, "action": "highlight", "target": "hook-sub" }
        ]
      },
      {
        "id": "scene-flow",
        "type": "process-flow",
        "narration": [
          { "id": "line-flow-request", "text": "Your UPI app sends the payment request to NPCI, the national switch that connects all banks.", "speech": "Your U P I app sends the payment request to N P C I, the national switch that connects all banks.", "display": null },
          { "id": "line-flow-banks", "text": "NPCI asks your bank to debit you and the shop's bank to credit the shop.", "speech": "N P C I asks your bank to debit you and the shop's bank to credit the shop.", "display": null }
        ],
        "objects": [
          { "id": "node-app", "kind": "node", "label": "Your UPI app", "icon": "gear", "value": null },
          { "id": "node-npci", "kind": "node", "label": "NPCI switch", "icon": "globe", "value": null },
          { "id": "node-your-bank", "kind": "node", "label": "Your bank", "icon": "bank", "value": null },
          { "id": "node-shop-bank", "kind": "node", "label": "bank debit credit", "icon": "bank", "value": null },
          { "id": "arrow-money", "kind": "arrow", "label": "Money moves", "icon": "coin", "value": null }
        ],
        "events": [
          { "id": "ev-request", "anchor": { "narrationId": "line-flow-request", "phrase": "sends the payment request" }, "action": "flow", "target": "node-app" },
          { "id": "ev-npci", "anchor": { "narrationId": "line-flow-request", "phrase": "the national switch" }, "action": "highlight", "target": "node-npci" },
          { "id": "ev-debit", "anchor": { "narrationId": "line-flow-banks", "phrase": "debit you" }, "action": "appear", "target": "node-your-bank" },
          { "id": "ev-credit", "anchor": { "narrationId": "line-flow-banks", "phrase": "credit the shop" }, "action": "flow", "target": "arrow-money" }
        ]
      },
      {
        "id": "scene-takeaway",
        "type": "takeaway",
        "narration": [
          { "id": "line-take", "text": "So remember: UPI is a fast switch between banks, and your PIN is checked only by your own bank.", "speech": null, "display": null }
        ],
        "objects": [
          { "id": "take-headline", "kind": "headline", "label": "UPI = a fast switch between banks", "icon": "bulb", "value": null },
          { "id": "take-pin", "kind": "bullet", "label": "Only your bank checks your PIN", "icon": "check", "value": null }
        ],
        "events": [
          { "id": "ev-take-headline", "anchor": { "narrationId": "line-take", "phrase": "a fast switch between banks" }, "action": "appear", "target": "take-headline" },
          { "id": "ev-take-pin", "anchor": { "narrationId": "line-take", "phrase": "your own bank" }, "action": "appear", "target": "take-pin" }
        ]
      }
    ],
    "warnings": [ { "sceneId": "scene-flow", "message": "Simplified: the PSP banks and the payer's app provider are merged into 'Your UPI app'." } ]
  }
}
```
```json
{ "error": { "code": "NOT_FOUND", "message": "The storyboard isn't ready yet.", "details": { "reason": "no_plan_yet" }, "requestId": "req_01JCXM2D3E4F" } }
```

#### D3. `POST /api/v1/projects/{projectId}/narration-edits` — Edit narration (inline)
Purpose: save one inline narration edit as a new **`user_edit`** plan version (ARCHITECTURE §11 UI rules). Auth: creator. Rate: 60/min.

| Field | Type | Req | Rules |
|---|---|---|---|
| `basePlanVersionId` | id | ✓ | Must be the current version, else `409 STALE_VERSION` |
| `sceneId` | SafeId | ✓ | Scene in the base plan |
| `narrationId` | SafeId | ✓ | Narration block in that scene |
| `text` | string | ✓ | 1–300 chars (`SCENE_LIMITS.maxNarrationBlockLength`) |
| `speech` | string \| null | | Optional pronunciation form (1–300); omitted = keep current value; null = clear |
| `display` | string \| null | | Optional caption form (1–300); same rules |
| `expectedStateVersion` | int | ✓ | |

Allowed states: `storyboard_ready`, `generate_failed`, `video_ready`, `scheduled`, `publish_failed` (editing after a video exists makes a new version that must be approved again), no active job. One rule for every change (founder, 2026-11-13): anything can be changed unless a job is running, and any change cancels the publish approval. Effect (transaction): insert `planVersions` (version n+1, `parentVersionId` = base, re-validated, re-hashed), `project.currentPlanVersionId`, `approvedPlanVersionId = null`, state → `storyboard_ready`, `stateVersion + 1`; a `scheduled` or `publish_failed` post → `approval_invalidated` **immediately, in the same transaction** (back to "needs approval"), plus an `approval_invalidated` notification (§9).
**The version is saved even if validation fails** (e.g. an event anchor phrase no longer exists in the new text): `validation.valid = false` with issues; approval stays blocked until fixed.
Success `201` → `PlanVersion` (+ `Location` header). Errors: `400 INVALID_INPUT` (unknown scene/narration id, length) · `404 NOT_FOUND` · `409 STALE_VERSION` · `409 INVALID_STATE` · `409 JOB_ALREADY_RUNNING`.
```json
{ "basePlanVersionId": "67330e019f1e4b2a7c0d2b02", "sceneId": "scene-takeaway", "narrationId": "line-take", "text": "So remember: UPI is a fast switch between banks, and only you should ever know your PIN.", "expectedStateVersion": 4 }
```
Response `201`: a `PlanVersion` with `"versionNumber": 3`, `"source": "user_edit"`, `"isApproved": false`, `"valid": false`, `"changedSceneIds": ["scene-takeaway"]`, and this `validation` (the edit removed the words "your own bank" that event `ev-take-pin` was anchored to):
```json
{ "valid": false, "issues": [ { "sceneId": "scene-takeaway", "path": "scenes[2].events[1].anchor.phrase", "message": "phrase \"your own bank\" was not found in narration block \"line-take\": \"So remember: UPI is a fast switch between banks, and only you should ever know your PIN.\"" } ], "warnings": [] }
```
```json
{ "error": { "code": "JOB_ALREADY_RUNNING", "message": "We're still working on the previous step.", "details": { "activeJobId": "67330e009f1e4b2a7c0d3c02", "activeJobType": "revise" }, "requestId": "req_01JCXM2G5H6J" } }
```

#### D4. `POST /api/v1/projects/{projectId}/voice` — Switch narrator voice
Purpose: Male ↔ Female on the storyboard (PRD §9). Creates a `user_edit` version whose only change is `voicePreset`; after a video exists the next generation re-records **all** scenes (PIPELINE_DESIGN §9). Auth: creator. Rate: 60/min.
Body: `basePlanVersionId` id ✓ · `voiceGender` `VoiceGender` ✓ (must differ from the current one) · `expectedStateVersion` ✓. Same states/effects as D3 (allowed while a post is `scheduled` or `publish_failed`; that post's approval is cancelled immediately); also sets `project.voiceGender`. Only the voice gender can be switched: the project's **language can't be changed** in V1; to get another language the creator creates a new project (C2) (PRD decision #25).
Success `201` → `PlanVersion`. Errors: `400 INVALID_INPUT` (same gender) · `404` · `409 STALE_VERSION` · `409 INVALID_STATE` · `409 JOB_ALREADY_RUNNING`.
```json
{ "basePlanVersionId": "67330e019f1e4b2a7c0d2b02", "voiceGender": "male", "expectedStateVersion": 4 }
```
Response `201`: `PlanVersion` with `"versionNumber": 3`, `"source": "user_edit"`, `"plan": { …, "voicePreset": "indian-english-male", … }`.
```json
{ "error": { "code": "INVALID_INPUT", "message": "This project already uses the male voice.", "details": { "issues": [ { "path": "voiceGender", "message": "unchanged" } ] }, "requestId": "req_01JCXM2K7L8M" } }
```

#### D5. `POST /api/v1/projects/{projectId}/revisions` — Revision chat
Purpose: plain-language change to the whole storyboard/video or one scene (PRD §6.2, §6.3). Auth: creator. Rate: 20/hour; quota 20 plan+revision requests per project. **Idempotency-Key required.**

| Field | Type | Req | Rules |
|---|---|---|---|
| `stage` | `storyboard` \| `video` | ✓ | `video` when sent from ③ (project must have a `currentRenderId`) |
| `scope` | `project` \| `scene` | ✓ | |
| `sceneId` | SafeId | iff `scope = scene` | Scene of the base plan |
| `message` | string | ✓ | 3–500 chars |
| `basePlanVersionId` | id | ✓ | Must be current |
| `expectedStateVersion` | int | ✓ | |

Allowed states: `storyboard_ready`, `generate_failed`, `video_ready`, `scheduled`, `publish_failed`; no active job. Effect (one transaction, at request time): `revisions` (`pending`), `jobs` (`revise`, key `rev:{revisionId}`), `activeJobId`, `project.planRequestCount + 1` (only if below the limit); a `scheduled` or `publish_failed` post → `approval_invalidated` **immediately** (PRD §7 hard rule: any revision cancels the publish approval when it is *requested*, not when the revision job succeeds; same as D3, D4 and F4) plus an `approval_invalidated` notification; the project state is otherwise unchanged while the job runs; Inngest `revision.requested`. The post stays `approval_invalidated` even if the revision later fails or is rejected; the creator re-approves with H2 or cancels with H5. On success: a new `ai_revision` version becomes current, project → `storyboard_ready` (the creator approves again; a video-stage revision regenerates only changed scenes' narration, PIPELINE_DESIGN §9). A revision can't change the project's language (the new plan keeps `project.language`, PRD decision #25; a request like "make it in Hindi" ends `rejected` with an `assistantReply` suggesting a new project). If the request is ambiguous ("make it better"), the revision ends `rejected` with an `assistantReply` question and no new version (PRD §12).
Success `202` → `{ revision: Revision, job: Job }`.
Errors: `400 INVALID_INPUT` · `404` · `409 STALE_VERSION` · `409 INVALID_STATE` · `409 JOB_ALREADY_RUNNING` · `429 QUOTA_EXCEEDED` (`plan_requests_per_project`, `resetsAt: null`) · `503 SPEND_CEILING`.
```json
{ "stage": "storyboard", "scope": "scene", "sceneId": "scene-flow", "message": "Show this as a step sequence and mention that the PIN is encrypted on the phone.", "basePlanVersionId": "67330e019f1e4b2a7c0d2b02", "expectedStateVersion": 4 }
```
```json
{
  "revision": { "id": "67330e7a9f1e4b2a7c0d4d02", "projectId": "67330d5e9f1e4b2a7c0d2a10", "stage": "storyboard", "scope": "scene", "sceneId": "scene-flow", "message": "Show this as a step sequence and mention that the PIN is encrypted on the phone.", "basePlanVersionId": "67330e019f1e4b2a7c0d2b02", "resultPlanVersionId": null, "status": "pending", "assistantReply": null, "diff": null, "jobId": "67330e7a9f1e4b2a7c0d3c06", "createdAt": "2026-11-12T05:20:00.000Z", "updatedAt": "2026-11-12T05:20:00.000Z" },
  "job": { "id": "67330e7a9f1e4b2a7c0d3c06", "projectId": "67330d5e9f1e4b2a7c0d2a10", "type": "revise", "state": "queued", "attempt": 1, "stages": [ { "name": "plan", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }, { "name": "validate", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null } ], "progress": { "stage": "plan", "percent": 0, "message": "Updating scene 2…" }, "error": null, "needsInput": null, "result": { "revisionId": "67330e7a9f1e4b2a7c0d4d02" }, "cancelRequestedAt": null, "createdAt": "2026-11-12T05:20:00.000Z", "updatedAt": "2026-11-12T05:20:00.000Z", "startedAt": null, "finishedAt": null, "pollAfterMs": 2000 }
}
```
```json
{ "error": { "code": "QUOTA_EXCEEDED", "message": "This project has reached 20 changes. Start a new project to keep going.", "details": { "quota": "plan_requests_per_project", "limit": 20, "used": 20, "resetsAt": null }, "requestId": "req_01JCXM2N9P0Q" } }
```

#### D6. `GET /api/v1/projects/{projectId}/revisions` — Revision chat history
Auth: creator. Query: `stage` optional filter, `limit` (20), `cursor`. Sort: `createdAt` desc.
Success `200` → `{ items: Revision[], nextCursor }`. Errors: `404` · `400 INVALID_INPUT`.
```json
{
  "items": [
    { "id": "67330e009f1e4b2a7c0d4d01", "projectId": "67330d5e9f1e4b2a7c0d2a10", "stage": "storyboard", "scope": "project", "sceneId": null, "message": "Make it shorter and simpler for college students", "basePlanVersionId": "67330d5f9f1e4b2a7c0d2b01", "resultPlanVersionId": "67330e019f1e4b2a7c0d2b02", "status": "succeeded", "assistantReply": "Shortened to 6 scenes (about 70 s) and simplified the bank steps.", "diff": { "changedSceneIds": ["scene-hook", "scene-flow"], "addedSceneIds": [], "removedSceneIds": ["scene-settlement"], "narrationChanged": true }, "jobId": "67330e009f1e4b2a7c0d3c02", "createdAt": "2026-11-12T05:11:58.000Z", "updatedAt": "2026-11-12T05:12:40.000Z" }
  ],
  "nextCursor": null
}
```
```json
{ "error": { "code": "NOT_FOUND", "message": "We couldn't find this project.", "requestId": "req_01JCXM2R1S2T" } }
```

#### D7. `POST /api/v1/projects/{projectId}/plan-versions/{planVersionId}/restore` — Undo / restore
Purpose: **Undo** returns to the previous version (the UI passes `parentVersionId` of the current one) or any older version from history. No data is deleted; the restored version keeps its id and hash, so an **existing approval of that exact version stays valid** (it's the same plan). Auth: creator.
Body: `expectedStateVersion` ✓. Same allowed states as D3. Effect: `currentPlanVersionId = planVersionId`; `approvedPlanVersionId` = that id if it has an approval, else null; state `storyboard_ready` (approving it again with D8 reuses its existing video if one was already made, see D8 "Re-approval"); a `scheduled` or `publish_failed` post → `approval_invalidated` (+ notification), in the same transaction.
Success `200` → `Project`. Errors: `404` · `409 STALE_VERSION` · `409 INVALID_STATE` (already current; active job) · `409 JOB_ALREADY_RUNNING`.
```json
{ "expectedStateVersion": 5 }
```
```json
{ "error": { "code": "INVALID_STATE", "message": "This version is already the current one.", "details": { "reason": "already_current" }, "requestId": "req_01JCXM2V3W4X" } }
```

#### D8. `POST /api/v1/projects/{projectId}/storyboard-approval` — Approve & generate video (approval #1)
Purpose: the creator approves the **exact** plan version and starts generation. Auth: creator. Rate: 10/hour. **Idempotency-Key required.**
Body: `planVersionId` id ✓ · `planHash` `sha256:…` ✓ · `expectedStateVersion` ✓.
Checks (§9) + quota **3 videos/day** + ElevenLabs character budget (estimated from the plan) + spend ceilings. Effect (transaction): `storyboardApprovals` insert, `jobs` (`generate`, key `gen:{planVersionId}`), project `generating`, `approvedPlanVersionId`, `activeJobId`, `usageCounters.videos +1`; Inngest `video.generate.requested` (event id = `gen:{planVersionId}`). If this version was already approved and its generate job is `failed`/`cancelled`, the same job is re-queued (no second approval, no second quota count).

**Re-approval of a version that already has a video (e.g. after undo, D7).** If a `generate` job for this **exact** plan version (`gen:{planVersionId}`, same `planHash`) has already **succeeded**, approving returns that existing result instead of starting work: **no new job, no quota use, no ElevenLabs/spend checks, no Inngest event**. Effect (transaction): the existing approval is reused (no second `storyboardApprovals` row), `project.currentRenderId` = the newest `ready` render of that plan version (including caption fixes made on it), state → `video_ready`, `stateVersion + 1`. Answer `200` → `{ approval, job: <the succeeded generate job>, project }` (`project.state = video_ready`); the UI goes straight to ③ Video.

Success `202` → `{ approval: StoryboardApproval, job: Job, project: Project }` (new or re-queued job) · `200` (same shape) when an existing video is reused.
Errors: `400 INVALID_INPUT` · `404` · `409 STALE_VERSION` · `409 APPROVAL_STALE` (not the current version / hash differs) · `422 PLAN_INVALID` (`details.issues`) · `409 INVALID_STATE` · `409 JOB_ALREADY_RUNNING` · `429 QUOTA_EXCEEDED` (`videos_per_day` or `voice_characters_per_month`) · `503 SPEND_CEILING`.
```http
POST /api/v1/projects/67330d5e9f1e4b2a7c0d2a10/storyboard-approval
Origin: https://bytereel.app
Content-Type: application/json
Idempotency-Key: 4e1d7a20-3c9b-4f5e-8a6d-1b2c3d4e5f60

{ "planVersionId": "67330e019f1e4b2a7c0d2b02", "planHash": "sha256:5d7a0c9e1f3b4a6d8c2e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c", "expectedStateVersion": 5 }
```
```json
{
  "approval": { "id": "67330f109f1e4b2a7c0d5e01", "projectId": "67330d5e9f1e4b2a7c0d2a10", "planVersionId": "67330e019f1e4b2a7c0d2b02", "planHash": "sha256:5d7a0c9e1f3b4a6d8c2e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c", "approvedBy": "67330c1a9f1e4b2a7c0d1e01", "approvedAt": "2026-11-12T05:40:00.000Z" },
  "job": { "id": "67330f109f1e4b2a7c0d3c03", "projectId": "67330d5e9f1e4b2a7c0d2a10", "type": "generate", "state": "queued", "attempt": 1, "stages": [ { "name": "approve", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }, { "name": "speech", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }, { "name": "compile", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }, { "name": "render", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }, { "name": "validate", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null } ], "progress": { "stage": "approve", "percent": 0, "message": "Starting…" }, "error": null, "needsInput": null, "result": null, "cancelRequestedAt": null, "createdAt": "2026-11-12T05:40:00.000Z", "updatedAt": "2026-11-12T05:40:00.000Z", "startedAt": null, "finishedAt": null, "pollAfterMs": 2000 },
  "project": { "id": "67330d5e9f1e4b2a7c0d2a10", "title": "How UPI payments work", "language": "en", "voiceGender": "female", "state": "generating", "currentStep": "video", "thumbnailUrl": null, "latestPost": null, "activeJobType": "generate", "input": { "type": "topic", "text": "How UPI payments work — from scanning the QR code to money reaching the shop", "brainstormChoice": null }, "stateVersion": 6, "currentPlanVersionId": "67330e019f1e4b2a7c0d2b02", "approvedPlanVersionId": "67330e019f1e4b2a7c0d2b02", "currentRenderId": null, "activeJobId": "67330f109f1e4b2a7c0d3c03", "activeJob": null, "lastError": null, "allowedActions": ["cancel_job"], "archivedAt": null, "createdAt": "2026-11-12T05:00:00.000Z", "updatedAt": "2026-11-12T05:40:00.000Z" }
}
```
```json
{ "error": { "code": "APPROVAL_STALE", "message": "Something changed since you reviewed it. Please review again.", "details": { "reason": "plan_hash_mismatch", "currentPlanVersionId": "67330e7a9f1e4b2a7c0d2b03" }, "requestId": "req_01JCXM2Z5A6B" } }
```
```json
{ "error": { "code": "QUOTA_EXCEEDED", "message": "You've reached today's limit of 3 videos. Try again tomorrow.", "details": { "quota": "videos_per_day", "limit": 3, "used": 3, "resetsAt": "2026-11-12T18:30:00.000Z" }, "requestId": "req_01JCXM3A7B8C" } }
```

### 14.5 Jobs

#### E1. `GET /api/v1/jobs/{jobId}` — Job status
Auth: creator (owner of the job). Rate: 120/min. Success `200` → `Job` (§8.2). Errors: `404 NOT_FOUND`.
Example: see §8.2 (running) and §8.3 (`needs_input`). Failed example:
```json
{
  "id": "67330d5f9f1e4b2a7c0d3c01", "projectId": "67330d5e9f1e4b2a7c0d2a10", "type": "plan", "state": "failed", "attempt": 1,
  "stages": [
    { "name": "plan", "status": "failed", "startedAt": "2026-11-12T05:00:01.000Z", "endedAt": "2026-11-12T05:03:05.000Z", "attempts": 3, "error": { "code": "PROVIDER_BUSY", "message": "Gemini returned 503 three times" } },
    { "name": "validate", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }
  ],
  "progress": { "stage": "plan", "percent": 0, "message": "Our AI is very busy right now." },
  "error": { "code": "PROVIDER_BUSY", "message": "Our AI is very busy right now. Your idea is saved; please try again in a few minutes.", "retryable": true },
  "needsInput": null, "result": null, "cancelRequestedAt": null,
  "createdAt": "2026-11-12T05:00:00.000Z", "updatedAt": "2026-11-12T05:03:05.000Z", "startedAt": "2026-11-12T05:00:01.000Z", "finishedAt": "2026-11-12T05:03:05.000Z", "pollAfterMs": null
}
```
```json
{ "error": { "code": "NOT_FOUND", "message": "We couldn't find this job.", "requestId": "req_01JCXM3D9E0F" } }
```

#### E2. `POST /api/v1/jobs/{jobId}/retry` — Retry / resume
Purpose: **Retry** / **Try again** buttons. Resumes from the last good checkpoint; finished stages and paid artifacts are reused (ARCHITECTURE §13.2). Auth: creator. Rate: 30/hour. **Idempotency-Key required.** Body: `{}`.
Allowed: job `failed` with `error.retryable = true`, or a `cancelled` `plan`/`caption` job, or a `failed` `plan` job whose project idea was edited with C4 after the failure (even when `retryable = false`, e.g. `PROVIDER_REJECTED`/`PLAN_INVALID`); no other active job on the project. A `plan` retry always plans from the **current** `project.input` (the job's `inputHash`/key are updated to the edited idea) and never counts toward the projects/day quota; a retry that plans from an edited idea counts 1 toward the per-project plan + revision limit (§10.1). Effect (one transaction): state `queued`, `attempt + 1`, project back to `planning`/`generating`, `activeJobId` set, `lastError` cleared, `project.planRequestCount + 1` when it counts; Inngest event id `{jobId}:retry:{attempt}`. Generate retries re-check the storyboard approval; retries never count toward the daily video quota again. Publish jobs are retried with H6.
Success `202` → `Job`. Errors: `400 INVALID_INPUT` (missing `Idempotency-Key`) · `404` · `409 INVALID_STATE` (not failed / not retryable / publish job) · `409 JOB_ALREADY_RUNNING` · `409 APPROVAL_REQUIRED` (the plan changed since approval) · `503 SPEND_CEILING`.
```json
{}
```
Response `202`: the job with `"state": "queued"`, `"attempt": 2`, `"error": null`, `"pollAfterMs": 2000`.
```json
{ "error": { "code": "INVALID_STATE", "message": "This step can't be retried. Please edit your idea or storyboard instead.", "details": { "jobState": "failed", "retryable": false }, "requestId": "req_01JCXM3G1H2J" } }
```

#### E3. `POST /api/v1/jobs/{jobId}/cancel` — Cancel
Purpose: cancel a queued/running `plan`, `revise`, `generate` or `caption` job (e.g. "cancel the current render" before a revision, PRD §12). Auth: creator. Rate: 30/hour. Body: `{}`.
Effect: `cancelRequestedAt = now`, Inngest `job.cancelled`. The job reaches `cancelled` within one step (seconds, or up to one provider call). Terminal effects: §8.3.
Success `202` → `Job` (still `running` with `cancelRequestedAt` set; poll until `cancelled`). Calling again is harmless (same response).
Errors: `404` · `409 INVALID_STATE` (already terminal, or a publish job: use H5).
```json
{ "error": { "code": "INVALID_STATE", "message": "This job has already finished.", "details": { "jobState": "succeeded" }, "requestId": "req_01JCXM3K3L4M" } }
```

### 14.6 ③ Video

#### F1. `GET /api/v1/projects/{projectId}/renders` — Video versions
Purpose: numbered video versions ("earlier successful versions are never deleted", PRD §6.0). Auth: creator. Query: `status` optional filter, `limit`, `cursor`. Sort: `renderNumber` desc.
Success `200` → `{ items: RenderSummary[], nextCursor }`. Errors: `404` · `400 INVALID_INPUT`.
```json
{
  "items": [
    { "id": "67330f109f1e4b2a7c0d6f01", "projectId": "67330d5e9f1e4b2a7c0d2a10", "renderNumber": 1, "planVersionId": "67330e019f1e4b2a7c0d2b02", "planHash": "sha256:5d7a0c9e1f3b4a6d8c2e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c", "status": "ready", "isCurrent": true, "durationMs": 73000, "mp4Sha256": "sha256:9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d", "bytes": 18734120, "width": 1080, "height": 1920, "fps": 30, "captionOverrideSetId": null, "thumbnailUrl": "https://bytereel-prod.r2.example-account.r2.cloudflarestorage.com/users/67330c1a9f1e4b2a7c0d1e01/projects/67330d5e9f1e4b2a7c0d2a10/renders/67330f109f1e4b2a7c0d6f01/thumbnail.jpg?X-Amz-Expires=900&X-Amz-Signature=3f1c", "error": null, "createdAt": "2026-11-12T05:40:59.000Z", "readyAt": "2026-11-12T05:46:10.000Z" }
  ],
  "nextCursor": null
}
```
```json
{ "error": { "code": "NOT_FOUND", "message": "We couldn't find this project.", "requestId": "req_01JCXM3N5P6Q" } }
```

#### F2. `GET /api/v1/projects/{projectId}/renders/{renderId}` — Render detail + caption phrases
Purpose: player metadata and the **caption correction** list. `renderId` may be the literal **`current`**. `captions[]` are read from the render's `captions.json` (phrase level; `phraseIndex` counts phrases within a scene from 0) and show the applied overrides. Auth: creator.
Success `200` → `Render`. Errors: `404 NOT_FOUND`.
```json
{
  "id": "67330f109f1e4b2a7c0d6f01", "projectId": "67330d5e9f1e4b2a7c0d2a10", "renderNumber": 1,
  "planVersionId": "67330e019f1e4b2a7c0d2b02", "planHash": "sha256:5d7a0c9e1f3b4a6d8c2e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c",
  "status": "ready", "isCurrent": true, "durationMs": 73000, "mp4Sha256": "sha256:9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d", "bytes": 18734120,
  "width": 1080, "height": 1920, "fps": 30, "captionOverrideSetId": null, "thumbnailUrl": null, "error": null,
  "createdAt": "2026-11-12T05:40:59.000Z", "readyAt": "2026-11-12T05:46:10.000Z",
  "captions": [
    { "sceneId": "scene-flow", "phraseIndex": 0, "text": "Your UPI app sends the payment request", "originalText": "Your UPI app sends the payment request", "startMs": 9133, "endMs": 11467, "overridden": false },
    { "sceneId": "scene-flow", "phraseIndex": 1, "text": "to NPCI, the national switch", "originalText": "to NPCI, the national switch", "startMs": 11467, "endMs": 13300, "overridden": false }
  ]
}
```
(`captions` abbreviated to two phrases.)
```json
{ "error": { "code": "NOT_FOUND", "message": "We couldn't find this video.", "requestId": "req_01JCXM3R7S8T" } }
```

#### F3. `GET /api/v1/projects/{projectId}/renders/{renderId}/media` — Media URL
Purpose: play, download or show the thumbnail via a **presigned R2 GET URL** (TTL **15 min**), issued only after the ownership check (ARCHITECTURE §9). `renderId` may be `current`. Auth: creator.
Query: `kind` ✓ — `video` (inline, for the player) · `download` (`Content-Disposition: attachment; filename="<title>.mp4"`) · `thumbnail`; `redirect` boolean (default `false`): `true` → `302 Location: <url>` (handy for `<a href>` downloads).
Success `200` → `{ kind, url, expiresAt }` or `302`. Errors: `400 INVALID_INPUT` · `404` · `409 INVALID_STATE` (render not `ready`).
```http
GET /api/v1/projects/67330d5e9f1e4b2a7c0d2a10/renders/current/media?kind=download
```
```json
{ "kind": "download", "url": "https://bytereel-prod.r2.example-account.r2.cloudflarestorage.com/users/67330c1a9f1e4b2a7c0d1e01/projects/67330d5e9f1e4b2a7c0d2a10/renders/67330f109f1e4b2a7c0d6f01/output.mp4?response-content-disposition=attachment%3B%20filename%3D%22How%20UPI%20payments%20work.mp4%22&X-Amz-Expires=900&X-Amz-Signature=8a2b", "expiresAt": "2026-11-12T06:01:10.000Z" }
```
```json
{ "error": { "code": "INVALID_STATE", "message": "This video is still being made.", "details": { "renderStatus": "rendering" }, "requestId": "req_01JCXM3V9W0X" } }
```

#### F4. `POST /api/v1/projects/{projectId}/renders/{renderId}/caption-overrides` — Caption correction
Purpose: fix caption text (e.g. a technical term) **without changing the narration audio** (PRD §6.3). Saves a new immutable caption-override set and starts a `caption` job (re-compile captions + re-render, no speech; PIPELINE_DESIGN §9). Auth: creator. Rate: 10/hour; does **not** count toward the 3 videos/day quota (decision #24a: only `generate` jobs count). **Idempotency-Key required.**

| Field | Type | Req | Rules |
|---|---|---|---|
| `edits` | array 1–50 of `{ sceneId: SafeId, phraseIndex: int ≥ 0, text: string 1–200 }` | ✓ | Each `(sceneId, phraseIndex)` must exist in this render's captions; unique pairs. Hindi text must be Devanagari, Hinglish Roman (same script rule as the plan) |
| `expectedStateVersion` | int | ✓ | |

`renderId` must be the project's current render (`current` allowed). Allowed states: `video_ready`, `scheduled`, `publish_failed`; no active job. Effect (transaction): `captionOverrides` (new set = previous set's overrides + these edits), `jobs` (`caption`), project `generating`, `activeJobId` (no quota counter changes), a `scheduled` or `publish_failed` post → `approval_invalidated` immediately (+ `approval_invalidated` notification); Inngest `video.recaption.requested`. The UI shows the PRD note "Narration audio is unchanged" and offers "regenerate narration too" (= a D3 narration edit instead).
Success `202` → `{ captionOverrideSetId, job: Job, project: Project }`.
Errors: `400 INVALID_INPUT` (unknown phrase, script) · `404` · `409 STALE_VERSION` · `409 INVALID_STATE` (not the current render / wrong state) · `409 JOB_ALREADY_RUNNING` · `503 SPEND_CEILING`.
```json
{ "edits": [ { "sceneId": "scene-flow", "phraseIndex": 1, "text": "to NPCI — the national switch" } ], "expectedStateVersion": 7 }
```
```json
{
  "captionOverrideSetId": "67330fa09f1e4b2a7c0d7b01",
  "job": { "id": "67330fa09f1e4b2a7c0d3c04", "projectId": "67330d5e9f1e4b2a7c0d2a10", "type": "caption", "state": "queued", "attempt": 1, "stages": [ { "name": "compile", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }, { "name": "render", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }, { "name": "validate", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null } ], "progress": { "stage": "compile", "percent": 0, "message": "Updating captions…" }, "error": null, "needsInput": null, "result": null, "cancelRequestedAt": null, "createdAt": "2026-11-12T06:02:00.000Z", "updatedAt": "2026-11-12T06:02:00.000Z", "startedAt": null, "finishedAt": null, "pollAfterMs": 2000 },
  "project": { "id": "67330d5e9f1e4b2a7c0d2a10", "title": "How UPI payments work", "language": "en", "voiceGender": "female", "state": "generating", "currentStep": "video", "thumbnailUrl": null, "latestPost": null, "activeJobType": "caption", "input": { "type": "topic", "text": "How UPI payments work — from scanning the QR code to money reaching the shop", "brainstormChoice": null }, "stateVersion": 8, "currentPlanVersionId": "67330e019f1e4b2a7c0d2b02", "approvedPlanVersionId": "67330e019f1e4b2a7c0d2b02", "currentRenderId": "67330f109f1e4b2a7c0d6f01", "activeJobId": "67330fa09f1e4b2a7c0d3c04", "activeJob": null, "lastError": null, "allowedActions": ["cancel_job", "download"], "archivedAt": null, "createdAt": "2026-11-12T05:00:00.000Z", "updatedAt": "2026-11-12T06:02:00.000Z" }
}
```
```json
{ "error": { "code": "INVALID_INPUT", "message": "Please check the highlighted captions.", "details": { "issues": [ { "path": "edits[0].phraseIndex", "message": "scene \"scene-flow\" has phrases 0-4; 7 does not exist" } ] }, "requestId": "req_01JCXM3Z1A2B" } }
```

### 14.7 Instagram connection

#### G1. `GET /api/v1/instagram/connection` — Connection status
Auth: creator. Success `200` → `{ connection: InstagramConnection | null }`. Errors: common only.
```json
{ "connection": { "id": "6733101a9f1e4b2a7c0d7a01", "igUserId": "17841400000000001", "username": "physics.with.ananya", "accountType": "MEDIA_CREATOR", "profilePictureUrl": "https://scontent.cdninstagram.com/v/t51.2885-19/profile_example.jpg", "status": "active", "tokenExpiresAt": "2027-01-11T06:10:00.000Z", "connectedAt": "2026-11-12T06:10:00.000Z", "lastRefreshedAt": "2026-11-12T06:10:00.000Z" } }
```
```json
{ "error": { "code": "UNAUTHENTICATED", "message": "Please log in again.", "requestId": "req_01JCXM4A3B4C" } }
```

#### G2. `GET /api/v1/instagram/connect` — Start OAuth
Purpose: **Connect Instagram** (top-level browser navigation, not `fetch`). Auth: creator (unauthenticated → `302 /login?next=…`). Rate: 10/hour.
Query: `returnTo` optional — `settings` (default) or `publish:<projectId>` (must be the user's project).
Effect: builds `state = sign({ sessionId, nonce, returnTo, exp: now + 10 min })` (HMAC with `BETTER_AUTH_SECRET`-derived key; nothing stored) → `302` to `https://www.instagram.com/oauth/authorize?client_id=…&redirect_uri=https://<domain>/api/v1/instagram/callback&scope=instagram_business_basic,instagram_business_content_publish&response_type=code&state=…` (ARCHITECTURE §17.2).
Success `302`. Errors: `400 INVALID_INPUT` (bad `returnTo`, JSON) · `404 NOT_FOUND` (foreign project in `returnTo`).
```http
GET /api/v1/instagram/connect?returnTo=publish:67330d5e9f1e4b2a7c0d2a10

HTTP/1.1 302 Found
Location: https://www.instagram.com/oauth/authorize?client_id=1234567890&redirect_uri=https%3A%2F%2Fbytereel.app%2Fapi%2Fv1%2Finstagram%2Fcallback&scope=instagram_business_basic%2Cinstagram_business_content_publish&response_type=code&state=eyJzIjoi...sig
```
```json
{ "error": { "code": "INVALID_INPUT", "message": "Please check the highlighted fields.", "details": { "issues": [ { "path": "returnTo", "message": "must be settings or publish:<projectId>" } ] }, "requestId": "req_01JCXM4D5E6F" } }
```

#### G3. `GET /api/v1/instagram/callback` — OAuth callback
Purpose: Meta redirects here. Auth: the session cookie **and** a valid `state` bound to that session.
Query: `code`, `state` (success) or `error`, `error_reason`, `error_description`, `state` (user denied).
Effect: verify `state` (signature, expiry, `sessionId` = current session) → exchange `code` for a short-lived token → long-lived token (~60 days) → `GET /me?fields=user_id,username,account_type,profile_picture_url` → require `BUSINESS` or `MEDIA_CREATOR` → **reject if this `igUserId` already has an `active` connection owned by a different user** (`INSTAGRAM_ACCOUNT_IN_USE`; nothing is stored and the new token is discarded) → encrypt (AES-256-GCM) and upsert `instagramConnections`. One Instagram account per ByteReel user is enforced both ways (PRD decision #24d): unique `ownerId` (a user has one connection) **and** a unique partial index on `igUserId` where `status = active` (an Instagram account belongs to one user); the index also catches two users finishing OAuth at the same moment (duplicate-key error → `INSTAGRAM_ACCOUNT_IN_USE`). Reconnecting a **different** account invalidates `scheduled` and `publish_failed` posts (`approval_invalidated`, notification). Audit `instagram.connected`. The calls to Meta happen first; the database writes (connection upsert, posts invalidated, notifications, audit) are **one transaction** (DATABASE.md §7).
Success: `302` to `/settings?instagram=connected` or `/projects/{id}/publish?instagram=connected`.
Errors (a `302` back to the `returnTo` page, always in the one format `?instagram_error=<CODE>[&reason=<reason>]`): `?instagram_error=INSTAGRAM_ACCOUNT_INELIGIBLE` · `?instagram_error=INSTAGRAM_ACCOUNT_IN_USE` · `?instagram_error=INSTAGRAM_OAUTH_FAILED&reason=access_denied|invalid_state|exchange_failed`. No session → `302 /login`. Only a malformed call that can't be tied to any flow (neither `code` nor `error`, or no `state`) gets a JSON `400 INVALID_INPUT`.
```http
GET /api/v1/instagram/callback?code=AQBx...#_&state=eyJzIjoi...sig

HTTP/1.1 302 Found
Location: /projects/67330d5e9f1e4b2a7c0d2a10/publish?instagram=connected
```
```http
HTTP/1.1 302 Found
Location: /projects/67330d5e9f1e4b2a7c0d2a10/publish?instagram_error=INSTAGRAM_ACCOUNT_INELIGIBLE
```

#### G4. `DELETE /api/v1/instagram/connection` — Disconnect
Auth: creator. Body: none. Effect (transaction): token ciphertext removed, `status = revoked`, `revokedAt`; every `scheduled` or `publish_failed` post of the user → `approval_invalidated` (+ notification); audit `instagram.disconnected`. A post that is `publishing` right now → `409 INVALID_STATE` (try again in a few minutes).
Success `200` → `{ connection: InstagramConnection }` (status `revoked`). Errors: `404 NOT_FOUND` (no connection) · `409 INVALID_STATE`.
```json
{ "connection": { "id": "6733101a9f1e4b2a7c0d7a01", "igUserId": "17841400000000001", "username": "physics.with.ananya", "accountType": "MEDIA_CREATOR", "profilePictureUrl": null, "status": "revoked", "tokenExpiresAt": "2027-01-11T06:10:00.000Z", "connectedAt": "2026-11-12T06:10:00.000Z", "lastRefreshedAt": "2026-11-12T06:10:00.000Z" } }
```
```json
{ "error": { "code": "NOT_FOUND", "message": "No Instagram account is connected.", "requestId": "req_01JCXM4G7H8J" } }
```

### 14.8 ④ Publish

#### H1. `POST /api/v1/projects/{projectId}/caption-suggestions` — AI caption + hashtags
Purpose: AI-suggested Instagram caption and hashtags in the project language (synchronous Gemini call, 30 s timeout). Not stored; the creator edits it before H2. Auth: creator. Rate: 10/hour.
Body: `renderId` id ✓ (current render; `current` allowed).
Success `200` → `{ caption (≤ 2,000), hashtags: string[] (≤ 30, each `#` + 1–100 chars, no spaces), language }`.
Errors: `400 INVALID_INPUT` · `404` · `409 INVALID_STATE` (render not ready) · `422 PROVIDER_REJECTED` · `503 PROVIDER_BUSY` · `503 SPEND_CEILING`.
```json
{ "renderId": "current" }
```
```json
{
  "caption": "Ever wondered how ₹20 reaches the chaiwala before you put your phone back in your pocket? Here's the 2-second journey of a UPI payment 👇",
  "hashtags": ["#UPI", "#DigitalIndia", "#FinanceBasics", "#LearnOnInstagram", "#NPCI"],
  "language": "en"
}
```
```json
{ "error": { "code": "PROVIDER_BUSY", "message": "Our AI is very busy right now. Your idea is saved; please try again in a few minutes.", "requestId": "req_01JCXM4K9L0M" } }
```

#### H2. `POST /api/v1/projects/{projectId}/posts` — Publish now or schedule (approval #2)
Purpose: the creator approves the **exact video + destination + caption** and publishes now or at a time. Auth: creator. Rate: 10/hour. **Idempotency-Key required.**

| Field | Type | Req | Rules |
|---|---|---|---|
| `mode` | `now` \| `scheduled` | ✓ | |
| `renderId` | id | ✓ | Current, `ready` render (no `current` alias here: the client must name what it showed) |
| `mp4Sha256` | `sha256:…` | ✓ | Must equal the render's `mp4Sha256` |
| `connectionId` | id | ✓ | The user's `active` connection |
| `caption` | string | ✓ | 1–2,200 chars incl. hashtags (Instagram limit; ≤ 30 hashtags) |
| `scheduledAt` | ISO-8601 with offset | iff `mode = scheduled` | **≥ now + 10 min** and **≤ now + 75 days**; stored in UTC |
| `expectedStateVersion` | int | ✓ | |

Allowed states: `video_ready`, `publish_failed`; or `scheduled` with an `approval_invalidated` post (re-approval). One live post per project (partial unique index on `scheduled`/`publishing`/`outcome_unknown`); a project that is already `published` → `409 INVALID_STATE` (one video per project, V1).
Effect (transaction): `posts` insert with `approval` snapshot (with a new `approval.id`) and `publishKey = pub:{projectId}:{renderId}:{connectionId}:{approvalId}` (unique). Because the key contains the approval id, **every new approval gets its own key**: re-approving after a failure, after an `approval_invalidated` post or after suspend/reactivate makes a new post, while everything that belongs to the **same** approval (a double-click replayed by the `Idempotency-Key`, a re-delivered Inngest event, H6/I9 retries of that post) can never publish twice. A second, separate click that creates another approval is stopped by the one-live-post index (`409 INVALID_STATE`); `jobs` (`publish`), project → `publishing` (now) or `scheduled`; audit `post.approved`; Inngest `post.publish.requested` (with `ts = scheduledAt` when scheduled).
Success `202` → `{ post: Post, job: Job, project: Project }`.
Errors: `400 INVALID_INPUT` (time window, caption length, hashtags) · `404` · `409 STALE_VERSION` · `409 APPROVAL_STALE` (`details.reason`: `render_not_current`, `mp4_hash_mismatch`, `connection_changed`) · `409 INSTAGRAM_NOT_CONNECTED` · `409 INSTAGRAM_TOKEN_EXPIRED` · `409 INVALID_STATE` · `409 JOB_ALREADY_RUNNING`.
```http
POST /api/v1/projects/67330d5e9f1e4b2a7c0d2a10/posts
Origin: https://bytereel.app
Content-Type: application/json
Idempotency-Key: c0ffee00-1d2e-4f3a-9b8c-7d6e5f4a3b2c

{
  "mode": "scheduled",
  "renderId": "67330fa09f1e4b2a7c0d6f02",
  "mp4Sha256": "sha256:1f2e3d4c5b6a79880a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f",
  "connectionId": "6733101a9f1e4b2a7c0d7a01",
  "caption": "Ever wondered how ₹20 reaches the chaiwala in 2 seconds? Here's the journey of a UPI payment 👇\n\n#UPI #DigitalIndia #FinanceBasics",
  "scheduledAt": "2026-11-13T19:00:00+05:30",
  "expectedStateVersion": 9
}
```
```json
{
  "post": {
    "id": "673310209f1e4b2a7c0d8b01", "state": "scheduled", "mode": "scheduled", "scheduledAt": "2026-11-13T13:30:00.000Z", "permalink": null,
    "projectId": "67330d5e9f1e4b2a7c0d2a10", "renderId": "67330fa09f1e4b2a7c0d6f02", "connectionId": "6733101a9f1e4b2a7c0d7a01",
    "caption": "Ever wondered how ₹20 reaches the chaiwala in 2 seconds? Here's the journey of a UPI payment 👇\n\n#UPI #DigitalIndia #FinanceBasics",
    "jobId": "673310209f1e4b2a7c0d3c05",
    "approval": { "id": "673310209f1e4b2a7c0d8e01", "renderId": "67330fa09f1e4b2a7c0d6f02", "mp4Sha256": "sha256:1f2e3d4c5b6a79880a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f", "connectionId": "6733101a9f1e4b2a7c0d7a01", "igUserId": "17841400000000001", "captionHash": "sha256:7b3c9d1e5f2a4b6c8d0e1f3a5b7c9d2e4f6a8b0c1d3e5f7a9b2c4d6e8f0a1b3c", "approvedBy": "67330c1a9f1e4b2a7c0d1e01", "approvedAt": "2026-11-12T06:20:00.000Z" },
    "destination": { "username": "physics.with.ananya", "profilePictureUrl": "https://scontent.cdninstagram.com/v/t51.2885-19/profile_example.jpg" },
    "igMediaId": null, "attempts": 0, "nextAttemptAt": null, "lastError": null, "publishedAt": null,
    "createdAt": "2026-11-12T06:20:00.000Z", "updatedAt": "2026-11-12T06:20:00.000Z"
  },
  "job": { "id": "673310209f1e4b2a7c0d3c05", "projectId": "67330d5e9f1e4b2a7c0d2a10", "type": "publish", "state": "queued", "attempt": 1, "stages": [ { "name": "approve", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }, { "name": "create_container", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }, { "name": "poll", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null }, { "name": "publish", "status": "pending", "startedAt": null, "endedAt": null, "attempts": 0, "error": null } ], "progress": { "stage": "approve", "percent": 0, "message": "Scheduled for 13 Nov, 7:00 pm" }, "error": null, "needsInput": null, "result": { "postId": "673310209f1e4b2a7c0d8b01" }, "cancelRequestedAt": null, "createdAt": "2026-11-12T06:20:00.000Z", "updatedAt": "2026-11-12T06:20:00.000Z", "startedAt": null, "finishedAt": null, "pollAfterMs": null },
  "project": { "id": "67330d5e9f1e4b2a7c0d2a10", "title": "How UPI payments work", "language": "en", "voiceGender": "female", "state": "scheduled", "currentStep": "publish", "thumbnailUrl": null, "latestPost": { "id": "673310209f1e4b2a7c0d8b01", "state": "scheduled", "mode": "scheduled", "scheduledAt": "2026-11-13T13:30:00.000Z", "permalink": null }, "activeJobType": null, "input": { "type": "topic", "text": "How UPI payments work — from scanning the QR code to money reaching the shop", "brainstormChoice": null }, "stateVersion": 10, "currentPlanVersionId": "67330e019f1e4b2a7c0d2b02", "approvedPlanVersionId": "67330e019f1e4b2a7c0d2b02", "currentRenderId": "67330fa09f1e4b2a7c0d6f02", "activeJobId": null, "activeJob": null, "lastError": null, "allowedActions": ["rename", "download", "cancel_post", "request_revision", "edit_captions"], "archivedAt": null, "createdAt": "2026-11-12T05:00:00.000Z", "updatedAt": "2026-11-12T06:20:00.000Z" }
}
```
(A scheduled publish job's `pollAfterMs` is `null` until the scheduled time; the UI shows the schedule instead of polling. For `mode: "now"` the post starts in `publishing`, the project in `publishing`, and `pollAfterMs` is 2000.)

Publish-now request body: `{ "mode": "now", "renderId": "…", "mp4Sha256": "…", "connectionId": "…", "caption": "…", "expectedStateVersion": 9 }`.
```json
{ "error": { "code": "INVALID_INPUT", "message": "Pick a time at least 10 minutes from now.", "details": { "issues": [ { "path": "scheduledAt", "message": "must be between 2026-11-12T06:30:00.000Z and 2027-01-26T06:20:00.000Z" } ] }, "requestId": "req_01JCXM4N1P2Q" } }
```
```json
{ "error": { "code": "INSTAGRAM_TOKEN_EXPIRED", "message": "Instagram needs reconnecting. Your scheduled posts are paused, nothing is lost.", "requestId": "req_01JCXM4R3S4T" } }
```

#### H3. `GET /api/v1/projects/{projectId}/posts` — Posts of a project
Auth: creator. Query: `limit`, `cursor`. Sort: `createdAt` desc. Success `200` → `{ items: Post[], nextCursor }`. Errors: `404` · `400 INVALID_INPUT`.
```json
{ "items": [], "nextCursor": null }
```
```json
{ "error": { "code": "NOT_FOUND", "message": "We couldn't find this project.", "requestId": "req_01JCXM4V5W6X" } }
```

#### H4. `GET /api/v1/posts/{postId}` — Post status
Purpose: publish progress + success link. Poll every 2 s while `state` is `publishing` or `outcome_unknown`. Auth: creator. Rate: 120/min. Success `200` → `Post`. Errors: `404`.
```json
{
  "id": "673310209f1e4b2a7c0d8b01", "state": "published", "mode": "scheduled", "scheduledAt": "2026-11-13T13:30:00.000Z", "permalink": "https://www.instagram.com/reel/DCx9AbCdEfG/",
  "projectId": "67330d5e9f1e4b2a7c0d2a10", "renderId": "67330fa09f1e4b2a7c0d6f02", "connectionId": "6733101a9f1e4b2a7c0d7a01",
  "caption": "Ever wondered how ₹20 reaches the chaiwala in 2 seconds? Here's the journey of a UPI payment 👇\n\n#UPI #DigitalIndia #FinanceBasics",
  "jobId": "673310209f1e4b2a7c0d3c05",
  "approval": { "id": "673310209f1e4b2a7c0d8e01", "renderId": "67330fa09f1e4b2a7c0d6f02", "mp4Sha256": "sha256:1f2e3d4c5b6a79880a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f", "connectionId": "6733101a9f1e4b2a7c0d7a01", "igUserId": "17841400000000001", "captionHash": "sha256:7b3c9d1e5f2a4b6c8d0e1f3a5b7c9d2e4f6a8b0c1d3e5f7a9b2c4d6e8f0a1b3c", "approvedBy": "67330c1a9f1e4b2a7c0d1e01", "approvedAt": "2026-11-12T06:20:00.000Z" },
  "destination": { "username": "physics.with.ananya", "profilePictureUrl": "https://scontent.cdninstagram.com/v/t51.2885-19/profile_example.jpg" },
  "igMediaId": "17900000000000001", "attempts": 1, "nextAttemptAt": null, "lastError": null, "publishedAt": "2026-11-13T13:31:42.000Z",
  "createdAt": "2026-11-12T06:20:00.000Z", "updatedAt": "2026-11-13T13:31:43.000Z"
}
```
```json
{ "error": { "code": "NOT_FOUND", "message": "We couldn't find this post.", "requestId": "req_01JCXM4Z7A8B" } }
```

#### H5. `POST /api/v1/posts/{postId}/cancel` — Cancel a scheduled post
Auth: creator. Rate: 10/hour. Body: `{}`. Allowed: `scheduled` or `approval_invalidated`. Effect: conditional update `state: scheduled → cancelled`, job cancelled (`job.cancelled`), project → `video_ready`. Calling it on an already `cancelled` post returns `200` with the post.
Success `200` → `Post`. Errors: `404` · `409 INVALID_STATE` (`publishing`, `published`, …).
```json
{ "error": { "code": "INVALID_STATE", "message": "This post is being published right now and can't be cancelled.", "details": { "postState": "publishing" }, "requestId": "req_01JCXM5A9B0C" } }
```

#### H6. `POST /api/v1/posts/{postId}/retry` — Retry a failed publish
Auth: creator. Rate: 10/hour. **Idempotency-Key required.** Body: `{}`.
Allowed: `publish_failed`. The **approval is re-checked** with the full re-check of §9 (render still current and the project's current/approved plan still the one it was made from, same hash, project not archived, user `active`, connection active and same `igUserId`); if anything changed → `409 APPROVAL_STALE` and the creator approves again with H2. Effect: post → `publishing`, `attempts + 1`, publish job re-queued (reusing the container if it's still valid, ARCHITECTURE §17.4).
Success `202` → `{ post: Post, job: Job }`. Errors: `400 INVALID_INPUT` (missing `Idempotency-Key`) · `404` · `409 INVALID_STATE` · `409 APPROVAL_STALE` · `409 INSTAGRAM_TOKEN_EXPIRED` · `409 INSTAGRAM_NOT_CONNECTED`.
```json
{ "error": { "code": "APPROVAL_STALE", "message": "The video changed after you approved it. Please review and approve again.", "details": { "reason": "render_not_current" }, "requestId": "req_01JCXM5D1E2F" } }
```

### 14.9 Admin (`role = admin`; every call audit-logged)

All admin endpoints: auth **admin** (`403 FORBIDDEN`, `details.reason: "admin_only"` for creators), rate 120/min, lists use `limit` 1–100 (50) + `cursor`. Admins see **metadata only** (no plan text, captions, videos or tokens) except what a list explicitly shows.

#### I1. `GET /api/v1/admin/allowlist` — List allow-list
Query: `q` (email prefix, optional), `limit`, `cursor`. Sort: `createdAt` desc. Success `200` → `{ items: AllowlistEntry[], nextCursor }` where `AllowlistEntry = { id, email, note, invitedBy, createdAt, signedUpUserId | null }`.
```json
{ "items": [ { "id": "67330b009f1e4b2a7c0d0a01", "email": "ananya.iyer@example.in", "note": "Physics teacher, Pune (beta wave 1)", "invitedBy": "67330a009f1e4b2a7c0d0001", "createdAt": "2026-11-12T03:00:00.000Z", "signedUpUserId": "67330c1a9f1e4b2a7c0d1e01" } ], "nextCursor": null }
```
```json
{ "error": { "code": "FORBIDDEN", "message": "You don't have access to this page.", "details": { "reason": "admin_only" }, "requestId": "req_01JCXM5G3H4J" } }
```

#### I2. `POST /api/v1/admin/allowlist` — Add email
Body: `email` valid email ≤ 254 (lowercased) ✓ · `note` string ≤ 200 (optional). Success `201` → `AllowlistEntry`. Errors: `400 INVALID_INPUT` · `409 ALREADY_EXISTS`.
```json
{ "email": "Rohit.Verma@example.in", "note": "Class 10 maths YouTuber, Jaipur" }
```
```json
{ "id": "67330b109f1e4b2a7c0d0a02", "email": "rohit.verma@example.in", "note": "Class 10 maths YouTuber, Jaipur", "invitedBy": "67330a009f1e4b2a7c0d0001", "createdAt": "2026-11-12T07:00:00.000Z", "signedUpUserId": null }
```
```json
{ "error": { "code": "ALREADY_EXISTS", "message": "This email is already on the allow-list.", "requestId": "req_01JCXM5K5L6M" } }
```

#### I3. `DELETE /api/v1/admin/allowlist/{entryId}` — Remove email
Removes future sign-up rights only; an existing account is not affected (suspend it with I6). Success `200` → `{ deleted: true }`. Errors: `404`.
```json
{ "deleted": true }
```
```json
{ "error": { "code": "NOT_FOUND", "message": "Allow-list entry not found.", "requestId": "req_01JCXM5N7P8Q" } }
```

#### I4. `GET /api/v1/admin/users` — List users
Query: `q` (name/email prefix), `status` (`active`\|`suspended`\|`deleting`), `limit`, `cursor`. Sort: `createdAt` desc.
Success `200` → `{ items: AdminUser[], nextCursor }`, `AdminUser = { id, name, email, role, status, createdAt, lastLoginAt | null, lockedUntil | null, projectCount, videosThisMonth, estCostInrThisMonth, instagramUsername | null }`.
```json
{ "items": [ { "id": "67330c1a9f1e4b2a7c0d1e01", "name": "Ananya Iyer", "email": "ananya.iyer@example.in", "role": "creator", "status": "active", "createdAt": "2026-11-12T04:30:00.000Z", "lastLoginAt": "2026-11-12T04:30:00.000Z", "lockedUntil": null, "projectCount": 3, "videosThisMonth": 2, "estCostInrThisMonth": 41.5, "instagramUsername": "physics.with.ananya" } ], "nextCursor": null }
```
```json
{ "error": { "code": "INVALID_INPUT", "message": "Please check the highlighted fields.", "details": { "issues": [ { "path": "status", "message": "must be one of active, suspended, deleting" } ] }, "requestId": "req_01JCXM5R9S0T" } }
```

#### I5. `GET /api/v1/admin/users/{userId}` — User detail
Success `200` → `AdminUser & { usage: { videosToday, projectsToday, voiceCharactersThisMonth } (Usage), recentJobs: AdminJob[] (last 10), failedLoginCount }`. Errors: `404`.
```json
{ "id": "67330c1a9f1e4b2a7c0d1e01", "name": "Ananya Iyer", "email": "ananya.iyer@example.in", "role": "creator", "status": "active", "createdAt": "2026-11-12T04:30:00.000Z", "lastLoginAt": "2026-11-12T04:30:00.000Z", "lockedUntil": null, "projectCount": 3, "videosThisMonth": 2, "estCostInrThisMonth": 41.5, "instagramUsername": "physics.with.ananya", "failedLoginCount": 0, "usage": { "videosToday": { "used": 1, "limit": 3, "resetsAt": "2026-11-12T18:30:00.000Z" }, "projectsToday": { "used": 2, "limit": 5, "resetsAt": "2026-11-12T18:30:00.000Z" }, "voiceCharactersThisMonth": { "used": 1180, "limit": 3000, "resetsAt": "2026-11-30T18:30:00.000Z" } }, "recentJobs": [] }
```
```json
{ "error": { "code": "NOT_FOUND", "message": "User not found.", "requestId": "req_01JCXM5V1W2X" } }
```

#### I6. `PATCH /api/v1/admin/users/{userId}` — Suspend / reactivate
Body: `status` `active` \| `suspended` ✓ · `reason` string ≤ 200 (required when suspending). Admins can't change their own status. A `deleting` user can only be **restored** (`status: active`) before the request's `eraseAfter` (30-day grace period; the `deletionRequests` record becomes `cancelled`, posts stay cancelled, Instagram must be connected again); after that → `409 INVALID_STATE`. Suspending (transaction): `status = suspended`, all sessions deleted, active jobs `cancelRequestedAt`, `scheduled` and `publish_failed` posts → `approval_invalidated`. Reactivating also clears `lockedUntil`/`failedLoginCount`.
Success `200` → `AdminUser`. Errors: `400 INVALID_INPUT` · `404` · `409 INVALID_STATE` (self / deleting).
```json
{ "status": "suspended", "reason": "Repeated attempts to generate unsafe content" }
```
```json
{ "error": { "code": "INVALID_STATE", "message": "You can't suspend your own account.", "details": { "reason": "self" }, "requestId": "req_01JCXM5Z3A4B" } }
```

#### I7. `POST /api/v1/admin/users/{userId}/password-reset-links` — Create a one-time reset link
Flow in §3.5. Body: `{}`. Only for `active`/`suspended` users (suspended users can reset but still can't log in until reactivated). Any previous unused link for the user is invalidated.
Success `201` → `{ url, expiresAt }` (**shown once**; the token is stored only in `verification` and never returned again or logged). Errors: `404` · `409 INVALID_STATE` (`deleting`).
```json
{ "url": "https://bytereel.app/reset-password?token=x7Qp2sVb9LmN4cRt8wYz1aBcDeFgHiJk3LmNoPqRsTu", "expiresAt": "2026-11-12T08:00:00.000Z" }
```
```json
{ "error": { "code": "NOT_FOUND", "message": "User not found.", "requestId": "req_01JCXM6A5B6C" } }
```

#### I8. `GET /api/v1/admin/jobs` — Jobs
Query: `state` (job state), `type`, `ownerId`, `stuck` boolean (`running` with no update for > 30 min), `from`/`to` (ISO), `limit`, `cursor`. Sort: `updatedAt` desc.
Success `200` → `{ items: AdminJob[], nextCursor }`, `AdminJob = Job & { ownerId, ownerEmail, inngestRunId | null, idempotencyKey }`.
```json
{ "items": [ { "id": "67330d5f9f1e4b2a7c0d3c01", "projectId": "67330d5e9f1e4b2a7c0d2a10", "type": "plan", "state": "failed", "attempt": 1, "stages": [], "progress": { "stage": "plan", "percent": 0, "message": "Our AI is very busy right now." }, "error": { "code": "PROVIDER_BUSY", "message": "Gemini returned 503 three times", "retryable": true }, "needsInput": null, "result": null, "cancelRequestedAt": null, "createdAt": "2026-11-12T05:00:00.000Z", "updatedAt": "2026-11-12T05:03:05.000Z", "startedAt": "2026-11-12T05:00:01.000Z", "finishedAt": "2026-11-12T05:03:05.000Z", "pollAfterMs": null, "ownerId": "67330c1a9f1e4b2a7c0d1e01", "ownerEmail": "ananya.iyer@example.in", "inngestRunId": "01JCXJZ8Y6V5T4S3R2Q1P0N9M8", "idempotencyKey": "plan:67330d5e9f1e4b2a7c0d2a10:sha256:3c4d" } ], "nextCursor": null }
```
```json
{ "error": { "code": "INVALID_INPUT", "message": "Please check the highlighted fields.", "details": { "issues": [ { "path": "state", "message": "must be one of queued, running, succeeded, failed, needs_input, cancelled" } ] }, "requestId": "req_01JCXM6D7E8F" } }
```

#### I9. `POST /api/v1/admin/jobs/{jobId}/retry` — Retry any user's job
Same rules as E2 (including the approval re-check) but without the ownership filter, and also allowed for `publish` jobs in `publish_failed` (the same full publish re-check as H6/§9: project not archived, user `active`, render and plan still the approved ones, connection unchanged). **Idempotency-Key required.** Body: `{}`. Audit `admin.job_retried`.
Success `202` → `AdminJob`. Errors: `400 INVALID_INPUT` (missing `Idempotency-Key`) · `404` · `409 INVALID_STATE` · `409 JOB_ALREADY_RUNNING` · `409 APPROVAL_REQUIRED` · `409 APPROVAL_STALE`.
```json
{ "error": { "code": "JOB_ALREADY_RUNNING", "message": "This project already has a running job.", "details": { "activeJobId": "67330f109f1e4b2a7c0d3c03" }, "requestId": "req_01JCXM6G9H0J" } }
```

#### I10. `GET /api/v1/admin/usage` — Spend, ceilings and metrics
Query: `from`, `to` (ISO dates; default: today in IST), `groupBy` `provider` \| `user` \| `day` (default `provider`).
Success `200` → `{ from, to, totals: { estCostInr, calls }, groups: [{ key, calls, units: { promptTokens, outputTokens, characters, renderSeconds }, estCostInr }], ceilings: [{ name, used, limit, percent, period }], metrics: { videosGenerated, renderSuccessRate, medianIdeaToVideoSeconds, medianRenderSeconds, avgRevisionsPerProject, publishSuccessRate } }` (ARCHITECTURE §24.2).
```json
{
  "from": "2026-11-11T18:30:00.000Z", "to": "2026-11-12T18:30:00.000Z",
  "totals": { "estCostInr": 186.4, "calls": 212 },
  "groups": [
    { "key": "gemini", "calls": 61, "units": { "promptTokens": 512000, "outputTokens": 148000, "characters": 0, "renderSeconds": 0 }, "estCostInr": 22.1 },
    { "key": "elevenlabs", "calls": 118, "units": { "promptTokens": 0, "outputTokens": 0, "characters": 19650, "renderSeconds": 0 }, "estCostInr": 98.0 },
    { "key": "vercel-sandbox", "calls": 21, "units": { "promptTokens": 0, "outputTokens": 0, "characters": 0, "renderSeconds": 5880 }, "estCostInr": 66.3 },
    { "key": "meta", "calls": 12, "units": { "promptTokens": 0, "outputTokens": 0, "characters": 0, "renderSeconds": 0 }, "estCostInr": 0 }
  ],
  "ceilings": [
    { "name": "elevenlabs_characters_month", "used": 7420, "limit": 9000, "percent": 82.4, "period": "month" },
    { "name": "gemini_requests_day", "used": 61, "limit": 400, "percent": 15.3, "period": "day" },
    { "name": "sandbox_render_minutes_day", "used": 98, "limit": 240, "percent": 40.8, "period": "day" },
    { "name": "spend_inr_day", "used": 186.4, "limit": 1000, "percent": 18.6, "period": "day" }
  ],
  "metrics": { "videosGenerated": 21, "renderSuccessRate": 0.98, "medianIdeaToVideoSeconds": 412, "medianRenderSeconds": 268, "avgRevisionsPerProject": 1.4, "publishSuccessRate": 1.0 }
}
```
```json
{ "error": { "code": "INVALID_INPUT", "message": "Please check the highlighted fields.", "details": { "issues": [ { "path": "to", "message": "must be after from and at most 92 days later" } ] }, "requestId": "req_01JCXM6K1L2M" } }
```

#### I11. `GET /api/v1/admin/settings` — Global settings
Success `200` → `Settings`:
```json
{
  "version": 3,
  "maintenance": { "active": false, "message": null },
  "limits": { "videosPerUserPerDay": 3, "projectsPerUserPerDay": 5, "planRequestsPerProject": 20, "voiceCharactersPerUserPerMonth": 3000 },
  "ceilings": { "elevenLabsCharactersPerMonth": 9000, "geminiRequestsPerDay": 400, "sandboxRenderMinutesPerDay": 240, "spendInrPerDay": 1000 },
  "models": { "planner": "gemini-3.6-flash", "speech": "eleven_multilingual_v2" },
  "voices": { "enabledPresets": ["indian-english-male", "indian-english-female", "hindi-male", "hindi-female", "hinglish-male", "hinglish-female"] },
  "updatedAt": "2026-11-12T03:00:00.000Z",
  "updatedBy": "67330a009f1e4b2a7c0d0001"
}
```
```json
{ "error": { "code": "FORBIDDEN", "message": "You don't have access to this page.", "details": { "reason": "admin_only" }, "requestId": "req_01JCXM6N3P4Q" } }
```

#### I12. `PUT /api/v1/admin/settings` — Update settings
Body: the full `Settings` object without `version`/`updatedAt`/`updatedBy`, plus `expectedVersion` int ✓. Ranges: `videosPerUserPerDay` 0–50, `projectsPerUserPerDay` 0–100, `planRequestsPerProject` 1–200, `voiceCharactersPerUserPerMonth` 0–1,000,000, ceilings ≥ 0, `models.planner` matches `^gemini-[a-z0-9.-]+$`, `models.speech` matches `^eleven_[a-z0-9_]+$`, `enabledPresets` ⊆ `VoicePreset` and not empty, `maintenance.message` ≤ 300. Cached for 60 s per server instance (ARCHITECTURE §8.16), so changes apply within a minute.
Success `200` → `Settings` (version + 1). Errors: `400 INVALID_INPUT` · `409 STALE_VERSION` (`details.currentVersion`).
```json
{ "error": { "code": "STALE_VERSION", "message": "Settings were changed by someone else. Reload and try again.", "details": { "expectedVersion": 3, "currentVersion": 4 }, "requestId": "req_01JCXM6R5S6T" } }
```

### 14.10 Meta callbacks (ARCHITECTURE §21.3, §22)

Both callbacks receive `application/x-www-form-urlencoded` with one field `signed_request` = `<base64url HMAC-SHA256 signature>.<base64url JSON payload>`. The signature is verified with `META_APP_SECRET` (constant-time compare, `algorithm = HMAC-SHA256`); payload `{ user_id: "<igUserId>", algorithm, issued_at }`. Exempt from the Origin check. Rate: 60/min per IP.

#### J1. `POST /api/v1/meta/deauthorize` — Deauthorize callback
Effect: find connections with `igUserId = user_id` → `status = revoked`, token ciphertext removed, `scheduled` and `publish_failed` posts → `approval_invalidated`, notification `instagram_reconnect`, audit `instagram.deauthorized`, all in **one transaction** (DATABASE.md §7). Unknown `user_id` is fine (still `200`, nothing to do).
Success `200` → `{ "received": true }`. Errors: `400 INVALID_SIGNATURE` · `400 INVALID_INPUT` (missing field).
```http
POST /api/v1/meta/deauthorize
Content-Type: application/x-www-form-urlencoded

signed_request=Zm9vYmFyc2lnbmF0dXJl.eyJ1c2VyX2lkIjoiMTc4NDE0MDAwMDAwMDAwMDEiLCJhbGdvcml0aG0iOiJITUFDLVNIQTI1NiIsImlzc3VlZF9hdCI6MTc5NDkwMDAwMH0
```
```json
{ "received": true }
```
```json
{ "error": { "code": "INVALID_SIGNATURE", "message": "Invalid signed_request.", "requestId": "req_01JCXM6V7W8X" } }
```

#### J2. `POST /api/v1/meta/data-deletion` — Data-deletion callback
Effect: insert `deletionRequests` (`kind: meta_data`, `confirmationCode`), then (Inngest `meta.data_deletion.requested`) delete the connection document (token, username, picture), redact Meta-derived fields on that user's posts (`igContainerId`, `igMediaId`, `permalink`, `approval.igUserId` → hashed), delete matching `publishAttempts` request/response payloads, invalidate `scheduled` and `publish_failed` posts. The ByteReel account and videos are **not** deleted (they aren't Meta data).
Success `200` → **Meta's required shape (snake_case)**: `{ "url": "https://<domain>/data-deletion/<code>", "confirmation_code": "<code>" }`. Errors: `400 INVALID_SIGNATURE`.
```json
{ "url": "https://bytereel.app/data-deletion/DEL-7K3M9Q2X", "confirmation_code": "DEL-7K3M9Q2X" }
```
```json
{ "error": { "code": "INVALID_SIGNATURE", "message": "Invalid signed_request.", "requestId": "req_01JCXM6Z9A0B" } }
```

#### J3. `GET /api/v1/meta/data-deletion/{confirmationCode}` — Deletion status
Public status for the page Meta links to. Auth: anonymous. `confirmationCode` pattern `^DEL-[A-Z0-9]{8}$`. Returns no personal data.
Success `200` → `{ confirmationCode, status: "pending" | "completed" | "failed", requestedAt, completedAt | null }`. Errors: `404 NOT_FOUND` · `400 INVALID_INPUT`.
```json
{ "confirmationCode": "DEL-7K3M9Q2X", "status": "completed", "requestedAt": "2026-11-12T08:00:00.000Z", "completedAt": "2026-11-12T08:00:04.000Z" }
```
```json
{ "error": { "code": "NOT_FOUND", "message": "We couldn't find a deletion request with this code.", "requestId": "req_01JCXM7A1B2C" } }
```

---

## 15. Internal and Conditional Endpoints

| Endpoint | Status | Notes |
|---|---|---|
| `GET/POST/PUT /api/inngest` | **Internal** | Inngest serve handler (function registration, step execution). Requests are verified with `INNGEST_SIGNING_KEY`; no session, exempt from the Origin check; never called by the UI. Not part of `openapi.yaml` paths (mentioned in its description). Functions and events: ARCHITECTURE §13 plus `delete-account` (`account.delete.requested`) and `meta-data-deletion` (`meta.data_deletion.requested`) |
| `GET /api/v1/media/{token}` | **Conditional** (only if Meta rejects presigned R2 URLs, decision D5) | Short-lived signed token (2 h) → streams `output.mp4` from R2 for Meta's `video_url`. Not built unless needed; not in `openapi.yaml` |
| `/voices/{preset}.mp3` | Static file | Pre-recorded voice samples served from `public/voices/` (decision D7); listed via B4 |

**Inngest events emitted by the API:** `plan.requested` (C2, E2), `revision.requested` (D5), `video.generate.requested` (D8, E2), `video.recaption.requested` (F4, E2), `post.publish.requested` (H2, H6, I9), `job.cancelled` (E3, H5, C5, B3), `account.delete.requested` (B3), `meta.data_deletion.requested` (J2). Events carry ids only (ARCHITECTURE §13.2); the event `id` is the job's idempotency key so Inngest de-duplicates.

---

## 16. Open Questions / Assumptions

**Assumptions made where ARCHITECTURE/PRD are silent (simplest sensible option):**

| # | Assumption |
|---|---|
| A-1 | Success bodies are the plain resource (`{ items, nextCursor }` for lists); the `{ ok, data }` wrapper from ARCHITECTURE §12 is replaced by HTTP status codes + the error envelope (part of decision #22). |
| A-2 | Better Auth endpoints keep Better Auth's native error body `{ code, message }`; our hooks add the codes `NOT_ALLOWLISTED`, `TOO_MANY_ATTEMPTS`, `ACCOUNT_SUSPENDED`. Account lockout returns the same `429 TOO_MANY_ATTEMPTS` as the rate limit so it doesn't reveal that an email exists. |
| A-3 | `user.status` gains a third value **`deleting`** (account deletion in progress). ARCHITECTURE §8.1 lists `active \| suspended` only. |
| A-4 | Instagram/Meta routes move under `/api/v1` (`/api/v1/instagram/connect`, `/api/v1/instagram/callback`, `/api/v1/meta/deauthorize`, `/api/v1/meta/data-deletion`); the redirect URI configured in the Meta app is `https://<domain>/api/v1/instagram/callback`. ARCHITECTURE §12 and §17 were updated accordingly. |
| A-5 | Publish now and schedule are **one endpoint** (H2) with `mode`. `captionHash` is computed by the server (`sha256` of the NFC-normalized caption); the client doesn't send it. |
| A-6 | Every storyboard change (incl. a **video-stage** revision) produces a new plan version that the creator approves again (approval #1, ARCHITECTURE §18). ARCHITECTURE §7.2 says a video revision goes to "storyboard_ready **or** generating"; we always go to `storyboard_ready`, and the ③ page shows "Approve & regenerate" right there. |
| A-7 | Caption corrections create a `captionOverrides` set and a `caption` job; they **don't** create a plan version, so the plan source `caption_edit` (ARCHITECTURE §8.4) is reserved and unused in V1. |
| A-8 | ✅ *Decided (#24):* the quota "3 videos per user per day" counts accepted `generate` jobs only; caption fixes don't count. Retries and reused renders don't count. Resets at midnight in the user's timezone. |
| A-9 | Narration edits that break an event anchor are saved as an **invalid** version (approval blocked with `PLAN_INVALID`) rather than rejected, so no typing is lost. The AI revision chat can fix it ("fix scene 3"). |
| A-10 | Restoring (undo) an older version that already had an approval keeps that approval valid, because the plan and hash are identical. Approving that version again when its `generate` job already succeeded reuses the existing render: no new job, no quota use, the project moves to `video_ready` (D8 "Re-approval"). |
| A-11 | Cancelling a generate job returns the project to `storyboard_ready` with the approval kept; approving the same version again resumes the same job (no new quota count). |
| A-12 | Notifications (in-app, ARCHITECTURE §19) need a store and two endpoints (B5, B6) plus a `notifications` collection; not listed in ARCHITECTURE §8. |
| A-13 | One `published` post per project in V1 (one video per project). Re-publishing the same video elsewhere/again is out of scope. |
| A-14 | The live-post uniqueness covers `scheduled`, `publishing` **and `outcome_unknown`** (ARCHITECTURE §8.12 lists only the first two), so reconciliation can't race a new post. |
| A-15 | Brainstorm ideas aren't stored; the chosen idea is copied into `project.input.brainstormChoice`. |
| A-16 | Rate-limit numbers in §10.3 are starting values (ARCHITECTURE §21.2 names the endpoints but not the numbers); they live in code config, not in admin settings. |
| A-17 | Media URLs are returned as JSON by default (`redirect=true` for a `302`); the old ARCHITECTURE §12.2 (since replaced by this document) described a redirect only. |
| A-18 | Plan stats use the code names `sceneCount`, `wordCount`, `estimatedSeconds` (`PlanStats` in `semantic-validation.ts`); ARCHITECTURE §8.4 said `{ scenes, words, estimatedSeconds }` and was aligned. |

**Gaps between PRD.md and ARCHITECTURE.md (ARCHITECTURE wins as the later, approved design; listed for the founder):**

| # | PRD says | ARCHITECTURE / this API does | Question |
|---|---|---|---|
| G-1 | §15 collection names `storyboards`, `narrations`, `captionEdits`; fields `status`, `inputType`/`inputText`, `currentStoryboardVersion`, `allowListed` on users | `planVersions`, `speechArtifacts`, `captionOverrides`; `state`, `input{}`, `currentPlanVersionId`, an `allowlist` collection | Treat PRD §15 as superseded? (recommended) |
| G-2 | §8.2 example scene uses `pattern: "process_flow"`, `captionText`, `visual.nodes`, `cues[{word, action, target}]` | Code contract: `type: "process-flow"`, `narration[]{text, speech, display}`, `objects[]`, `events[]{anchor{narrationId, phrase}}` | PRD example is illustrative only? |
| G-3 | §2.2/§9: "one curated male + female voice per language (6 voices)"; §22 "6 voices total" | Decision #18 / ARCHITECTURE §16.2: **4 voices** (Hinglish reuses Hindi) | PRD §22 open item should say 4 |
| G-4 | §9: if a voice is unavailable, fall back to the **other configured voice of the same gender and language** | ARCHITECTURE §16.2 / PIPELINE §11: **no silent voice substitution**, clear error | Which wins? (API follows ARCHITECTURE: `PROVIDER_UNAVAILABLE`) |
| G-5 | §8.2: an invalid scene is retried once then **falls back to a simple key-text scene** | ARCHITECTURE §20.2: invalid plan after repair → job fails ("Couldn't build a good storyboard") | Is the key-text fallback still wanted for V1? |
| G-6 | §11.4: limits incl. "max renders **per project**/day" | ARCHITECTURE §23: renders per **user** per day (3) only | Add a per-project limit? |
| G-7 | §12: "Revision while a render is running → queued, **or** the render is cancelled with confirmation" | Only one active job per project; API returns `JOB_ALREADY_RUNNING`, the UI offers **Cancel** (E3) first | OK to not queue revisions? |
| G-8 | §12: caption edit → offer "regenerate narration too" | No dedicated endpoint; the UI turns it into a narration edit (D3) + approval | OK? |
| G-9 | §7: approval stores `render_version`, `instagram_account_id` | `approval { renderId, mp4Sha256, connectionId, igUserId, captionHash, … }` (stricter) | — (superset) |
| G-10 | §12: "Empty or very vague idea → ask one clarifying question" | No planning-time clarification flow in ARCHITECTURE; the plan job can only succeed or fail | Add `needs_input` (`clarification_needed`) to plan jobs too? The job shape already allows it |
| G-11 | §11.2 workflows `write-caption`, `scheduled-publish`, `revise-storyboard` | ARCHITECTURE: caption is a sync call (H1); scheduling is inside `publish-post`; function is `revise-plan` | — (naming) |
| G-12 | §2.2: "a single sign-in method at first (provider is an engineering decision)" | D1: email + password | — (resolved) |
| G-13 | §6.0 states have no `plan_failed`, `generate_failed`, `archived` | ARCHITECTURE §7.2 has them | — (superset) |
| G-14 | §17/§3 Gemini baseline `gemini-3.8-flash` (decision #17) | Decision #19 / ARCHITECTURE: `gemini-3.6-flash` | — (resolved by #19) |

**Founder answers (2026-11-12, PRD decision #24):**
1. ✅ Caption fixes do **not** count toward the 3 videos/day quota (A-8 changed: only `generate` jobs count; `caption` jobs are still rate-limited by F4, 10/hour).
2. ✅ No key-text fallback: the plan job fails with `PLAN_INVALID` ("Couldn't build a good storyboard, try rephrasing.") + Try again (G-5 → ARCHITECTURE wins).
3. ✅ Voice unavailable: fail clearly with `PROVIDER_UNAVAILABLE`; never substitute a voice (G-4 → ARCHITECTURE wins).
4. ✅ One Instagram account per ByteReel user: `igUserId` is **unique among active connections**. Connecting an account already connected by another user redirects back with `?instagram_error=INSTAGRAM_ACCOUNT_IN_USE` (same format as every other callback error, G3) and the message "This Instagram account is already connected to another ByteReel account."

**Still open:**
5. Confirm the domain for the Meta redirect URI and the data-deletion status page (examples use `bytereel.app`, domain check pending per PRD §22).
