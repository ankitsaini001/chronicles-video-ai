# F22 — Cloudflare R2 storage setup (together)

| | |
|---|---|
| **Status** | 🧪 Testing |
| **Phase** | A4 · Generate and review video |
| **Depends on** | F20 |
| **Design** | — |
| **Data (MongoDB / storage)** | Cloudflare R2 (founder's own account): private bucket `reel-app-dev`, code in `packages/storage` |
| **API endpoints** (docs/API.md) | — |

## Goal
Set up where videos and audio files are stored, step by step, like we did for MongoDB.

## What you will see
Your R2 bucket in the Cloudflare dashboard with one test file.

## In scope
- Create the bucket (founder clicks, I guide)
- Keys in `.env`
- Upload + private download link test

## Not in this feature
- Videos and audio (F23), the production bucket `reel-app-prod` (F38), CORS, lifecycle rules.
- The storyboard copy in R2 (`plan.json`/`review.html`): **dropped for now** (decision 2026-11-14), because MongoDB holds every plan version.

## Steps
- [x] 1. Founder creates the private bucket `reel-app-dev` (Standard, APAC, public access off, no r2.dev address) and an Account API token with **Object Read & Write on this bucket only**; puts the 4 `R2_*` values in `.env`
- [x] 2. `packages/storage` workspace: AWS SDK v3 S3 client + presigner (3.1161.0, exact, released 2026-10-30), region `auto`, endpoint `https://<account>.r2.cloudflarestorage.com`
- [x] 3. Config check `readR2Config`: names any missing or wrong variable, never shows values
- [x] 4. Key builder `StorageKeys` (ARCHITECTURE §9): only from ObjectIds and the speech hash; refuses `..`, slashes, empty and anything else
- [x] 5. `R2ArtifactStore`: `put` (content type from the key, SHA-256 computed and checked by R2, optional create-only), `get`, `head` (size, type, saved hash), `checkBucket`, `presignedGet` (default 15 min, max 2 h, download name with Hindi support). Nothing is ever public
- [x] 6. `npm run storage -- check`: upload a test file to `healthcheck/`, read it back, check the bucket is private and a 60 s link expires, print a 5 min link for the browser
- [x] 7. `.env.example`, ARCHITECTURE §9 (bucket names, keys, plan-copy decision), DATABASE.md, BRAND.md §10, F15 note
- [x] 8. Unit tests + live check against `reel-app-dev`
- [x] 9. Code review fixes: simple store (ArtifactStore adapter removed), create-only uploads, timeouts and retries, redacted `StorageError`, `checkBucket`, link printed only with `--print-link`, F23 MUST list for R2 writers

## How to try it (founder)
1. In a terminal in the project folder: `npm run storage -- check` (takes about 80 seconds: it waits for a link to expire).
2. Every line should say **PASS** (config, bucket, upload, create-only, read back, private, private link, expired link).
3. See the file in Cloudflare → R2 → `reel-app-dev` → Objects → folder `healthcheck/` (each run adds one tiny file; delete them by hand any time).
4. Optional: `npm run storage -- check --print-link` also prints a private link that works for 5 minutes. Open it in your browser and you see "Hello from the reel app F22 check"; reload after 5 minutes and you see an error. The link contains your token's access key ID and a signature, so never share it or paste it in a chat.

## How we test it (done when all are ticked)
- [ ] Founder sees the test file in Cloudflare
- [ ] Files are private (link expires)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

## Progress log
| Date | What happened |
|---|---|
| 2026-11-14 | Founder created the private bucket `reel-app-dev` (Standard, APAC, public access disabled, no r2.dev domain) and an Account API token with Object Read & Write on that bucket only; values saved in the git-ignored `.env`. |
| 2026-11-14 | Built `packages/storage` (config check, key builder, `R2ArtifactStore`, presigned links with RFC 5987 download names) and `npm run storage -- check`. Bucket names now `reel-app-dev` / `reel-app-prod` (neutral; never rename). Decision: no storyboard copy in R2 (MongoDB holds every version). Live check against `reel-app-dev`: config, upload (34 bytes), read back with the same SHA-256, unsigned request refused (HTTP 400), 60 s link opened (HTTP 200, same text), refused after 70 s (HTTP 403). Test file `healthcheck/20261114T155452Z-hello.txt` left in the bucket. 23 new unit tests; all 698 tests pass, typecheck and `next build` pass. Ready for code review and the founder's test. |
| 2026-11-14 | Code review fixes (no critical findings): `R2ArtifactStore` is now a simple store (the pipeline ArtifactStore adapter was removed; F23 calls it directly); create-only uploads (`If-None-Match: *`); content type from the key; timeouts 5 s / 120 s and 3 attempts; every failure is a `StorageError` with a redacted cause; `get` treats only `NoSuchKey` as missing; `checkBucket()`; the CLI prints the browser link only with `--print-link`; broken (lone surrogate) titles no longer crash downloads; a test keeps `healthcheck/` to the CLI. F23 got a MUST list for R2 writers (speech lock, new renderId per attempt, create-only, SHA-256 check before publishing), also in ARCHITECTURE §9. 704 tests pass, typecheck and `next build` pass. Live check again: all 8 checks PASS (bucket found, create-only refused a second upload with HTTP 412, unsigned 400, link 200 then 403). |
