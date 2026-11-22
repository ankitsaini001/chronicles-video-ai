# F28 — Connect / disconnect Instagram

| 2026-11-22 | Plan approved by the founder (decisions 1–8). |
|---|---|
| **Status** | 🔨 Building (plan approved 2026-11-22) |
| **Phase** | A5 · Instagram publishing |
| **Depends on** | F24 |
| **Design** | Stitch: ByteReel — Step 4 Connect Instagram |
| **Data (MongoDB / storage)** | `instagramConnections` |
| **API endpoints** (docs/API.md) | G1–G4 |

## Goal
Connect your Instagram Creator/Business account through Instagram's own login page.

## What you will see
'ByteReel — Step 4 Connect Instagram' screen and the Instagram card in Settings.

## In scope
- Meta developer app setup (together, step by step)
- Instagram Login flow
- Token stored encrypted, never shown
- One Instagram account per ByteReel user, both ways (one connection per user; an Instagram account actively connected to one user is refused for any other user with "This Instagram account is already connected to another ByteReel account.")
- Personal account → clear message

## Not in this feature
- The Settings page card (Settings comes in F33; until then connect and disconnect live on Step 4)
- Meta deauthorize / data-deletion callbacks (F37, need the public domain)
- Token refresh (F32); publishing itself (F30, F31)

## Decisions (founder, 2026-11-22; plan approved)
1. **Step 4 page** `/projects/[id]/publish` (Stitch "Step 4 Connect Instagram"): the video's "Publish — coming soon" becomes **Publish →**. Not connected: "Connect your Instagram" + the three promises + **Connect Instagram**. Connected: "Publishing to @username" (picture) + **Disconnect**, and "Publishing comes next" until F30.
2. **Instagram API with Instagram Login** (Business Login; no Facebook Page): `www.instagram.com/oauth/authorize` → `api.instagram.com/oauth/access_token` (server side) → `graph.instagram.com/access_token?grant_type=ig_exchange_token` (~60 days) → `/me` (user_id, username, account_type, profile_picture_url). Scopes `instagram_business_basic,instagram_business_content_publish`. Endpoints checked against Meta's docs on 2026-11-19 (business-login page); recheck `/me` fields while building.
3. **Clear messages, never an error page:** personal account (INSTAGRAM_ACCOUNT_INELIGIBLE, how to switch), Cancel on Instagram (access_denied), already connected to another ByteReel user (INSTAGRAM_ACCOUNT_IN_USE), expired/forged state.
4. **Token** encrypted AES-256-GCM with `TOKEN_ENCRYPTION_KEYS` / `TOKEN_ENCRYPTION_ACTIVE_VERSION` (DATABASE.md §6.2); never returned, never logged. One connection per user and one active user per Instagram account (unique indexes; the founder runs the index command).
5. **Disconnect** removes the token at once (status `revoked`). Post invalidation on disconnect/reconnect arrives with posts (F30).
6. **B1 `instagram`** becomes real (status, username).
7. **Setup with the founder**: professional + public Instagram; Meta developer app with "Instagram API with Instagram Login"; the founder's Instagram as tester (development mode, no App Review yet); `.env`: Instagram app id, app secret, encryption key (checked by length only); redirect `http://localhost:3000/api/v1/instagram/callback` first, an HTTPS tunnel only if Meta refuses localhost.
8. **Tests**: a stand-in Instagram (E2E_FAKE_INSTAGRAM=1), zero real Meta calls by agents; the founder's real (free) connect/disconnect.

## Steps
_We break this into small steps together when we start this feature._

## How we test it (done when all are ticked)
- [ ] Founder connects their account
- [ ] Disconnect works
- [ ] Same account on a second user is refused
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-22 | Plan approved by the founder (decisions 1–8). |
