import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { planErrorCode } from "../packages/pipeline/src/planning";
import { ProviderError } from "../packages/pipeline/src/providers";
import { classifyGeminiError } from "../packages/pipeline/src/providers/gemini";

// F26 founder test: a failed Gemini storyboard or change request saves WHY it failed on its
// providerUsage row, as a short fixed code (never Gemini's free text, which could quote the storyboard).

const MODEL = "gemini-3.6-flash";

describe("planErrorCode", () => {
  it("503 with the status word inside the quoted body (the real 2026-11-17 answer)", () => {
    const body = '{ "error": { "code": 503, "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", "status": "UNAVAILABLE" } }';
    const error = new ProviderError({ provider: "gemini", kind: "transient", status: 503, message: `Gemini API error 503 Service Unavailable: ${body}` });
    expect(planErrorCode(error)).toBe("transient 503 UNAVAILABLE");
  });

  it("the status word right after the number (our own classifier's format)", () => {
    const error = new ProviderError({ provider: "gemini", kind: "quota", status: 429, message: "Gemini API error 429 RESOURCE_EXHAUSTED: Quota exceeded for metric x" });
    expect(planErrorCode(error)).toBe("quota 429 RESOURCE_EXHAUSTED");
  });

  it("a real SDK error goes through classifyGeminiError and keeps status and word", () => {
    const sdk = new ApiError({ status: 500, message: JSON.stringify({ error: { code: 500, message: "An internal error has occurred.", status: "INTERNAL" } }) });
    expect(planErrorCode(classifyGeminiError(sdk, null, MODEL))).toBe("transient 500 INTERNAL");
  });

  it("a status without any word is just kind + number", () => {
    expect(planErrorCode(new ProviderError({ provider: "gemini", kind: "transient", status: 504, message: "Gemini API error 504: gateway" }))).toBe("transient 504");
  });

  it.each([
    ["Gemini request failed: This operation was aborted", "transient", "transient timeout"],
    ["Gemini request failed: fetch failed", "transient", "transient network"],
    ["Gemini returned no candidates", "bad-response", "bad-response no-candidates"],
    ["Gemini request failed: Unexpected token < in JSON at position 0", "bad-response", "bad-response bad-json"],
    ["Gemini request failed: something new", "bad-response", "bad-response other"],
  ] as const)("no status: %s → %s", (message, kind, code) => {
    expect(planErrorCode(new ProviderError({ provider: "gemini", kind, message }))).toBe(code);
  });

  it("never carries Gemini's free text (only fixed words), and anything that isn't a ProviderError is 'other'", () => {
    const leaky = new ProviderError({ provider: "gemini", kind: "invalid-request", status: 400, message: 'Gemini API error 400: Invalid value at "contents[0]" (the storyboard text about SECRET_TOPIC)' });
    expect(planErrorCode(leaky)).toBe("invalid-request 400");
    expect(planErrorCode(new Error("boom"))).toBe("other");
    expect(planErrorCode("boom")).toBe("other");
  });
});
