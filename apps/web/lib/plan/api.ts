import { isTerminal, POLL_AFTER_MS, ProjectActionError, toJobResource, toProjectResource, currentStepOf, type JobResource, type ProjectResource } from "@bytereel/db";
import { getInngest } from "../../inngest/client";
import { ApiProblem, type ApiErrorCode } from "../api/v1";
import { plannerProviderFromEnv } from "./provider";
import type { ProjectWithJobs } from "./jobs";

// Shared pieces of the F15 endpoints (C2, C4, C6, E1, E2): error mapping, the "are background jobs
// set up?" check and the ProjectStatus resource (API.md §11.3).

const STATUS: Record<ProjectActionError["code"], number> = {
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  STALE_VERSION: 409,
  JOB_ALREADY_RUNNING: 409,
  QUOTA_EXCEEDED: 429,
  INVALID_INPUT: 400,
  APPROVAL_STALE: 409,
  PLAN_INVALID: 422,
};

/** A refused project/job action → its documented API error (API.md §4.2). Anything else is rethrown. */
export function toApiProblem(error: unknown): never {
  if (error instanceof ProjectActionError) throw new ApiProblem(STATUS[error.code], error.code as ApiErrorCode, error.message, error.details);
  throw error;
}

/**
 * Before saving anything that starts a storyboard job (C2, E2): the AI planner and Inngest must be
 * set up, else nothing is saved or counted and the answer is 500 (the reason goes to the server log).
 */
export function assertPlanJobsReady(env: NodeJS.ProcessEnv = process.env): void {
  const inngest = getInngest(env);
  if (!inngest.ok) throw new Error(`Background jobs are not set up: ${inngest.problem}`);
  const planner = plannerProviderFromEnv(env);
  if (!planner.ok) throw new Error(`The storyboard planner is not set up: ${planner.problem}`);
}

export type ProjectStatusResource = {
  projectId: string;
  state: ProjectResource["state"];
  currentStep: ProjectResource["currentStep"];
  stateVersion: number;
  currentPlanVersionId: string | null;
  currentRenderId: string | null;
  activeJob: JobResource | null;
  lastError: ProjectResource["lastError"];
  latestPost: null;
  allowedActions: string[];
  updatedAt: string;
  pollAfterMs: number | null;
};

/** C3 `Project` (API.md §11.3) with its active job embedded. */
export function toProjectResourceOf({ project, activeJob, latestPlanJob, latestReviseJob }: ProjectWithJobs): ProjectResource {
  const active = activeJob && project.activeJobId?.equals(activeJob._id) ? activeJob : null;
  return toProjectResource(project, { activeJob: active, latestPlanJob, latestReviseJob: latestReviseJob ?? null });
}

/** C6 `ProjectStatus` (API.md §11.3): polling stops when `pollAfterMs` is null (no active job). */
export function toProjectStatus({ project, activeJob, latestPlanJob, latestReviseJob }: ProjectWithJobs): ProjectStatusResource {
  const active = activeJob && project.activeJobId?.equals(activeJob._id) ? activeJob : null;
  const resource = toProjectResource(project, { activeJob: active, latestPlanJob, latestReviseJob: latestReviseJob ?? null });
  return {
    projectId: resource.id,
    state: project.state,
    currentStep: currentStepOf(project.state),
    stateVersion: project.stateVersion,
    currentPlanVersionId: resource.currentPlanVersionId,
    currentRenderId: resource.currentRenderId,
    activeJob: active ? toJobResource(active) : null,
    lastError: resource.lastError,
    latestPost: null,
    allowedActions: resource.allowedActions,
    updatedAt: resource.updatedAt,
    pollAfterMs: active && !isTerminal(active.state) ? POLL_AFTER_MS : project.activeJobId ? POLL_AFTER_MS : null,
  };
}
