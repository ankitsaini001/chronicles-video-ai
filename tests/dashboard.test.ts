import { ObjectId, type Db } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  allowedActionsFor,
  API_RATE_LIMITS,
  displayStateOf,
  indexesForFeatures,
  InvalidCursorError,
  LIBRARY_TABS,
  libraryTabOf,
  listProjects,
  parseIfMatch,
  toProjectSummary,
  UpdateProjectBodySchema,
  type ProjectDocument,
  type ProjectState,
} from "@bytereel/db";
import { cardActions, cardStatus, projectHref, titleInitial, updatedLabel } from "../apps/web/lib/dashboard/cards";

// F21 My videos: tabs (API.md C1), the ProjectSummary card resource, C4 rename body, C5 If-Match,
// rename/archive in allowedActions, and the card's status, link, time and placeholder letter.

const NOW = new Date("2026-11-14T10:00:00.000Z");
const V1 = new ObjectId();

function projectDoc(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    _id: new ObjectId("67330d5e9f1e4b2a7c0d2a10"),
    ownerId: new ObjectId("67330c1a9f1e4b2a7c0d1e01"),
    schemaVersion: 1,
    title: "How UPI payments work",
    language: "en",
    voiceGender: "female",
    input: { type: "topic", text: "How UPI payments work", brainstormChoice: null },
    state: "storyboard_ready",
    currentPlanVersionId: V1,
    approvedPlanVersionId: null,
    currentRenderId: null,
    activeJobId: null,
    stateVersion: 4,
    planRequestCount: 1,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

const ALL_STATES: ProjectState[] = ["draft", "planning", "plan_failed", "storyboard_ready", "generating", "generate_failed", "video_ready", "scheduled", "publishing", "published", "publish_failed", "archived"];

describe("C1 tabs (API.md C1)", () => {
  it("every state except archived is in exactly one tab", () => {
    const listed = Object.values(LIBRARY_TABS).flat();
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(ALL_STATES.filter((s) => s !== "archived").sort());
    expect(libraryTabOf("archived")).toBeNull();
  });

  it("follows the documented mapping", () => {
    expect(LIBRARY_TABS.drafts).toEqual(["draft", "planning", "plan_failed", "storyboard_ready", "generating", "generate_failed"]);
    expect(LIBRARY_TABS.ready).toEqual(["video_ready", "publish_failed"]);
    expect(LIBRARY_TABS.scheduled).toEqual(["scheduled", "publishing"]);
    expect(LIBRARY_TABS.published).toEqual(["published"]);
  });

  it("a tampered cursor, or one made for another tab, is refused before the database is asked", async () => {
    const noDb = {} as Db; // any database call would throw a TypeError instead
    const owner = "67330c1a9f1e4b2a7c0d1e01";
    const cursorFor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const good = { u: NOW.toISOString(), i: "67330d5e9f1e4b2a7c0d2a10" };
    await expect(listProjects(noDb, owner, { tab: "ready", limit: 20, cursor: cursorFor({ ...good, t: "drafts" }) })).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(listProjects(noDb, owner, { tab: null, limit: 20, cursor: cursorFor({ ...good, t: "drafts" }) })).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(listProjects(noDb, owner, { tab: "drafts", limit: 20, cursor: cursorFor({ ...good, u: "yesterday", t: "drafts" }) })).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(listProjects(noDb, owner, { tab: "drafts", limit: 20, cursor: cursorFor({ ...good, i: "nope", t: "drafts" }) })).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(listProjects(noDb, owner, { tab: "drafts", limit: 20, cursor: cursorFor({ ...good, t: "drafts", x: 1 }) })).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(listProjects(noDb, owner, { tab: "drafts", limit: 20, cursor: "%%%" })).rejects.toBeInstanceOf(InvalidCursorError);
  });
});

describe("ProjectSummary (API.md §11.3, F21 additions)", () => {
  it("has exactly the documented fields, no ownerId or idea text", () => {
    const summary = toProjectSummary(projectDoc(), null);
    expect(Object.keys(summary).sort()).toEqual(
      ["activeJobType", "createdAt", "currentStep", "id", "language", "latestPost", "state", "stateVersion", "storyboardApproved", "thumbnailUrl", "title", "updatedAt", "voiceGender"].sort(),
    );
    expect(summary).toMatchObject({ id: "67330d5e9f1e4b2a7c0d2a10", state: "storyboard_ready", currentStep: "storyboard", stateVersion: 4, storyboardApproved: false, thumbnailUrl: null, latestPost: null });
    expect(JSON.stringify(summary)).not.toContain("ownerId");
  });

  it("storyboardApproved only when the version on screen is the approved one; activeJobType only with a job", () => {
    expect(toProjectSummary(projectDoc({ approvedPlanVersionId: V1 }), null).storyboardApproved).toBe(true);
    expect(toProjectSummary(projectDoc({ approvedPlanVersionId: new ObjectId() }), null).storyboardApproved).toBe(false);
    expect(toProjectSummary(projectDoc({ currentPlanVersionId: null }), null).storyboardApproved).toBe(false);
    expect(toProjectSummary(projectDoc(), "revise").activeJobType).toBeNull();
    expect(toProjectSummary(projectDoc({ activeJobId: new ObjectId() }), "revise").activeJobType).toBe("revise");
  });

  it("an archived project keeps the step it was on", () => {
    expect(displayStateOf({ state: "archived", stateBeforeArchive: "storyboard_ready" })).toBe("storyboard_ready");
    expect(displayStateOf({ state: "archived" })).toBe("draft");
    expect(toProjectSummary(projectDoc({ state: "archived", stateBeforeArchive: "storyboard_ready" }), null).currentStep).toBe("storyboard");
  });
});

describe("rename and archive (API.md C4, C5)", () => {
  it("allowedActions: rename first and archive last; nothing while a job runs or once archived; no archive while publishing", () => {
    expect(allowedActionsFor(projectDoc({ state: "draft", currentPlanVersionId: null }), null)).toEqual(["rename", "archive"]);
    expect(allowedActionsFor(projectDoc({ activeJobId: new ObjectId() }), null)).toEqual([]);
    expect(allowedActionsFor(projectDoc({ state: "archived", stateBeforeArchive: "storyboard_ready" }), null)).toEqual([]);
    expect(allowedActionsFor(projectDoc({ state: "publishing" }), null)).toEqual(["rename"]);
  });

  it("C4 title: trimmed, one line, 1–120 characters, strict", () => {
    const parse = (body: unknown) => UpdateProjectBodySchema.safeParse(body);
    expect(parse({ title: "  UPI in\n 2 seconds ", expectedStateVersion: 4 })).toMatchObject({ success: true, data: { title: "UPI in 2 seconds" } });
    expect(parse({ title: "​UPI‮", expectedStateVersion: 4 })).toMatchObject({ success: true, data: { title: "UPI" } });
    expect(parse({ title: "   ", expectedStateVersion: 4 }).success).toBe(false);
    expect(parse({ title: "x".repeat(120), expectedStateVersion: 4 }).success).toBe(true);
    expect(parse({ title: "x".repeat(121), expectedStateVersion: 4 }).success).toBe(false);
    expect(parse({ title: "New", expectedStateVersion: 4, language: "hi" }).success).toBe(false);
    expect(parse({ title: "New" }).success).toBe(false);
    expect(parse({ title: 42, expectedStateVersion: 4 }).success).toBe(false);
  });

  it("C5 If-Match: a quoted whole number only", () => {
    expect(parseIfMatch('"9"')).toBe(9);
    expect(parseIfMatch(' "12" ')).toBe(12);
    expect(parseIfMatch(null)).toBeNull();
    expect(parseIfMatch("9")).toBeNull();
    expect(parseIfMatch('"0"')).toBeNull();
    expect(parseIfMatch('W/"9"')).toBeNull();
    expect(parseIfMatch('"9", "10"')).toBeNull();
  });

  it("rate limit and index from the docs", () => {
    expect(API_RATE_LIMITS.editProjectPerUser).toMatchObject({ limit: 60, windowSeconds: 60 });
    expect(indexesForFeatures(["F21"]).map((i) => `${i.collection}.${i.name} ${JSON.stringify(i.keys)}`)).toEqual(['projects.ownerId_updatedAt_id {"ownerId":1,"updatedAt":-1,"_id":-1}']);
  });
});

describe("card text (lib/dashboard/cards.ts)", () => {
  const card = (state: ProjectState, extra: { activeJobType?: "plan" | "revise" | null; storyboardApproved?: boolean } = {}) =>
    cardStatus({ state, activeJobType: extra.activeJobType ?? null, storyboardApproved: extra.storyboardApproved ?? false });

  it("a human status for every state", () => {
    expect(card("planning")).toEqual({ label: "Writing storyboard…", tone: "progress" });
    expect(card("plan_failed")).toEqual({ label: "Storyboard failed", tone: "danger" });
    expect(card("storyboard_ready")).toEqual({ label: "Storyboard ready", tone: "warning" });
    expect(card("storyboard_ready", { storyboardApproved: true })).toEqual({ label: "Approved", tone: "success" });
    expect(card("storyboard_ready", { activeJobType: "revise" }).label).toBe("Updating storyboard…");
    expect(card("draft").label).toBe("Idea saved");
    for (const state of ALL_STATES) expect(card(state).label.length).toBeGreaterThan(0);
  });

  it("links to the right step", () => {
    expect(projectHref({ id: "abc", state: "storyboard_ready" })).toBe("/projects/abc/storyboard");
    expect(projectHref({ id: "abc", state: "planning" })).toBe("/projects/abc");
    expect(projectHref({ id: "abc", state: "plan_failed" })).toBe("/projects/abc");
  });

  it("the ⋯ menu follows the server rule", () => {
    expect(cardActions({ state: "storyboard_ready", activeJobType: null })).toEqual({ rename: true, archive: true });
    expect(cardActions({ state: "planning", activeJobType: "plan" })).toEqual({ rename: false, archive: false });
    expect(cardActions({ state: "publishing", activeJobType: null })).toEqual({ rename: true, archive: false });
  });

  it("relative updated time, then the date in the user's timezone", () => {
    const now = "2026-11-14T10:00:00.000Z";
    const ago = (ms: number) => new Date(Date.parse(now) - ms).toISOString();
    expect(updatedLabel(ago(20_000), now, "Asia/Kolkata")).toBe("Updated just now");
    expect(updatedLabel(ago(-5_000), now, "Asia/Kolkata")).toBe("Updated just now");
    expect(updatedLabel(ago(10 * 60_000), now, "Asia/Kolkata")).toBe("Updated 10 min ago");
    expect(updatedLabel(ago(60 * 60_000), now, "Asia/Kolkata")).toBe("Updated 1 hour ago");
    expect(updatedLabel(ago(5 * 3_600_000), now, "Asia/Kolkata")).toBe("Updated 5 hours ago");
    expect(updatedLabel(ago(30 * 3_600_000), now, "Asia/Kolkata")).toBe("Updated yesterday");
    expect(updatedLabel(ago(3 * 86_400_000), now, "Asia/Kolkata")).toBe("Updated 3 days ago");
    expect(updatedLabel("2026-11-01T20:00:00.000Z", now, "Asia/Kolkata")).toBe("Updated 2 Nov");
    expect(updatedLabel("2025-11-01T20:00:00.000Z", now, "Asia/Kolkata")).toBe("Updated 2 Nov 2025");
  });

  it("placeholder letter: the first character with its marks (same on the server and in the browser)", () => {
    expect(titleInitial("how UPI works")).toBe("H");
    expect(titleInitial("  बचत खाता")).toBe("ब");
    expect(titleInitial("की बात")).toBe("की");
    expect(titleInitial("क्या है")).toBe("क्");
    expect(titleInitial("")).toBe("?");
  });
});
