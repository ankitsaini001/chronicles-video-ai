import { readFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { SCENE_TYPES } from "../packages/pipeline/src/contracts";
import {
  assemblePlan,
  buildSystemInstruction,
  CODE_OWNED_PLAN_FIELDS,
  hashPlan,
  parseTopicFile,
  plannerOutputJsonSchema,
  PlannerOutputSchema,
  planWithRepair,
  topicSources,
  validatePlan,
} from "../packages/pipeline/src/planning";
import {
  classifyGeminiError,
  interpretResponse,
  mergeChunks,
  ProviderError,
  withRetries,
} from "../packages/pipeline/src/providers";
import { MockPlanner, modelOutputFromFixture, TOPIC } from "./planner-helpers";

const IDS = { ownerId: "local-dev", projectId: "water-cycle-abc123", versionId: "v1", parentVersionId: null };

function collectKeys(node: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => collectKeys(n, keys));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      keys.add(k);
      if (k === "properties") Object.values(v as object).forEach((child) => collectKeys(child, keys));
      else collectKeys(v, keys);
    }
  }
  return keys;
}

// ---------- planner-output schema ----------

describe("planner-output schema", () => {
  it("excludes ownership, lineage, language/voice and sources", () => {
    const schema = plannerOutputJsonSchema() as any;
    const props = Object.keys(schema.properties);
    for (const field of CODE_OWNED_PLAN_FIELDS) expect(props).not.toContain(field);
    expect(props.sort()).toEqual(["audience", "learningObjective", "scenes", "topic", "warnings"]);
  });

  it("converts to a conservative JSON schema: all required, closed objects, enums, nullable types", () => {
    const schema = plannerOutputJsonSchema() as any;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(schema.properties));
    const scene = schema.properties.scenes.items;
    expect(scene.properties.type.enum).toEqual([...SCENE_TYPES]);
    expect(scene.required).toEqual(["id", "type", "narration", "objects", "events"]);
    const narration = scene.properties.narration.items;
    expect(narration.properties.speech.type).toEqual(["string", "null"]);
    expect(narration.required).toEqual(["id", "text", "speech", "display"]);
    const object = scene.properties.objects.items;
    expect(object.properties.kind.enum).toContain("particles");
    expect(object.properties.value.type).toEqual(["number", "null"]);
    expect(scene.properties.events.items.properties.action.enum).toContain("speed-up");
    // Unsupported/strict keywords are removed (our validation enforces them instead).
    const keys = collectKeys(schema);
    for (const dropped of ["$schema", "pattern", "minLength", "maxLength", "default"]) expect(keys.has(dropped)).toBe(false);
  });

  it("accepts a model-shaped plan and rejects ownership fields in it", () => {
    expect(PlannerOutputSchema.safeParse(modelOutputFromFixture()).success).toBe(true);
    expect(PlannerOutputSchema.safeParse({ ...modelOutputFromFixture(), projectId: "x" }).success).toBe(false);
  });

  it("system prompt carries the catalog, icon set, explanation and length rules", () => {
    const prompt = buildSystemInstruction("en");
    for (const text of ["process-flow", "speed-up", "snowflake", "hook", "takeaway", "Never invent citations", "150 words per minute", "150-225 spoken words", "warning"]) {
      expect(prompt).toContain(text);
    }
  });
});

// ---------- ownership is assigned by code ----------

describe("assemblePlan", () => {
  it("always uses code-owned fields, even if the model returns them", () => {
    const sneaky = {
      ...modelOutputFromFixture(),
      ownerId: "attacker",
      projectId: "../../etc",
      versionId: "v999",
      parentVersionId: "v0",
      schemaVersion: 7,
      language: "hi",
      voicePreset: "hindi-male",
      sources: [{ id: "fake", title: "Invented study", notes: "made up" }],
      approval: { planHash: "sha256:x" },
      outputPath: "/tmp/evil",
    };
    const owned = { ...IDS, language: "en" as const, voicePreset: "indian-english-female" as const, sources: topicSources(TOPIC) };
    const { plan, ignoredFields } = assemblePlan(sneaky, owned);
    expect(ignoredFields.sort()).toEqual(
      ["approval", "language", "outputPath", "ownerId", "parentVersionId", "projectId", "schemaVersion", "sources", "versionId", "voicePreset"].sort(),
    );
    const result = validatePlan(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ ownerId: "local-dev", projectId: "water-cycle-abc123", versionId: "v1", parentVersionId: null, schemaVersion: 1, language: "en", voicePreset: "indian-english-female" });
    expect(result.plan.sources).toEqual(topicSources(TOPIC));
  });
});

// ---------- repair flow ----------

function invalidOutput(): Record<string, any> {
  const out = modelOutputFromFixture();
  out.scenes[1].events[0].anchor.phrase = "a phrase that is not in the narration";
  return out;
}

describe("planWithRepair", () => {
  it("valid on the first try: one call, no repair", async () => {
    const provider = new MockPlanner([JSON.stringify(modelOutputFromFixture())]);
    const result = await planWithRepair({ provider, topic: TOPIC, voicePreset: "indian-english-female", ids: IDS });
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.repaired).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.responseJsonSchema).toEqual(plannerOutputJsonSchema());
    expect(provider.requests[0]!.turns[0]!.text).toContain("Explain evaporation");
  });

  it("invalid -> repaired -> valid, sending the validation errors back", async () => {
    const first = JSON.stringify(invalidOutput());
    const provider = new MockPlanner([first, JSON.stringify(modelOutputFromFixture())]);
    const result = await planWithRepair({ provider, topic: TOPIC, voicePreset: "indian-english-female", ids: IDS });
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.repaired).toBe(true);
    expect(result.attempts.map((a) => [a.kind, a.valid])).toEqual([["initial", false], ["repair", true]]);
    const repair = provider.requests[1]!.turns;
    expect(repair).toHaveLength(3);
    expect(repair[1]).toEqual({ role: "model", text: first });
    expect(repair[2]!.role).toBe("user");
    expect(repair[2]!.text).toContain('phrase "a phrase that is not in the narration" was not found');
  });

  it("invalid twice -> needs-input after exactly one repair attempt", async () => {
    const provider = new MockPlanner([JSON.stringify(invalidOutput()), JSON.stringify(invalidOutput()), "never used"]);
    const result = await planWithRepair({ provider, topic: TOPIC, voicePreset: "indian-english-female", ids: IDS });
    expect(result.status).toBe("needs-input");
    if (result.status !== "needs-input") return;
    expect(provider.requests).toHaveLength(2);
    expect(result.issues.some((i) => i.path === "scenes[1].events[0].anchor.phrase")).toBe(true);
  });

  it("treats non-JSON output as invalid and repairs it", async () => {
    const provider = new MockPlanner(["{ not json", JSON.stringify(modelOutputFromFixture())]);
    const result = await planWithRepair({ provider, topic: TOPIC, voicePreset: "indian-english-female", ids: IDS });
    expect(result.status).toBe("valid");
    expect(provider.requests[1]!.turns[2]!.text).toContain("not valid JSON");
  });

  it("does not repair after a fatal provider error", async () => {
    const provider = new MockPlanner([new ProviderError({ provider: "mock", kind: "auth", message: "bad key" }), "unused"]);
    await expect(planWithRepair({ provider, topic: TOPIC, voicePreset: "indian-english-female", ids: IDS })).rejects.toMatchObject({ kind: "auth" });
    expect(provider.requests).toHaveLength(1);
  });

  it("the plan hash does not depend on the model returning ownership fields", async () => {
    const a = await planWithRepair({ provider: new MockPlanner([JSON.stringify(modelOutputFromFixture())]), topic: TOPIC, voicePreset: "indian-english-female", ids: IDS });
    const b = await planWithRepair({ provider: new MockPlanner([JSON.stringify({ ...modelOutputFromFixture(), ownerId: "x", versionId: "v9" })]), topic: TOPIC, voicePreset: "indian-english-female", ids: IDS });
    expect(a.status === "valid" && b.status === "valid" && hashPlan(a.plan) === hashPlan(b.plan)).toBe(true);
  });
});

// ---------- retries and Gemini error classification ----------

describe("withRetries", () => {
  const transient = (retryAfterMs: number | null = null) => new ProviderError({ provider: "p", kind: "transient", message: "busy", status: 503, retryAfterMs });

  it("retries transient errors at most twice, honoring Retry-After", async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      withRetries(async () => {
        calls++;
        throw transient(1500);
      }, { sleep: async (ms) => void waits.push(ms) }),
    ).rejects.toMatchObject({ kind: "transient" });
    expect(calls).toBe(3);
    expect(waits).toEqual([1500, 1500]);
  });

  it("succeeds after a transient failure", async () => {
    let calls = 0;
    const value = await withRetries(async () => (++calls === 1 ? Promise.reject(transient()) : "ok"), { sleep: async () => undefined });
    expect(value).toBe("ok");
    expect(calls).toBe(2);
  });

  it("stops immediately on fatal errors", async () => {
    for (const kind of ["auth", "model-unavailable", "safety", "invalid-request"] as const) {
      let calls = 0;
      await expect(withRetries(async () => {
        calls++;
        throw new ProviderError({ provider: "p", kind, message: kind });
      }, { sleep: async () => undefined })).rejects.toMatchObject({ kind });
      expect(calls).toBe(1);
    }
  });

  it("does not wait longer than the cap; reports quota instead", async () => {
    await expect(withRetries(async () => Promise.reject(transient(10 * 60_000)), { sleep: async () => undefined })).rejects.toMatchObject({ kind: "quota" });
  });
});

describe("classifyGeminiError", () => {
  const apiError = (status: number, body: unknown) => new ApiError({ status, message: JSON.stringify(body) });

  it("invalid key -> auth", () => {
    const e = apiError(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } });
    expect(classifyGeminiError(e, null, "m").kind).toBe("auth");
  });

  it("unknown model -> model-unavailable", () => {
    const e = apiError(404, { error: { code: 404, status: "NOT_FOUND", message: "models/gemini-x is not found for API version v1beta" } });
    expect(classifyGeminiError(e, null, "gemini-x")).toMatchObject({ kind: "model-unavailable" });
  });

  it("429 -> transient with RetryInfo delay; header wins when present", () => {
    const e = apiError(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17s" }] } });
    expect(classifyGeminiError(e, null, "m")).toMatchObject({ kind: "transient", retryAfterMs: 17_000 });
    expect(classifyGeminiError(e, 3_000, "m")).toMatchObject({ kind: "transient", retryAfterMs: 3_000 });
  });

  it("5xx and network errors -> transient", () => {
    expect(classifyGeminiError(apiError(503, { error: { message: "overloaded" } }), null, "m").kind).toBe("transient");
    expect(classifyGeminiError(new TypeError("fetch failed"), null, "m").kind).toBe("transient");
  });

  it("merges streamed chunks: text, finish reason, usage", () => {
    const merged = mergeChunks([
      { text: '{"topic":', candidates: [{}] } as never,
      { text: '"x"}', candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 20 }, modelVersion: "gemini-x-001" } as never,
    ]);
    const response = interpretResponse(merged, "gemini-x", 0, 1);
    expect(response).toMatchObject({ text: '{"topic":"x"}', finishReason: "STOP", model: "gemini-x-001", usage: { promptTokens: 10, outputTokens: 5, totalTokens: 20 } });
    expect(() => interpretResponse(mergeChunks([{ promptFeedback: { blockReason: "SAFETY" } } as never]), "m", 0, 1)).toThrow(/blocked/);
  });

  it("safety blocks stop with a clear error", () => {
    expect(() => interpretResponse({ promptFeedback: { blockReason: "SAFETY" } } as never, "m", 0, 1)).toThrow(/blocked/);
    expect(() => interpretResponse({ candidates: [{ finishReason: "PROHIBITED_CONTENT" }] } as never, "m", 0, 1)).toThrow(ProviderError);
  });
});

describe("topic file", () => {
  it("parses the water-cycle example", async () => {
    const file = path.join(import.meta.dirname, "..", "examples", "water-cycle.md");
    const topic = parseTopicFile(await readFile(file, "utf8"), "examples/water-cycle.md");
    expect(topic.title).toBe("How the water cycle works");
    expect(topicSources(topic)[0]).toMatchObject({ id: "topic-notes", title: "Topic file: examples/water-cycle.md" });
  });
});
