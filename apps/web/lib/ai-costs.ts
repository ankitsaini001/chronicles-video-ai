// Prices we record on every AI request in `providerUsage` (DATABASE.md §4.15), shared by the C7
// brainstorm and the H1 Instagram caption (F29 review). One place to change when Gemini becomes paid.

/** We pay nothing on Gemini's free tier; the token counts are kept, so a paid price can be applied later. */
export const GEMINI_FREE_TIER_COST_INR = 0;
