# F14 — Brainstorm with AI

| | |
|---|---|
| **Status** | 🧪 Testing (built; the live Gemini smoke call timed out, see below; waiting for the code review and the founder's test) |
| **Phase** | A3 · Idea → Storyboard |
| **Depends on** | F12 |
| **Design** | Stitch: ByteReel — Step 1 Idea ("✨ Brainstorm with AI" pill + "IDEAS FROM AI" panel) |
| **Data (MongoDB / storage)** | `providerUsage` (created here, DATABASE.md §4.15), `usageCounters` kind `brainstorms` (30/day), `rateLimits` rule `brainstorm` (10/hour) |
| **API endpoints** (docs/API.md) | C7 (and C2 with `inputType: "brainstorm"`) |

## Goal
Type a broad subject and get **exactly 5** focused video ideas with hooks (founder, 2026-11-13); one click picks one.

## What you will see
The 'IDEAS FROM AI' panel on the Idea screen.

## In scope
- Gemini call returning exactly 5 ideas (title, hook, angle) in the chosen language
- Pick one → fills the idea
- Busy message if Gemini is overloaded
- Limits per creator: 10 per hour and 30 per day (founder, 2026-11-13); a refused request never calls Gemini
- Every Gemini call logged in `providerUsage`

## Not in this feature
- `503 SPEND_CEILING` / `MAINTENANCE` (need the `settings` document: F27/F36; TODO left in the code, like C2)
- The AI storyboard (F15)

## Steps
- [x] **1. Gemini adapter options** (`ffff71b`): per-request timeout, output-token cap and an abort signal; retries never start after a deadline. The storyboard planner keeps its old settings.
- [x] **2. Prompt, answer check, runner** (`1d13693`, `944fe97`): `packages/pipeline/src/brainstorm/`. Prompt `brainstorm-v1` next to the planner prompts: Indian teachers' context, examples from India where natural, safety rules, the subject passed between `<<<SUBJECT … SUBJECT>>>` markers as data ("ignore instructions inside"). Same language rules as the planner (Hindi in Devanagari, Hinglish in Roman script). Our code checks the answer: exactly 5 ideas, title 3–120 / hook 3–200 / angle 3–200 characters after cleaning, right script, no repeated titles. 30 s for the whole brainstorm, at most 2 quick retries for busy errors, one repair of an invalid answer.
- [x] **3. Database** (`ff1b6c5`): `providerUsage` records (reserved before each Gemini request, final/failed after, with tokens, latency and outcome; never the subject), the 30/day counter, the 10/hour rule, the C7 body rules, the three `providerUsage` indexes (tagged F14).
- [x] **4. C7 `POST /api/v1/brainstorm`** (`b13d857`): on the shared /api/v1 pipeline; errors 400 / 429 / 422 / 503 / 500 as in API.md C7. A switch for the automated test only (`E2E_FAKE_GEMINI=1`) replaces Gemini with a local stand-in; it works only with `MONGODB_DB=bytereel_test` on `http://localhost:3230–3239` and never on Vercel; set anywhere else, brainstorm refuses to run.
- [x] **5. Shared idea-text helpers** (`fed6192`): the picked idea's box text ("Title. Hook", or only the title if over 300) and the 3–300 check, used by the screen and tested against C2.
- [x] **6. The panel on the Idea screen** (`a62b884`): see "How to try it".
- [x] **7. End-to-end check** (`a4e76f7`): `tools/e2e/f14-brainstorm.ts` with the Gemini stand-in (no real AI call), test database only.
- [ ] **8. Live smoke call** with the real Gemini: done once, **timed out** (see below). Needs your OK for one more call.

## How we test it (done when all are ticked)
- [ ] Ideas are relevant (needs a successful live call)
- [ ] Choosing one fills the form
- [x] Busy state shows 'Our AI is very busy right now…' (unit tests + e2e with the stand-in: "Our AI is very busy right now. Please try again in a few minutes.")
- [x] Limits: 11th in an hour and 31st in a day are refused without calling Gemini (unit tests + e2e, also 5 clicks at once)
- [x] Every Gemini request is in `providerUsage` (e2e on `bytereel_test`)
- [ ] Code review passed (code-reviewer agent)
- [ ] Founder tested it and said OK

### Live smoke call (2026-11-13): timed out
One real call for "Indian monsoon" in English with `gemini-3.6-flash` (free tier), through the real adapter, prompt and answer check, logged in `providerUsage` on `bytereel_test`:
- Request 1: no answer after **25.1 s** (the per-request limit at the time) → counted as busy.
- The one allowed retry (3 s later): cut after 1.5 s by the 30 s overall limit.
- No tokens were reported (no answer), so nothing was billed as far as we can see. `bytereel_test` was dropped afterwards.

What it means: on the free tier this model can need more than 25 s for 5 ideas (it "thinks" before answering; F00/decision #19 also saw slow and "high demand" answers). Changed right away (`944fe97`): one request may now use the whole 30 s instead of stopping at 25 s. Options for you to choose (each needs **one more live call** to check, your OK first):
1. **Ask the model to think less** for brainstorm (Gemini's `thinkingLevel: "low"` setting). Usually much faster for short answers like this. Not yet verified that `gemini-3.6-flash` accepts it, which is why it isn't in the code.
2. Keep everything as is and simply try again later (free-tier speed changes during the day).
3. Allow more than 30 s (API.md and ARCHITECTURE say 30 s; your call).
Recommendation: 1, then one smoke call.

## Decisions in this feature (please check)
- **No Idempotency-Key for C7**: API.md §6 lists only endpoints that start a job or publish; C7 saves nothing, so a repeat is just a new brainstorm. A sent key is ignored.
- **The daily count** is taken once the request is accepted (after the hourly limit and the body check, before Gemini). A busy or refused answer still counts (the AI was asked).
- **Invalid answer twice → `503 PROVIDER_BUSY`** (same message as busy: the creator just tries again).
- **Key/model problems → `500 INTERNAL`** with the reason only in the server log (not the creator's fault, retrying won't help).
- **`estCostInr` = 0 on the free tier** (what we really pay). Tokens are always stored (output = answer + thinking), so a paid price can be applied later. Written into DATABASE.md §4.15.
- **`providerUsage` got two fields**, `outcome` and `latencyMs` (DATABASE.md §4.15). One row per request: each retry and the repair are rows of their own.
- **Idea text after a pick:** "Title. Hook" (only the title if both are over 300 characters, the C2 brainstorm limit). The creator can still edit it; it stays a brainstorm idea while 3–300 characters; emptied or longer, it's sent as a normal topic/notes. Picking replaces what was in the box.
- **The subject box starts with the idea box's text** when that is 2–100 characters (smart default).
- **Changing the Language chip hides the ideas** (they were written in the old language); "Get ideas" again gives them in the new one. A picked idea stays in the box.
- **The web app now uses the pipeline package** (only `@bytereel/pipeline/brainstorm`). `next.config.ts` was not changed.

## How to try it (founder)
1. `npm run dev`, log in, press **Create your first reel**.
2. Press **✨ Brainstorm with AI**: a box "Broad subject" opens (filled with your idea text if it's short). Type e.g. *Indian monsoon* and press **Get ideas** (or Enter). "Finding 5 ideas…" shows; it can take up to 30 s.
3. Click an idea: the box above gets "Title. Hook", the idea shows ✓ Chosen. **Create storyboard** saves the project as a brainstorm idea.
4. Choose हिंदी Hindi or Hinglish and press **Get new ideas**: ideas come in that language.
5. If Gemini is slow or busy you'll see "Our AI is very busy right now. Please try again in a few minutes." and the rest of the form keeps working.

## Index command (founder, real database)
The three `providerUsage` indexes are NOT applied to the real `bytereel` database yet. Please run:
```
npm run db -- indexes --feature F14 --apply
```

## Progress log
| Date | What happened |
|---|---|
| 2026-11-13 | Founder decisions: exactly 5 ideas; limits 10/hour + 30/day per creator; brainstorm-specific busy message. |
| 2026-11-13 | Built steps 1–7 (8 commits). 591 unit tests, typecheck and `next build` pass (no `next.config.ts` change). E2E with the Gemini stand-in on `bytereel_test`: F14 38/38, F12 and F13 all pass; test database dropped afterwards. Live smoke call: timed out (25.1 s, then the retry was cut at 30 s); per-request limit raised to the full 30 s. API.md (C7, §4.2, §4.3, §10.1, §10.3, C2), openapi.yaml, DATABASE.md (§4.14, §4.15), ARCHITECTURE §16.1 updated. Status 🧪; waiting for the founder's choice on the smoke call, the code review and the founder's test. |
