import {
  allowedActionsFor,
  createProject,
  editProjectIdea,
  ENABLED_LANGUAGES,
  enabledLanguageOr,
  isLanguageEnabled,
  LANGUAGES,
  languageUnavailableMessage,
  newPlanJob,
  ProjectActionError,
  requestRevision,
  reservePlanRequest,
  retryPlanJob,
  retryReviseJob,
  startPlanAttempt,
  startReviseAttempt,
  type JobDocument,
  type ProjectDocument,
} from "@bytereel/db";
import type { PlannerProvider } from "@bytereel/pipeline/brainstorm";
import { type Db, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../apps/web/lib/auth/session";
import { ApiProblem } from "../apps/web/lib/api/v1";
import { runBrainstorm, type BrainstormDeps } from "../apps/web/lib/brainstorm/handler";
import { toApiProblem } from "../apps/web/lib/plan/api";

// The language switch (packages/db/src/languages.ts, founder 2026-11-14): only English is on.
// Hindi/Hinglish are hidden, not removed. Every action that costs AI (C2, C7, D5, E2) refuses a
// switched-off language with 422 LANGUAGE_UNAVAILABLE BEFORE counting anything or calling a
// provider; existing Hindi/Hinglish projects lose only their AI buttons.

const OWNER = new ObjectId("67330c1a9f1e4b2a7c0d1e01");
const PROJECT = new ObjectId("67330d5e9f1e4b2a7c0d2a10");
const VERSION = new ObjectId("67330d5e9f1e4b2a7c0d2b20");
const NOW = new Date("2026-11-15T05:00:00.000Z");

function projectDoc(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    _id: PROJECT,
    ownerId: OWNER,
    schemaVersion: 1,
    title: "बचत खाता बनाम FD",
    language: "hi",
    voiceGender: "female",
    input: { type: "topic", text: "बचत खाता बनाम FD", brainstormChoice: null },
    state: "storyboard_ready",
    currentPlanVersionId: VERSION,
    approvedPlanVersionId: null,
    currentRenderId: null,
    activeJobId: null,
    stateVersion: 3,
    planRequestCount: 1,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

/** A failed, retryable job of the given type for PROJECT. */
function failedJob(project: ProjectDocument, type: "plan" | "revise"): JobDocument {
  const job = newPlanJob({ ownerId: OWNER, projectId: PROJECT, project, now: NOW });
  return { ...job, type, state: "failed", error: { code: "PROVIDER_BUSY", message: "", retryable: true }, inputRef: { ...job.inputRef, planVersionId: VERSION } } as JobDocument;
}

/**
 * A database that answers reads with the given documents and records every call. Any write throws,
 * so a test also fails if the refusal comes too late.
 */
function fakeDb(docs: { project?: ProjectDocument | null; job?: JobDocument | null } = {}) {
  const calls: string[] = [];
  const collection = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async () => {
          calls.push(`${name}.${method}`);
          if (method !== "findOne") throw new Error(`unexpected ${name}.${method}`);
          return name === "projects" ? (docs.project ?? null) : name === "jobs" ? (docs.job ?? null) : null;
        },
      },
    );
  const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: async () => undefined };
  const db = { client: { startSession: () => session }, collection } as unknown as Db;
  return { db, calls };
}

/** A database that records ANY access at all. */
function untouchableDb() {
  const touched: string[] = [];
  const db = new Proxy({}, { get: (_t, prop) => void touched.push(String(prop)) }) as unknown as Db;
  return { db, touched };
}

async function refusal(promise: Promise<unknown>): Promise<ProjectActionError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProjectActionError);
  return error as ProjectActionError;
}

describe("the switch (packages/db/src/languages.ts)", () => {
  it("only English is on; Hindi and Hinglish stay known languages (hidden, not removed)", () => {
    expect(ENABLED_LANGUAGES).toEqual(["en"]);
    expect(LANGUAGES).toEqual(["en", "hi", "hinglish"]);
    expect(LANGUAGES.map(isLanguageEnabled)).toEqual([true, false, false]);
    expect(isLanguageEnabled("fr")).toBe(false);
  });

  it("an old Hindi account default falls back to English", () => {
    expect(enabledLanguageOr("hi")).toBe("en");
    expect(enabledLanguageOr("hinglish")).toBe("en");
    expect(enabledLanguageOr("en")).toBe("en");
  });

  it("the message lists the enabled languages", () => {
    expect(languageUnavailableMessage()).toBe("Only English is available right now.");
    expect(languageUnavailableMessage(["en", "hi"])).toBe("Only English and Hindi are available right now.");
    expect(languageUnavailableMessage(["en", "hi", "hinglish"])).toBe("Only English, Hindi and Hinglish are available right now.");
  });

  it("maps to 422 LANGUAGE_UNAVAILABLE (API.md §4.2)", () => {
    let problem: unknown;
    try {
      toApiProblem(new ProjectActionError("LANGUAGE_UNAVAILABLE", languageUnavailableMessage(), { language: "hi" }));
    } catch (e) {
      problem = e;
    }
    expect(problem).toBeInstanceOf(ApiProblem);
    expect(problem).toMatchObject({ status: 422, code: "LANGUAGE_UNAVAILABLE", message: "Only English is available right now.", details: { language: "hi" } });
  });
});

describe("C2 create project", () => {
  const body = { inputType: "topic", text: "बचत खाता बनाम FD", language: "hi", voiceGender: "female" } as const;

  it("refuses Hindi and Hinglish before touching the database: nothing counted or saved, no job", async () => {
    for (const language of ["hi", "hinglish"] as const) {
      const { db, touched } = untouchableDb();
      const error = await refusal(createProject(db, { ownerId: OWNER.toHexString(), timezone: "Asia/Kolkata", body: { ...body, language }, now: NOW }));
      expect(error.code).toBe("LANGUAGE_UNAVAILABLE");
      expect(error.message).toBe("Only English is available right now.");
      expect(touched).toEqual([]);
    }
  });
});

describe("C7 brainstorm", () => {
  const user: SessionUser = {
    id: OWNER.toHexString(),
    name: "Test Creator",
    email: "creator@example.in",
    role: "creator",
    timezone: "Asia/Kolkata",
    defaultLanguage: "hi",
    defaultVoiceGender: "female",
    createdAt: NOW.toISOString(),
  };

  it("refuses Hindi and Hinglish: 422, no daily count, no provider set-up or call, no usage log", async () => {
    const generate = vi.fn();
    const deps: BrainstormDeps = {
      provider: vi.fn(() => ({ ok: true as const, provider: { name: "gemini", model: "m", generate } as unknown as PlannerProvider, fake: false })),
      countToday: vi.fn(async () => ({ ok: true as const, used: 1 })),
      reserveUsage: vi.fn(async () => "u"),
      finishUsage: vi.fn(async () => undefined),
    };
    for (const language of ["hi", "hinglish"] as const) {
      const error = await runBrainstorm({ user, body: { subject: "Indian monsoon", language }, requestId: "req_TEST" }, deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiProblem);
      expect(error).toMatchObject({ status: 422, code: "LANGUAGE_UNAVAILABLE", message: "Only English is available right now." });
    }
    expect(deps.provider).not.toHaveBeenCalled();
    expect(deps.countToday).not.toHaveBeenCalled();
    expect(deps.reserveUsage).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("existing Hindi/Hinglish projects", () => {
  it("D5 revision request is refused after reading the project: no revision, no job, nothing written", async () => {
    const { db, calls } = fakeDb({ project: projectDoc() });
    const error = await refusal(
      requestRevision(db, {
        ownerId: OWNER.toHexString(),
        projectId: PROJECT.toHexString(),
        body: { stage: "storyboard", scope: "project", message: "Make it shorter", basePlanVersionId: VERSION.toHexString(), expectedStateVersion: 3 } as never,
        respond: () => ({ status: 202, body: {} }),
        now: NOW,
      }),
    );
    expect(error.code).toBe("LANGUAGE_UNAVAILABLE");
    expect(calls).toEqual(["projects.findOne"]);
  });

  it("E2 Try again on a failed storyboard job is refused: job not re-queued, nothing counted", async () => {
    const project = projectDoc({ language: "hinglish", state: "plan_failed", currentPlanVersionId: null });
    const { db, calls } = fakeDb({ project, job: failedJob(project, "plan") });
    const error = await refusal(retryPlanJob(db, { ownerId: OWNER.toHexString(), jobId: PROJECT.toHexString(), respond: () => ({ status: 202, body: {} }), now: NOW }));
    expect(error.code).toBe("LANGUAGE_UNAVAILABLE");
    expect(calls).toEqual(["jobs.findOne", "projects.findOne"]);
  });

  it("E2 Try again on a failed change request is refused the same way", async () => {
    const project = projectDoc();
    const { db, calls } = fakeDb({ project, job: failedJob(project, "revise") });
    const error = await refusal(retryReviseJob(db, { ownerId: OWNER.toHexString(), jobId: PROJECT.toHexString(), respond: () => ({ status: 202, body: {} }), now: NOW }));
    expect(error.code).toBe("LANGUAGE_UNAVAILABLE");
    expect(calls).toEqual(["jobs.findOne", "projects.findOne"]);
  });

  it("allowedActions drop the AI buttons (change request, Try again, Edit idea); free actions stay", () => {
    const revise = failedJob(projectDoc(), "revise");
    const plan = failedJob(projectDoc({ state: "plan_failed" }), "plan");
    const english = (o: Partial<ProjectDocument>) => projectDoc({ language: "en", ...o });
    // English keeps everything.
    expect(allowedActionsFor(english({}), null, revise)).toEqual(["rename", "edit_storyboard", "request_revision", "retry_job", "approve_storyboard", "archive"]);
    expect(allowedActionsFor(english({ state: "plan_failed", currentPlanVersionId: null }), plan)).toEqual(["rename", "edit_idea", "retry_job", "archive"]);
    // Hindi / Hinglish: viewable, narration edit/undo, rename, archive and approve remain.
    for (const language of ["hi", "hinglish"] as const) {
      expect(allowedActionsFor(projectDoc({ language }), null, revise)).toEqual(["rename", "edit_storyboard", "approve_storyboard", "archive"]);
      expect(allowedActionsFor(projectDoc({ language, state: "plan_failed", currentPlanVersionId: null }), plan)).toEqual(["rename", "archive"]);
    }
  });
});

/**
 * A database for the job steps: reads answer with the given documents; `updateOne` is recorded with
 * its filter and update (and matches); anything else (e.g. the start step's findOneAndUpdate that
 * would make the job `running`) throws.
 */
function recordingDb(docs: { project: ProjectDocument; job: JobDocument }) {
  const writes: { collection: string; filter: Record<string, unknown>; update: Record<string, any> }[] = [];
  const reads: string[] = [];
  const collection = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (filter: Record<string, unknown>, update: Record<string, any>) => {
          if (method === "findOne") {
            reads.push(name);
            return name === "projects" ? docs.project : name === "jobs" ? docs.job : null;
          }
          if (method === "updateOne") {
            writes.push({ collection: name, filter, update });
            return { matchedCount: 1, modifiedCount: 1 };
          }
          throw new Error(`unexpected ${name}.${method}`);
        },
      },
    );
  const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: async () => undefined };
  return { db: { client: { startSession: () => session }, collection } as unknown as Db, writes, reads };
}

describe("workers: a job of a switched-off language never reaches Gemini (queued before the switch, stuck-job re-send, Inngest retry)", () => {
  it("plan job start step: the job fails with LANGUAGE_UNAVAILABLE (not retryable), project → plan_failed, nothing to run", async () => {
    const project = projectDoc({ state: "planning", currentPlanVersionId: null });
    const job = { ...newPlanJob({ ownerId: OWNER, projectId: PROJECT, project, now: NOW }), state: "queued" } as JobDocument;
    project.activeJobId = job._id;
    const { db, writes } = recordingDb({ project, job });
    expect(await startPlanAttempt(db, { jobId: job._id.toHexString(), attempt: 1, now: NOW })).toBeNull();
    const jobWrite = writes.find((w) => w.collection === "jobs");
    const projectWrite = writes.find((w) => w.collection === "projects");
    expect(jobWrite?.update.$set).toMatchObject({ state: "failed", error: { code: "LANGUAGE_UNAVAILABLE", message: "Only English is available right now.", retryable: false } });
    expect(projectWrite?.update.$set).toMatchObject({ state: "plan_failed", activeJobId: null, lastError: { code: "LANGUAGE_UNAVAILABLE" } });
    expect(projectWrite?.update.$inc).toEqual({ stateVersion: 1 }); // no planRequestCount
  });

  it("revise job start step: the job and the revision fail, the storyboard and state stay, activeJobId cleared", async () => {
    const project = projectDoc();
    const base = newPlanJob({ ownerId: OWNER, projectId: PROJECT, project, now: NOW });
    const revisionId = new ObjectId();
    const job = { ...base, type: "revise", state: "queued", inputRef: { ...base.inputRef, planVersionId: VERSION, revisionId } } as JobDocument;
    project.activeJobId = job._id;
    const { db, writes } = recordingDb({ project, job });
    expect(await startReviseAttempt(db, { jobId: job._id.toHexString(), attempt: 1, now: NOW })).toBeNull();
    expect(writes.map((w) => w.collection)).toEqual(["jobs", "revisions", "projects"]);
    expect(writes[0]!.update.$set).toMatchObject({ state: "failed", error: { code: "LANGUAGE_UNAVAILABLE", retryable: false } });
    expect(writes[1]!.update.$set).toMatchObject({ status: "failed" });
    expect(writes[2]!.update.$set).toEqual({ activeJobId: null, updatedAt: NOW });
  });

  it("reservePlanRequest: 'language' before anything is counted (no write at all)", async () => {
    const project = projectDoc({ state: "planning" });
    const job = newPlanJob({ ownerId: OWNER, projectId: PROJECT, project, now: NOW });
    const running = { ...job, state: "running", planner: { attempt: 1, inputHash: job.inputHash, planVersionId: VERSION, requests: 0, answers: [] } } as JobDocument;
    const { db, writes, reads } = recordingDb({ project, job: running });
    expect(await reservePlanRequest(db, { jobId: job._id, attempt: 1, maxRequests: 4, message: "Writing…", percent: 10, now: NOW })).toBe("language");
    expect(reads).toEqual(["jobs", "projects"]);
    expect(writes).toEqual([]);
    // English: counted as before.
    const english = recordingDb({ project: projectDoc({ language: "en", state: "planning" }), job: running });
    expect(await reservePlanRequest(english.db, { jobId: job._id, attempt: 1, maxRequests: 4, message: "Writing…", percent: 10, now: NOW })).toBe("ok");
    expect(english.writes.map((w) => w.collection)).toEqual(["projects", "jobs"]);
  });

  it("C4 Edit idea is refused (422) and saves nothing; it would only lead to a refused Try again", async () => {
    const { db, calls } = fakeDb({ project: projectDoc({ state: "plan_failed", currentPlanVersionId: null }) });
    const error = await refusal(editProjectIdea(db, { ownerId: OWNER.toHexString(), projectId: PROJECT.toHexString(), body: { text: "Savings account vs FD", expectedStateVersion: 3 }, now: NOW }));
    expect(error.code).toBe("LANGUAGE_UNAVAILABLE");
    expect(calls).toEqual(["projects.findOne"]);
  });
});
