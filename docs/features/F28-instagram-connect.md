# F28 — Connect / disconnect Instagram

| 2026-11-22 | Plan approved by the founder (decisions 1–8). |
|---|---|
| **Status** | 🧪 Testing (built 2026-11-22; waiting for the founder's real connect/disconnect) |
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

## Decided while building (2026-11-22)
- **Redirect address:** `INSTAGRAM_REDIRECT_URI` is optional. Empty = `BETTER_AUTH_URL` + `/api/v1/instagram/callback`, so on your computer it is `http://localhost:3000/api/v1/instagram/callback` without setting anything. Set it only for a tunnel. Whatever is used must be EXACTLY what you save in Meta.
- **`returnTo=settings`** (the default) lands on **My videos** until the Settings page exists (F33). Step 4 always sends `publish:<projectId>`.
- **The three promises** say "Disconnect anytime" (not "…in Settings": Settings doesn't exist yet).
- **Meta's docs today (checked 2026-11-22):** `/me` fields `user_id, username, account_type, profile_picture_url` exist; the docs show `account_type` as `Business` / `Media_Creator` and the call as `graph.instagram.com/v27.0/me`; answers may come inside `data: [ … ]`. The code accepts both shapes and any letter case.
- **Extra plain messages:** "Connecting Instagram isn't set up yet." (`reason=not_set_up`, settings missing), "You're going a bit fast…" (more than 10 connects or 20 returns from Instagram an hour) and, after the code review, "Please allow posting when Instagram asks, then connect again." (`reason=missing_permission`: you un-ticked posting on Instagram's page; nothing is saved).
- **Code review (2026-11-22):** the id we store is `/me`'s `user_id` (the code exchange's isn't needed: a real 17-digit number would be rounded by JavaScript); a rounded number is refused, never stored. `/me` gets the token in a header, not the address. The encrypted token is bound to its record (`${ownerId}:${igUserId}`). "Disconnect" now says "We no longer have access to your account."

## Steps
- [x] 1. Database + server: `instagramConnections` (owner-scoped, one transaction for connect and for disconnect, audit `instagram.connected` / `instagram.disconnected`), 3 indexes (feature F28), token encryption (`packages/db/src/token-crypto.ts`), the signed state, the Meta client, the stand-in Instagram, G1–G4, B1 `instagram` real, `.env.example` (`apps/web/lib/instagram/`, `apps/web/app/api/v1/instagram/`) — `00ec7d6`
- [x] 2. Screens: "Publish →" on the ready video (and the stepper's 4 Publish), the Step 4 page `/projects/[id]/publish` with the Instagram card (`components/publish/InstagramCard.tsx`, `PlainLinkButton` in `components/ui/Button.tsx`)
- [x] 3. Unit tests `tests/instagram-connect.test.ts` (37 tests) + B1 tests updated
- [x] 4. E2E `tools/e2e/f28-instagram.ts` with the stand-in: 41/41 on 2026-11-22
- [x] 5. Docs: API.md (B1, G1–G4 "As built (F28)", §10.3), openapi.yaml, DATABASE.md (§4.16, §4.21, the feature table), ARCHITECTURE.md (§17.2, env names), this file, the tracker
- [x] 6. Code review fixes (2026-11-22): `user_id` from `/me` only (17-digit ids), the posting permission required (`missing_permission`), G3 counter 20/hour, the token bound to its record (AAD), the routes' setup failure → `not_set_up`, the publish page reuses `storyboardChangedSince`, the reconnect note always shown, `/me` keeps the token in the address as Meta documents (Bearer header not adopted), the disconnect wording, a second duplicate on `ownerId` keeps its real error (not committed yet)
- [ ] 7. Founder: the real connect / disconnect below

## How to try it (founder)
**Cost: nothing** (Meta's API and the developer app are free). About 30 minutes the first time, together.

**A. Your Instagram (in the Instagram app)**
1. Your account must be **professional**: Settings → Account type and tools → *Switch to professional account* → **Creator** (or Business). It must be **public**.

**B. The Meta app (developers.facebook.com, in your own Meta account)**
2. My Apps → **Create app** → use case **"Manage messaging & content on Instagram"** (this is "Instagram API with Instagram Login"; no Facebook Page needed).
3. In the app: **Instagram → API setup with Instagram login**. Copy the **Instagram app ID** and **Instagram app secret** (these are NOT the Facebook App ID/secret at the top of the dashboard).
4. Under **Set up Instagram business login → Business login settings → OAuth redirect URIs**, add exactly `http://localhost:3000/api/v1/instagram/callback` and save. (If Meta refuses `http://localhost`, tell me: we then use an HTTPS tunnel and set `INSTAGRAM_REDIRECT_URI`.)
5. **App roles → Roles → Add people → Instagram Tester**: add your Instagram username. Then in the Instagram app (or instagram.com): Settings → **Apps and websites → Tester invites** → **Accept**. (The app stays in development mode: only testers can connect; App Review comes before other creators, F38.)

**C. Your `.env` (project root; never in git or a chat)**
6. Add:
   - `INSTAGRAM_APP_ID=` the Instagram app ID (digits)
   - `INSTAGRAM_APP_SECRET=` the Instagram app secret
   - `TOKEN_ENCRYPTION_KEYS={"1":"<key>"}` where `<key>` is the output of `openssl rand -base64 32` (on one line, with the quotes as shown)
   - `TOKEN_ENCRYPTION_ACTIVE_VERSION=1`
   - leave `INSTAGRAM_REDIRECT_URI` empty.
   Keep a safe copy of the key (a password manager): losing it means reconnecting Instagram (videos are safe).
7. Check (prints only lengths, never values): `node -e 'process.loadEnvFile(".env");const k=JSON.parse(process.env.TOKEN_ENCRYPTION_KEYS);console.log("app id digits:",process.env.INSTAGRAM_APP_ID.length,"secret chars:",process.env.INSTAGRAM_APP_SECRET.length,"key 1 bytes:",Buffer.from(k["1"],"base64").length)'` → key 1 bytes must be **32**.

**D. The indexes (once, on your real database)**
8. `npm run db -- indexes --feature F28 --apply` (creates `instagramConnections.ownerId_unique`, `igUserId_active_unique`, `status_tokenExpiresAt`). Do this BEFORE the first connect.

**E. Try it**
9. Restart `npm run dev` (Ctrl+C, then `npm run dev`: `.env` changed).
10. Open a ready video → **Publish →**. You see "Connect your Instagram" → click **Connect Instagram**.
11. Instagram's own page opens: log in (if asked) and **Allow**. You come back to Step 4: "Instagram connected." and **Publishing to @yourname** with your picture.
12. Check: the header still works; `http://localhost:3000/api/v1/me` shows `"instagram":{"status":"active","username":"yourname"}`. In Atlas → `instagramConnections` you see your document with `accessToken: { ciphertext, iv, tag, keyVersion: "1" }` (random-looking text, not a token).
13. Click **Disconnect** → "Instagram disconnected. Your token was deleted." and the Connect card is back. In Atlas the document now has `status: "revoked"`, `revokedAt` and NO `accessToken`.
14. Connect again (step 10–11) to leave it connected for F29/F30, or leave it disconnected.
15. Optional: click **Cancel** on Instagram's page → "You cancelled on Instagram, so nothing was connected."
"Same account on a second user is refused" is proven by the e2e (it needs a second ByteReel login with the same Instagram); you can try it with a second invited email if you like.

## Known limits
- **Settings has no Instagram card yet** (F33): connect and disconnect live on Step 4; `returnTo=settings` lands on My videos.
- **Disconnect doesn't touch posts yet:** there are none before F30, which adds "scheduled posts are cancelled" and the 409 while a post is publishing (`TODO(F30)` in `packages/db/src/instagram-connections.ts`).
- **Disconnect deletes our copy of the token** but doesn't tell Meta: the app stays listed in your Instagram "Apps and websites" until you remove it there (Meta's deauthorize callback is F37).
- **No token refresh yet** (F32): a token lasts about 60 days; after that publishing will ask you to reconnect.
- **Login doesn't come back to Step 4:** connecting while logged out sends you to the login page; after logging in you start again from My videos.
- **`/me` gets the token in the address** (`access_token=`), as Meta's "Get started" page shows. The review suggested a Bearer header, but that is not in Meta's Instagram Login docs, so we kept the documented way (the step-3 token exchange puts the token in the address anyway, and nothing logs fetch addresses). Proven only by your real connect (step E).
- **Graph API version** `v27.0` for `/me` is the one Meta's page showed on 2026-11-22; when Meta retires it, the constant `INSTAGRAM_GRAPH_VERSION` in `apps/web/lib/instagram/meta-client.ts` is the one place to change.
- The real Meta calls have only been tested against Meta's documentation (agents never call Meta): your step E is the first real run.

## How we test it (done when all are ticked)
- [ ] Founder connects their account (e2e with the stand-in: Creator → @username on Step 4, G1 and B1; the token encrypted in the database and never in any answer, page, redirect or server log; audit entry)
- [ ] Disconnect works (e2e: Origin check, token removed, revoked, audit, 404 the second time, B1 not_connected, the Connect card back; reconnect keeps ONE document per user)
- [ ] Same account on a second user is refused (e2e: IN_USE; also two users finishing at the same moment → exactly one wins; after a disconnect the account is free for the other user)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-22 | Plan approved by the founder (decisions 1–8). |
| 2026-11-22 | Built: data + encryption + state + Meta client + stand-in + G1–G4 + B1 (`00ec7d6`), Step 4 page and Publish →. Meta's docs re-checked (`/me` fields exist; `v27.0`; `data[]` answers). Unit tests 1146/1146 (37 new), typecheck and `next build` pass, e2e 41/41 with the stand-in Instagram (zero Meta calls). Status 🧪 Testing: waiting for code review and the founder's real connect. |
| 2026-11-22 | Code review fixes (see step 6). Unit tests 1152/1152 (43 Instagram tests: a 17-digit numeric user_id, the posting permission, the G3 counter, AAD binding, setup failure), typecheck and `next build` pass, e2e 43/43 on a fresh `bytereel_test` with the stand-in (zero Meta calls). Waiting for the founder's real connect. |
