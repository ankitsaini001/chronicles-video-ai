import { API_RATE_LIMITS } from "@bytereel/db";
import { apiRoute } from "@/lib/api/server";
import { listVoices } from "@/lib/voices";

// B4 GET /api/v1/voices (docs/API.md §14.2): voice presets and their pre-recorded preview samples.
// Signed out → 401; `?language=` must be en, hi or hinglish (else 400 INVALID_INPUT); shares the
// 300-per-minute read limit with the other GET endpoints. Never calls ElevenLabs.

export const GET = apiRoute({
  rateLimit: API_RATE_LIMITS.readsPerUser,
  handle: async ({ request }) => listVoices(new URL(request.url)),
});
