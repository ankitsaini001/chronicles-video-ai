import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  API_RATE_LIMITS,
  CreateProjectBodySchema,
  currentStepOf,
  IDEA_LIMITS,
  projectTitle,
  titleFromIdea,
  toProjectResource,
  usageCounterPeriod,
  type ProjectDocument,
} from "@bytereel/db";

// F12: C2 body rules (API.md C2, §2), the title rule (DATABASE.md §4.8), the Project resource
// (API.md §11.3) and the projects/day counter period (DATABASE.md §4.14).

const base = { inputType: "topic", text: "How UPI payments work", language: "en", voiceGender: "female" } as const;
const issuesOf = (value: unknown) => {
  const r = CreateProjectBodySchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("C2 body (CreateProjectBodySchema)", () => {
  it("accepts a topic in each language and voice", () => {
    for (const language of ["en", "hi", "hinglish"]) for (const voiceGender of ["female", "male"]) expect(issuesOf({ ...base, language, voiceGender })).toEqual([]);
  });

  it("trims and NFC-normalizes the text before counting", () => {
    const r = CreateProjectBodySchema.safeParse({ ...base, text: "  \n café notes  \t" });
    expect(r.success && r.data.text).toBe("café notes");
  });

  it("empty or whitespace-only text is refused", () => {
    expect(issuesOf({ ...base, text: "" })).toEqual(["text: must be at least 3 characters"]);
    expect(issuesOf({ ...base, text: "   \n\t " })).toEqual(["text: must be at least 3 characters"]);
  });

  it("topic: 3–300 characters; notes: 20–5,000", () => {
    expect(IDEA_LIMITS).toEqual({ topic: { min: 3, max: 300 }, notes: { min: 20, max: 5000 }, brainstorm: { min: 3, max: 300 } });
    expect(issuesOf({ ...base, text: "abc" })).toEqual([]);
    expect(issuesOf({ ...base, text: "a".repeat(300) })).toEqual([]);
    expect(issuesOf({ ...base, text: "a".repeat(301) })).toEqual(["text: must be at most 300 characters"]);
    expect(issuesOf({ ...base, inputType: "notes", text: "a".repeat(5000) })).toEqual([]);
    expect(issuesOf({ ...base, inputType: "notes", text: "a".repeat(5001) })).toEqual(["text: must be at most 5000 characters"]);
    expect(issuesOf({ ...base, inputType: "notes", text: "too short" })).toEqual(["text: must be at least 20 characters"]);
  });

  it("5,000 characters are counted after trimming (spaces around don't count)", () => {
    expect(issuesOf({ ...base, inputType: "notes", text: `   ${"a".repeat(5000)}   ` })).toEqual([]);
  });

  it("is strict: unknown fields are refused (the client can't set owner, state or quota fields)", () => {
    const r = CreateProjectBodySchema.safeParse({ ...base, ownerId: "x", state: "published", planRequestCount: 0 });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues).toEqual([expect.objectContaining({ code: "unrecognized_keys", keys: ["ownerId", "state", "planRequestCount"] })]);
  });

  it("missing or wrong values name the field", () => {
    expect(issuesOf({})).toEqual([
      "inputType: must be one of topic, notes, brainstorm",
      "text: must be text",
      "language: must be one of en, hi, hinglish",
      "voiceGender: must be one of female, male",
    ]);
    expect(issuesOf({ ...base, text: 42 })).toEqual(["text: must be text"]);
    expect(issuesOf(null).length).toBe(1);
    expect(issuesOf([base]).length).toBe(1);
  });

  it("brainstormChoice only (and always) with inputType brainstorm", () => {
    const choice = { subject: "Indian monsoon", title: "Why the monsoon reaches Kerala first", hook: "Every June, Kerala gets wet before Delhi." };
    expect(issuesOf({ ...base, inputType: "brainstorm", brainstormChoice: choice })).toEqual([]);
    expect(issuesOf({ ...base, inputType: "brainstorm" })).toEqual(["brainstormChoice: is required when inputType is brainstorm"]);
    expect(issuesOf({ ...base, brainstormChoice: choice })).toEqual(["brainstormChoice: is only allowed when inputType is brainstorm"]);
    expect(issuesOf({ ...base, inputType: "brainstorm", brainstormChoice: { ...choice, extra: 1 } }).join()).toContain("Unrecognized");
  });
});

describe("titleFromIdea", () => {
  it("is the idea itself when short, with line breaks and extra spaces collapsed", () => {
    expect(titleFromIdea("How UPI\n\n  payments   work")).toBe("How UPI payments work");
  });

  it("cuts one very long word to 119 characters plus …", () => {
    expect(titleFromIdea("a".repeat(500))).toBe(`${"a".repeat(119)}…`);
  });

  it("never cuts an emoji (surrogate pair) in half", () => {
    const title = titleFromIdea(`${"a".repeat(118)}😀 and more`);
    expect(title).toBe(`${"a".repeat(118)}…`);
    expect(title.length).toBeLessThanOrEqual(120);
  });

  it("cuts a long idea at a word break, never mid-word, and ends with …", () => {
    const idea =
      "Why does the Monsoon arrive in Kerala first? Have you ever wondered why the monsoon rains hit Kerala way before they reach the rest of India?";
    const title = titleFromIdea(idea);
    expect(title).toBe("Why does the Monsoon arrive in Kerala first? Have you ever wondered why the monsoon rains hit Kerala way before they…");
    expect(title.length).toBeLessThanOrEqual(120);
  });
});

describe("projectTitle", () => {
  it("uses the picked brainstorm idea's own title", () => {
    expect(projectTitle({ text: "Why the monsoon reaches Kerala first. Every June…", brainstormChoice: { title: "Why the monsoon reaches Kerala first" } })).toBe(
      "Why the monsoon reaches Kerala first",
    );
  });

  it("falls back to the idea text without a brainstorm choice", () => {
    expect(projectTitle({ text: "How UPI payments work", brainstormChoice: null })).toBe("How UPI payments work");
  });

  it("keeps Hindi text as is", () => {
    expect(titleFromIdea("यूपीआई भुगतान कैसे काम करता है")).toBe("यूपीआई भुगतान कैसे काम करता है");
  });
});

describe("Project resource (API.md §11.3)", () => {
  const doc: ProjectDocument = {
    _id: new ObjectId("67330d5e9f1e4b2a7c0d2a10"),
    ownerId: new ObjectId("67330c1a9f1e4b2a7c0d1e01"),
    schemaVersion: 1,
    title: "How UPI payments work",
    language: "en",
    voiceGender: "female",
    input: { type: "topic", text: "How UPI payments work", brainstormChoice: null },
    state: "draft",
    currentPlanVersionId: null,
    approvedPlanVersionId: null,
    currentRenderId: null,
    activeJobId: null,
    stateVersion: 1,
    planRequestCount: 0,
    lastError: null,
    createdAt: new Date("2026-11-12T05:00:00.000Z"),
    updatedAt: new Date("2026-11-12T05:00:00.000Z"),
    archivedAt: null,
  };

  it("has exactly the documented fields, no ownerId, nulls present", () => {
    const r = toProjectResource(doc);
    expect(r).toEqual({
      id: "67330d5e9f1e4b2a7c0d2a10",
      title: "How UPI payments work",
      language: "en",
      voiceGender: "female",
      state: "draft",
      currentStep: "idea",
      thumbnailUrl: null,
      latestPost: null,
      activeJobType: null,
      input: { type: "topic", text: "How UPI payments work", brainstormChoice: null },
      stateVersion: 1,
      currentPlanVersionId: null,
      approvedPlanVersionId: null,
      currentRenderId: null,
      activeJobId: null,
      activeJob: null,
      lastError: null,
      allowedActions: ["rename", "archive"],
      archivedAt: null,
      createdAt: "2026-11-12T05:00:00.000Z",
      updatedAt: "2026-11-12T05:00:00.000Z",
    });
    expect(JSON.stringify(r)).not.toContain("ownerId");
    expect(JSON.stringify(r)).not.toContain("planRequestCount");
  });

  it("currentStep follows the state (API.md §11.3)", () => {
    expect(["draft", "planning", "plan_failed"].map((s) => currentStepOf(s as never))).toEqual(["idea", "idea", "idea"]);
    expect(currentStepOf("storyboard_ready")).toBe("storyboard");
    expect(["generating", "generate_failed", "video_ready"].map((s) => currentStepOf(s as never))).toEqual(["video", "video", "video"]);
    expect(["scheduled", "publishing", "published", "publish_failed"].map((s) => currentStepOf(s as never))).toEqual(["publish", "publish", "publish", "publish"]);
  });
});

describe("projects/day counter and C2 rate limit", () => {
  it("counts per day in the user's timezone and expires a week after the day ends", () => {
    // 20:00Z on the 13th is already the 14th in Kolkata (+5:30).
    const p = usageCounterPeriod("projects", "Asia/Kolkata", new Date("2026-11-13T20:00:00.000Z"));
    expect(p.period).toBe("2026-11-14");
    expect(p.resetsAt.toISOString()).toBe("2026-11-14T18:30:00.000Z");
    expect(p.expiresAt.toISOString()).toBe("2026-11-21T18:30:00.000Z");
    expect(usageCounterPeriod("projects", "UTC", new Date("2026-11-13T20:00:00.000Z")).period).toBe("2026-11-13");
    expect(usageCounterPeriod("voiceChars", "Asia/Kolkata", new Date("2026-11-13T20:00:00.000Z")).period).toBe("2026-11");
  });

  it("C2 is limited to 10 per hour per user (API.md §10.3)", () => {
    expect(API_RATE_LIMITS.createProjectPerUser).toEqual({ name: "create-project", limit: 10, windowSeconds: 3600 });
  });
});
