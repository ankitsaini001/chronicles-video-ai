import { type Db, type Filter, ObjectId, type UpdateFilter } from "mongodb";
import { isTerminal, JOBS_COLLECTION, type JobDocument, type JobType } from "./jobs";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./plan-versions";
import {
  currentStepOf,
  displayStateOf,
  getOwnedProject,
  ProjectActionError,
  PROJECTS_COLLECTION,
  type Language,
  type ProjectDocument,
  type ProjectState,
  type ProjectStep,
  type VoiceGender,
} from "./projects";

// "My videos" (F21; docs/API.md C1, C4 rename, C5 archive; DATABASE.md §4.8, §6.6).
// - C1 lists ONLY the signed-in owner's projects, never archived ones, newest-updated first
//   (`updatedAt` desc, `_id` desc as the tie-breaker), in cursor pages (API.md §5). A tab is a
//   fixed group of states (LIBRARY_TABS). The cursor carries the tab, so an old cursor can't be
//   used with another tab.
// - C4 rename and C5 archive are single-document conditional updates (owner, stateVersion, no job
//   running), so another tab's change is never overwritten. Nothing is deleted.

/** API.md C1: which states each My videos tab shows. Archived projects are never listed. */
export const LIBRARY_TABS = {
  drafts: ["draft", "planning", "plan_failed", "storyboard_ready", "generating", "generate_failed"],
  ready: ["video_ready", "publish_failed"],
  scheduled: ["scheduled", "publishing"],
  published: ["published"],
} as const satisfies Record<string, readonly ProjectState[]>;

export type LibraryTab = keyof typeof LIBRARY_TABS;
export const LIBRARY_TAB_IDS = Object.keys(LIBRARY_TABS) as LibraryTab[];

export function isLibraryTab(value: unknown): value is LibraryTab {
  return typeof value === "string" && Object.hasOwn(LIBRARY_TABS, value);
}

/** The tab a project shows under (null for archived). */
export function libraryTabOf(state: ProjectState): LibraryTab | null {
  for (const tab of LIBRARY_TAB_IDS) if ((LIBRARY_TABS[tab] as readonly ProjectState[]).includes(state)) return tab;
  return null;
}

/**
 * API.md §11.3 `ProjectSummary` (one card). Two additive fields (F21): `stateVersion`, sent back
 * by the card's Rename (C4) and Archive (C5) so another tab's change is never overwritten; and
 * `storyboardApproved`, the storyboard on screen is the approved one, so the card can say
 * "Approved" instead of "Storyboard ready".
 */
export type ProjectSummaryResource = {
  id: string;
  title: string;
  language: Language;
  voiceGender: VoiceGender;
  state: ProjectState;
  currentStep: ProjectStep;
  thumbnailUrl: string | null;
  latestPost: null;
  activeJobType: JobType | null;
  stateVersion: number;
  storyboardApproved: boolean;
  createdAt: string;
  updatedAt: string;
};

export function toProjectSummary(doc: ProjectDocument, activeJobType: JobType | null): ProjectSummaryResource {
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    language: doc.language,
    voiceGender: doc.voiceGender,
    state: doc.state,
    currentStep: currentStepOf(displayStateOf(doc)),
    // Thumbnails arrive with videos (F23); posts with publishing (F30).
    thumbnailUrl: null,
    latestPost: null,
    activeJobType: doc.activeJobId ? activeJobType : null,
    stateVersion: doc.stateVersion,
    storyboardApproved: doc.currentPlanVersionId !== null && doc.approvedPlanVersionId?.equals(doc.currentPlanVersionId) === true,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export type LibraryPage = { items: ProjectSummaryResource[]; nextCursor: string | null };

const NOT_ARCHIVED = { $ne: "archived" as const };

/**
 * C1: one page of the owner's projects. `tab` null = every non-archived project. Throws
 * InvalidCursorError for a tampered cursor or one made for another tab.
 * `refreshJob` (F21 review): the stuck-job rule C3/C6 apply (lib/plan/jobs.ts refreshJob), run on
 * each card's active job. It only writes when a job is really stuck, so a healthy page costs no
 * extra query; if a job changed (e.g. a dead one became failed), the page is read once more, so
 * the card shows "Storyboard failed" instead of "Writing storyboard…" forever.
 */
export async function listProjects(
  db: Db,
  ownerId: string,
  page: { tab: LibraryTab | null; limit: number; cursor: string | null },
  refreshJob?: (job: JobDocument) => Promise<JobDocument>,
): Promise<LibraryPage> {
  if (!/^[0-9a-f]{24}$/.test(ownerId)) return { items: [], nextCursor: null };
  const tabKey = page.tab ?? "all";
  const filter: Filter<ProjectDocument> = {
    ownerId: new ObjectId(ownerId),
    state: page.tab ? { $in: [...LIBRARY_TABS[page.tab]] } : NOT_ARCHIVED,
  };
  if (page.cursor) {
    const { u, i, t } = decodeCursor(page.cursor, ["u", "i", "t"]);
    const after = typeof u === "string" ? new Date(u) : null;
    if (!after || Number.isNaN(after.getTime()) || after.toISOString() !== u || typeof i !== "string" || !/^[0-9a-f]{24}$/.test(i) || t !== tabKey) {
      throw new InvalidCursorError();
    }
    filter.$or = [{ updatedAt: { $lt: after } }, { updatedAt: after, _id: { $lt: new ObjectId(i) } }];
  }
  const docs = await db
    .collection<ProjectDocument>(PROJECTS_COLLECTION)
    .find(filter, { projection: { input: 0, lastError: 0 } })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(page.limit + 1)
    .toArray();
  const items = docs.slice(0, page.limit);
  const jobIds = items.flatMap((d) => (d.activeJobId ? [d.activeJobId] : []));
  // A creator has at most a couple of running jobs (concurrency limit), so this is a small read.
  const jobs = jobIds.length ? await db.collection<JobDocument>(JOBS_COLLECTION).find({ _id: { $in: jobIds }, ownerId: new ObjectId(ownerId) }).toArray() : [];
  if (refreshJob) {
    let changed = false;
    for (const job of jobs) {
      if (isTerminal(job.state)) continue;
      const fresh = await refreshJob(job);
      if (fresh.state !== job.state) changed = true;
    }
    if (changed) return listProjects(db, ownerId, page);
  }
  const typeOf = (id: ObjectId | null) => (id ? (jobs.find((j) => j._id.equals(id))?.type ?? null) : null);
  const last = items[items.length - 1];
  return {
    items: items.map((d) => toProjectSummary(d, typeOf(d.activeJobId))),
    nextCursor: docs.length > page.limit && last ? encodeCursor({ u: last.updatedAt.toISOString(), i: last._id.toHexString(), t: tabKey }) : null,
  };
}

/** Does the owner have any project in My videos (not archived)? Decides the first-visit page. */
export async function hasLibraryProjects(db: Db, ownerId: string): Promise<boolean> {
  if (!/^[0-9a-f]{24}$/.test(ownerId)) return false;
  const found = await db.collection<ProjectDocument>(PROJECTS_COLLECTION).findOne({ ownerId: new ObjectId(ownerId), state: NOT_ARCHIVED }, { projection: { _id: 1 } });
  return found !== null;
}

const notFound = () => new ProjectActionError("NOT_FOUND", "We couldn't find this project.");
const stale = (expected: number, current: number) =>
  new ProjectActionError("STALE_VERSION", "This project changed in another tab, refresh.", { expectedStateVersion: expected, currentStateVersion: current });

/**
 * One guarded change to one project: the owner's, the stateVersion the browser saw, no job
 * running, plus `check` (the action's own state rule). One conditional update, so it is
 * all-or-nothing; if the project changed between the read and the write, the reason is reported
 * from the current document and nothing is written.
 */
async function guardedUpdate(
  db: Db,
  input: { ownerId: string; projectId: string; expectedStateVersion: number },
  check: (project: ProjectDocument) => void,
  update: (project: ProjectDocument) => UpdateFilter<ProjectDocument>,
): Promise<ProjectDocument> {
  const verify = (project: ProjectDocument) => {
    if (project.state === "archived") throw new ProjectActionError("INVALID_STATE", "This video is archived.", { state: project.state });
    if (project.activeJobId) throw new ProjectActionError("JOB_ALREADY_RUNNING", "We're still working on this video. Please try again when this step finishes.");
    if (project.stateVersion !== input.expectedStateVersion) throw stale(input.expectedStateVersion, project.stateVersion);
    check(project);
  };
  const project = await getOwnedProject(db, input.ownerId, input.projectId);
  if (!project) throw notFound();
  verify(project);
  const updated = await db
    .collection<ProjectDocument>(PROJECTS_COLLECTION)
    .findOneAndUpdate({ _id: project._id, ownerId: project.ownerId, state: project.state, activeJobId: null, stateVersion: input.expectedStateVersion }, update(project), { returnDocument: "after" });
  if (updated) return updated;
  const current = await getOwnedProject(db, input.ownerId, input.projectId);
  if (!current) throw notFound();
  verify(current);
  throw stale(input.expectedStateVersion, current.stateVersion);
}

/**
 * C4 rename (API.md C4, F21): any state except archived, not while a job runs (a storyboard job
 * would otherwise replace the new title with the plan's topic when it finishes). Touches only the
 * title: no plans, no approvals, no limits counted. +1 stateVersion.
 */
export function renameProject(db: Db, input: { ownerId: string; projectId: string; title: string; expectedStateVersion: number; now?: Date }): Promise<ProjectDocument> {
  const now = input.now ?? new Date();
  return guardedUpdate(db, input, () => undefined, () => ({ $set: { title: input.title, titleSetByUser: true, updatedAt: now }, $inc: { stateVersion: 1 } }));
}

/**
 * C5 archive (API.md C5, DATABASE.md §6.6, F21): a soft delete. `state = archived`, `archivedAt`,
 * `stateBeforeArchive` kept, +1 stateVersion. Nothing is deleted (MongoDB or R2). Refused while a
 * job runs (409 JOB_ALREADY_RUNNING; there is no job cancel yet, E3) and while a post is being
 * published (409 INVALID_STATE). No posts exist yet: F30 MUST cancel a `scheduled` /
 * `publish_failed` post in the same transaction (DATABASE.md §7.2 #12).
 */
export function archiveProject(db: Db, input: { ownerId: string; projectId: string; expectedStateVersion: number; now?: Date }): Promise<ProjectDocument> {
  const now = input.now ?? new Date();
  return guardedUpdate(
    db,
    input,
    (project) => {
      if (project.state === "publishing") {
        throw new ProjectActionError("INVALID_STATE", "This video is being published right now. You can archive it in a few minutes.", { state: project.state });
      }
    },
    (project) => ({ $set: { state: "archived", stateBeforeArchive: project.state, archivedAt: now, updatedAt: now }, $inc: { stateVersion: 1 } }),
  );
}

/** API.md §7: `If-Match: "<stateVersion>"` (needed for body-less calls such as C5). Null if missing or malformed. */
export function parseIfMatch(value: string | null): number | null {
  const match = value === null ? null : /^\s*"([1-9]\d{0,8})"\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}
